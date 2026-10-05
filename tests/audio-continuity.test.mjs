import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { PcmMixer, createDiscordAudioResource } from '../apps/desktop/runtime/voice-output.mjs';
import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import OpusScript from 'opusscript';
function tone(frames, amplitude) {
  const bytes = Buffer.alloc(frames * 3840);
  for (let sample = 0; sample < frames * 960; sample++) { const value = Math.round(amplitude * Math.sin(sample * 2 * Math.PI * 440 / 48000)); bytes.writeInt16LE(value, sample * 4); bytes.writeInt16LE(value, sample * 4 + 2); }
  return bytes;
}
test('capture batches exactly 20 ms of stereo PCM, including quiet samples and silence, without dropping render quanta', () => {
  let Processor; const packets = [];
  runInNewContext(readFileSync(new URL('../apps/desktop/renderer/pcm-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: bytes => packets.push(Buffer.from(bytes)) }; } }, registerProcessor: (_name, klass) => { Processor = klass; },
  });
  const processor = new Processor(), quiet = new Float32Array(128).fill(.0001);
  for (let i = 0; i < 375; i++) processor.process([[quiet]]);
  assert.equal(packets.length, 50); assert.ok(packets.every(p => p.length === 3840));
  for (const packet of packets) for (let i = 0; i < packet.length; i += 2) assert.equal(packet.readInt16LE(i), 3);
  for (let i = 0; i < 375; i++) processor.process([]);
  assert.equal(packets.length, 100); assert.ok(packets.slice(50).every(p => p.every(byte => byte === 0)));
});
test('Discord packet generation avoids underruns when main-thread work stalls and retains quiet media through Opus', { timeout: 10000 }, async t => {
  const mixer = new PcmMixer(); mixer.mediaVolume = 1;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  t.after(() => { player.stop(true); mixer.destroy(); decoder.delete(); });
  const resource = createDiscordAudioResource(mixer), read = resource.read.bind(resource); let emptyReads = 0, peak = 0, packets = 0;
  resource.read = () => { const packet = read(); if (!packet) emptyReads++; return packet; };
  player._preparePacket = packet => { packets++; const pcm = decoder.decode(packet); for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i))); };
  mixer.addMedia(tone(50, 32)); player.play(resource);
  const stall = setInterval(() => { const until = performance.now() + 60; while (performance.now() < until) {} }, 150);
  try { await new Promise(resolve => setTimeout(resolve, 1400)); } finally { clearInterval(stall); }
  assert.equal(emptyReads, 0, 'Discord inserted a missing-packet silence frame');
  assert.ok(packets >= 50); assert.ok(peak > 2 && peak < 100, `Quiet media was lost or amplified: ${peak}`);
  assert.equal(player.state.missedFrames, 0);
});
test('jitter buffering never consumes a partial media frame and speech can continue before media primes', async t => {
  const mixer = new PcmMixer(); mixer.mediaVolume = 1; t.after(() => mixer.destroy());
  const audio = tone(4, 1000); mixer.addMedia(audio.subarray(0, 512));
  assert.ok(mixer.takeFrame().every(b => b === 0)); assert.equal(mixer.media.length, 512);
  const spoken = mixer.addSpeech(tone(1, 2000), 1); assert.ok(mixer.takeFrame().some(b => b !== 0)); await spoken; assert.equal(mixer.media.length, 512);
  mixer.addMedia(audio.subarray(512)); assert.deepEqual(mixer.takeFrame(), audio.subarray(0, 3840));
});
