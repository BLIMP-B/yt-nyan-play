import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { DiscordAudioWorker } from '../apps/desktop/runtime/voice-worker.mjs';
import { PcmMixer, createDiscordAudioResource } from '../apps/desktop/runtime/voice-output.mjs';
import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';

function tone(frames, start = 0) {
  const pcm = Buffer.alloc(frames * 3840);
  for (let i = 0; i < frames * 960; i++) { const value = Math.round(4000 * Math.sin((start * 960 + i) * 2 * Math.PI * 440 / 48000)); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
  return pcm;
}
async function load(duration) {
  const stall = setInterval(() => { const until = performance.now() + 90; while (performance.now() < until) {} }, 180);
  try { await wait(duration); } finally { clearInterval(stall); }
}
function summary(samples) {
  const gaps = samples.slice(1).map(s => s.gap);
  return { packets: samples.length, maxGapMs: Math.max(...gaps), gapsOver60ms: gaps.filter(g => g > 60).length, burstsUnder5ms: gaps.filter(g => g < 5).length, silentFrames: samples.filter(s => s.rms < 50).length };
}
export async function verifyVoiceClock() {
  const times = [], mixer = new PcmMixer(), player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const dispatch = player._stepDispatch.bind(player); player._stepDispatch = () => { times.push(performance.now()); dispatch(); };
  player.play(createDiscordAudioResource(mixer));
  try { await load(2200); } finally { player.stop(true); mixer.destroy(); }
  const baseline = summary(times.map((time, i) => ({ gap: i ? time - times[i - 1] : 0, rms: 100 })));
  assert.ok(baseline.gapsOver60ms >= 5 && baseline.burstsUnder5ms >= 10, 'The fixture must reproduce the old stalled packet clock');
  const observer = new Worker(new URL('./voice-clock-fixture.mjs', import.meta.url), { workerData: { role: 'observer' }, execArgv: [] });
  const [{ port }] = await once(observer, 'message'), logs = [], sent = [];
  const backend = new DiscordAudioWorker({ workerUrl: new URL('./voice-clock-fixture.mjs', import.meta.url), workerData: { role: 'sender', port }, log: (_level, text) => logs.push(text) });
  let entry;
  const query = async type => { const reply = once(observer, 'message'); observer.postMessage({ type }); return (await reply)[0]; };
  try {
    entry = backend.open({ guildId: '11111', channelId: '33333', selfDeaf: true, networkProfile: 'poor', bitrate: 48, adapterCreator: methods => ({ sendPayload: payload => { sent.push(payload); if (payload.d.channel_id) { methods.onVoiceStateUpdate({ guild_id: '11111', channel_id: '33333', session_id: 'fixture' }); methods.onVoiceServerUpdate({ guild_id: '11111', endpoint: 'fixture', token: 'fixture' }); } return true; }, destroy() {} }) });
    entry.player.on('error', error => logs.push(error.message)); entry.connection.on('error', error => logs.push(error.message));
    await entry.ready; await wait(300);
    const speaking = entry.mixer.addSpeech(tone(180), 1); await wait(200); await query('reset');
    await load(2400); const speech = summary((await query('report')).samples); await speaking;
    entry.mixer.mediaVolume = 1; entry.mixer.ducking = 1; entry.mixer.addMedia(tone(12));
    const began = performance.now(); let produced = 12;
    const feed = setInterval(() => { const target = 12 + Math.floor((performance.now() - began) / 20), frames = target - produced; if (frames > 0) { entry.mixer.addMedia(tone(frames, produced)); produced = target; } }, 20);
    let media;
    try { await wait(300); await query('reset'); await load(2400); media = summary((await query('report')).samples); }
    finally { clearInterval(feed); entry.mixer.clearMedia(); }
    for (const report of [speech, media]) {
      assert.ok(report.packets >= 100, JSON.stringify(report));
      assert.ok(report.gapsOver60ms <= 2 && report.burstsUnder5ms <= 4, JSON.stringify(report));
      assert.equal(report.silentFrames, 0, JSON.stringify(report));
    }
    const abort = new AbortController(), cancelled = entry.mixer.addSpeech(tone(150), 1, abort.signal); abort.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
    backend.release(entry.workerId); assert.equal(sent.at(-1).d.channel_id, null, 'Leaving must be sent before retiring the gateway adapter');
    assert.equal(logs.length, 0, logs.join('\n'));
    return { passed: true, separateThread: true, transport: 'loopback-udp', mainStallMs: 90, baseline, speech, media, cancellation: true, gatewayLeave: true };
  } finally { backend.close(); observer.postMessage({ type: 'stop' }); await observer.terminate(); }
}
