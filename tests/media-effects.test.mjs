import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MediaEffects } from '../apps/desktop/runtime/media-effects.mjs';
import { PcmMixer, VoiceOutput, createDiscordAudioResource } from '../apps/desktop/runtime/voice-output.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { EQ_PRESETS, COMPRESSOR_PRESETS } from '../apps/desktop/core/media-effects-settings.mjs';
import { Store } from '../apps/desktop/core/store.mjs';
import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import OpusScript from 'opusscript';

function tone(frequency = 1000, amplitude = .1, frames = 50, rightRatio = 1) {
  const pcm = Buffer.alloc(frames * 3840);
  for (let i = 0; i < frames * 960; i++) {
    const sample = Math.round(32768 * amplitude * Math.sin(2 * Math.PI * frequency * i / 48000));
    pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(Math.round(sample * rightRatio), i * 4 + 2);
  }
  return pcm;
}
function processor(patch) { const effects = new MediaEffects(), { media } = normalizeConfig({ media: patch }); effects.configure(media.equalizer, media.compressor); return effects; }
function rms(samples, start = 0) { let sum = 0; for (let i = start; i < samples.length; i++) sum += samples[i] ** 2; return Math.sqrt(sum / (samples.length - start)); }
const inputSamples = pcm => Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));

test('existing configurations bypass effects; custom values and all presets persist across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-effects-'));
  try {
    const store = new Store(dir); assert.equal(store.config.media.equalizer.enabled, false); assert.equal(store.config.media.compressor.enabled, false);
    assert.equal(processor().process(tone()), null);
    const patch = { equalizer: { enabled: true, preset: 'custom', gains: [-3, 1, 4, -2, 0], preampDb: -5 }, compressor: { enabled: true, preset: 'custom', thresholdDb: -22, ratio: 3.5, kneeDb: 7, attackMs: 12, releaseMs: 230, makeupDb: 3 } };
    store.updateConfig({ media: patch }); assert.deepEqual(new Store(dir).config.media.equalizer, patch.equalizer); assert.deepEqual(new Store(dir).config.media.compressor, patch.compressor);
    for (const preset of Object.keys(EQ_PRESETS)) assert.deepEqual(normalizeConfig({ media: { equalizer: { preset } } }).media.equalizer.gains, EQ_PRESETS[preset].gains);
    for (const preset of Object.keys(COMPRESSOR_PRESETS)) assert.equal(normalizeConfig({ media: { compressor: { preset } } }).media.compressor.ratio, COMPRESSOR_PRESETS[preset].ratio);
    for (const equalizer of [{ preset: 'unknown' }, { enabled: 'yes' }, { gains: [0] }, { preset: 'custom', gains: [0, 0, Infinity, 0, 0] }]) assert.throws(() => normalizeConfig({ media: { equalizer } }));
    for (const compressor of [{ ratio: 21 }, { attackMs: 0 }, { releaseMs: 1001 }, { thresholdDb: NaN }, { enabled: 1 }]) assert.throws(() => normalizeConfig({ media: { compressor } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('each EQ band produces the selected gain at its centre frequency without altering stereo balance', () => {
  [100, 300, 1000, 3000, 8000].forEach((frequency, band) => {
    const gains = [0, 0, 0, 0, 0]; gains[band] = 6;
    const pcm = tone(frequency, .1, 50, .25), input = inputSamples(pcm), out = processor({ equalizer: { enabled: true, preset: 'custom', gains } }).process(pcm);
    const gainDb = 20 * Math.log10(rms(out, 24000) / rms(input, 24000)); assert.ok(Math.abs(gainDb - 6) < .1, `${frequency} Hz: ${gainDb} dB`);
    for (let i = 24000; i < out.length; i += 2) assert.ok(Math.abs(out[i + 1] - out[i] * .25) < 3);
  });
});
test('compressor reduces loud dynamics, keeps quiet audio and uses a linked stereo envelope', () => {
  const patch = { compressor: { enabled: true, preset: 'custom', thresholdDb: -18, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 100, makeupDb: 0 } };
  const loud = tone(1000, .8, 50, .25), out = processor(patch).process(loud);
  assert.ok(rms(out, 48000) < rms(inputSamples(loud), 48000) * .4);
  for (let i = 48000; i < out.length; i += 2) assert.ok(Math.abs(out[i + 1] - out[i] * .25) < 1);
  const quiet = tone(1000, .001); assert.ok(Math.abs(rms(processor(patch).process(quiet)) - rms(inputSamples(quiet))) < .01);
  assert.ok(processor(patch).process(Buffer.alloc(3840)).every(v => v === 0));
});
test('filter/compressor history survives chunks and identical settings; clear resets state; boosts stay finite', () => {
  const patch = { equalizer: { enabled: true, preset: 'music' }, compressor: { enabled: true, preset: 'level' } }, pcm = tone(300, .8), { media } = normalizeConfig({ media: patch });
  const full = processor(patch).process(pcm), effects = processor(patch), chunks = [];
  for (let i = 0; i < pcm.length; i += 3840) { effects.configure(media.equalizer, media.compressor); chunks.push(...effects.process(pcm.subarray(i, i + 3840))); }
  assert.deepEqual(chunks, Array.from(full)); effects.reset(); assert.deepEqual(Array.from(effects.process(pcm)), Array.from(full));
  const boost = processor({ equalizer: { enabled: true, preset: 'custom', gains: [12, 12, 12, 12, 12], preampDb: 6 }, compressor: { enabled: true, preset: 'custom', makeupDb: 12 } }).process(tone(1000, .95));
  assert.ok(boost.every(v => Number.isFinite(v) && Math.abs(v) <= 32768));
});
test('mixer applies effects before media ducking/fades and background fade; speech bypasses them', async t => {
  const { media } = normalizeConfig({ media: { equalizer: { enabled: true, preset: 'clarity' }, compressor: { enabled: true, preset: 'level' } } });
  const make = () => { const m = new PcmMixer(); m.configureEffects(media); m.mediaVolume = 1; t.after(() => m.destroy()); return m; };
  const normal = make(), faded = make(), ducked = make(), background = make(), speech = make(), pcm = tone(1000, .1, 4);
  normal.addMedia(pcm); const expected = normal.takeFrame(1000);
  faded.addMedia(pcm); faded.mediaGain.fade(.25, 0, 1000); const fadedFrame = faded.takeFrame(1000);
  ducked.ducking = .2; ducked.addMedia(pcm); const done = ducked.addSpeech(Buffer.alloc(3840), 1); const duckedFrame = ducked.takeFrame(1000); await done;
  background.backgroundVolume = .5; background.backgroundGain.fade(.5, 0, 1000); background.addBackground(pcm); const bgFrame = background.takeFrame(1000);
  for (let i = 0; i < expected.length; i += 2) {
    assert.ok(Math.abs(fadedFrame.readInt16LE(i) - expected.readInt16LE(i) * .25) < 1);
    assert.ok(Math.abs(duckedFrame.readInt16LE(i) - expected.readInt16LE(i) * .2) < 1);
    assert.ok(Math.abs(bgFrame.readInt16LE(i) - expected.readInt16LE(i) * .25) < 1);
  }
  const speechPcm = tone(440, .1, 1), spoken = speech.addSpeech(speechPcm, 1); assert.deepEqual(speech.takeFrame(), speechPcm); await spoken;
  background.clearBackground(); assert.deepEqual(background.backgroundEffects.process(pcm), processor({ equalizer: media.equalizer, compressor: media.compressor }).process(pcm));
});
test('saving updates all active guilds without reconnecting or resetting unchanged effects', () => {
  let config = normalizeConfig(); const output = new VoiceOutput(() => null, () => config, () => {}), mixers = [new PcmMixer(), new PcmMixer()];
  try {
    mixers.forEach((mixer, i) => output.connections.set(String(i), { mixer })); output.updateSettings(); assert.ok(mixers.every(m => !m.mediaEffects.active));
    config = normalizeConfig({ media: { equalizer: { enabled: true, preset: 'bassCut' }, compressor: { enabled: true, preset: 'gentle' } } }); output.updateSettings();
    assert.ok(mixers.every(m => m.mediaEffects.active && m.backgroundEffects.active));
    const filters = mixers[0].mediaEffects.filters; output.updateSettings(); assert.equal(filters, mixers[0].mediaEffects.filters);
    config.media.equalizer.enabled = false; config.media.compressor.enabled = false; output.updateSettings(); assert.ok(mixers.every(m => !m.mediaEffects.active));
  } finally { mixers.forEach(m => m.destroy()); }
});
test('effect processing fits the 20-ms audio budget', () => {
  const effects = processor({ equalizer: { enabled: true, preset: 'custom', gains: [3, -2, 4, -3, 2] }, compressor: { enabled: true, preset: 'level' } }), pcm = tone(440, .2, 1);
  for (let i = 0; i < 10; i++) effects.process(pcm);
  const start = performance.now(); for (let i = 0; i < 150; i++) effects.process(pcm);
  assert.ok((performance.now() - start) / 150 < 10, 'processing must leave headroom for Opus and other work');
});
test('effects reach real Discord Opus packets and keep quiet samples audible', { timeout: 5000 }, async t => {
  const mixer = new PcmMixer(), player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }), decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  t.after(() => { player.stop(true); mixer.destroy(); decoder.delete(); });
  mixer.configureEffects(normalizeConfig({ media: { equalizer: { enabled: true, preset: 'clarity' }, compressor: { enabled: true, preset: 'gentle' } } }).media); mixer.mediaVolume = 1;
  let packets = 0, audible = 0;
  player._preparePacket = packet => { packets++; const pcm = decoder.decode(packet); for (let i = 0; i < pcm.length; i += 2) if (Math.abs(pcm.readInt16LE(i)) > 1) audible++; };
  mixer.addMedia(tone(3000, .001)); player.play(createDiscordAudioResource(mixer)); await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(packets >= 20); assert.ok(audible > 1000);
});
