import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { DiscordAudioWorker } from '../apps/desktop/runtime/voice-worker.mjs';

const fixture = new URL('./voice-clock-fixture.mjs', import.meta.url);
function tone(frames, start = 0, frequency = 440) {
  const bytes = Buffer.alloc(frames * 3840);
  for (let i = 0; i < frames * 960; i++) { const value = Math.round(5000 * Math.sin((start * 960 + i) * 2 * Math.PI * frequency / 48000)); bytes.writeInt16LE(value, i * 4); bytes.writeInt16LE(value, i * 4 + 2); }
  return bytes;
}
function summarize(report) {
  let longest = 0, run = 0;
  for (const sample of report.samples) { if (sample.rms < 50) longest = Math.max(longest, ++run); else run = 0; }
  return { packets: report.samples.length, silentFrames: report.samples.filter(s => s.rms < 50).length, longestSilenceMs: longest * 20, maxGapMs: Math.max(...report.samples.slice(1).map(s => s.gap)), burstsUnder5ms: report.samples.slice(1).filter(s => s.gap < 5).length, shapedDrops: report.shapedDrops, sequenceErrors: report.sequenceErrors };
}
async function runCase({ mediaMs = 600, paced = true, source = false, shaped = false, senderStallMs = 0 }) {
  const peers = [], entries = [], ports = {}, errors = []; let backend, feed, busy;
  try {
    for (let i = 0; i < 3; i++) {
      const peer = new Worker(fixture, { workerData: { role: 'observer', rtp: true, shaped }, execArgv: [] }); peers.push(peer);
      const [{ port }] = await once(peer, 'message'); ports[String(11111 + i)] = port;
    }
    const query = async (peer, type) => { const reply = once(peer, 'message'); peer.postMessage({ type }); return (await reply)[0]; };
    backend = new DiscordAudioWorker({ workerUrl: fixture, workerData: { role: 'sender', ports, rtp: true, paced, mediaBufferMs: mediaMs, senderStallMs }, log: () => {} });
    for (let i = 0; i < 3; i++) {
      const entry = backend.open({ guildId: String(11111 + i), channelId: String(33333 + i), selfDeaf: true, networkProfile: 'poor', bitrate: 48, adapterCreator: () => ({ sendPayload: () => true, destroy() {} }) });
      entry.player.on('error', e => errors.push(e.message)); entry.connection.on('error', e => errors.push(e.message)); entries.push(entry);
    }
    await Promise.all(entries.map(e => e.ready));
    let speech;
    if (source) {
      const initial = Math.ceil(mediaMs / 20) + 2, began = performance.now(); let produced = initial;
      for (const entry of entries) { entry.mixer.mediaVolume = 1; entry.mixer.ducking = 1; entry.mixer.addMedia(tone(initial)); }
      feed = setInterval(() => { const target = initial + Math.floor((performance.now() - began) / 20), count = target - produced; if (count > 0) { const bytes = tone(count, produced); for (const entry of entries) entry.mixer.addMedia(bytes); produced = target; } }, 20);
    } else speech = Promise.all(entries.map(e => e.mixer.addSpeech(tone(190), 1)));
    await wait(350); await Promise.all(peers.map(p => query(p, 'reset')));
    if (source) busy = setInterval(() => { const until = performance.now() + 500; while (performance.now() < until) {} }, 900);
    await wait(source ? 3200 : 2600); clearInterval(busy); busy = null;
    const reports = await Promise.all(peers.map(p => query(p, 'report'))), summaries = reports.map(summarize);
    const diagnostics = await backend.diagnostics();
    let tailPreserved = true;
    if (source) {
      clearInterval(feed); feed = null;
      for (const entry of entries) entry.mixer.addMedia(tone(5, 0, 880));
      await Promise.all(entries.map(e => e.mixer.drain('media'))); await wait(80);
      const tails = await Promise.all(peers.map(p => query(p, 'report')));
      tailPreserved = tails.every(r => r.samples.filter(s => s.rms > 200).slice(-5).some(s => s.frequency > 700 && s.frequency < 1000));
    } else await speech;
    assert.equal(errors.length, 0, errors.join('\n'));
    return { mediaBufferMs: mediaMs, paced, connections: 3, summaries, diagnostics, tailPreserved };
  } finally { clearInterval(feed); clearInterval(busy); backend?.close(); for (const peer of peers) { peer.postMessage({ type: 'stop' }); await peer.terminate(); } }
}
export async function verifyVoiceImpairments() {
  const sourceBaseline = await runCase({ source: true, mediaMs: 240 });
  const sourceFixed = await runCase({ source: true, mediaMs: 600 });
  assert.ok(sourceBaseline.summaries.every(s => s.longestSilenceMs >= 160), 'The old 240-ms buffer must reproduce IPC starvation: ' + JSON.stringify(sourceBaseline.summaries));
  for (const s of sourceFixed.summaries) { assert.equal(s.silentFrames, 0, JSON.stringify(s)); assert.equal(s.sequenceErrors, 0); assert.equal(s.burstsUnder5ms, 0); }
  assert.equal(sourceFixed.tailPreserved, true);
  assert.ok(sourceFixed.diagnostics.every(d => d.pcmBuffers.targetMs === 600 && d.pcmBuffers.media.underruns === 0 && d.dispatchQueue.overflowDrops === 0));
  const pacingBaseline = await runCase({ paced: false, shaped: true, senderStallMs: 70 });
  const pacingFixed = await runCase({ paced: true, shaped: true, senderStallMs: 70 });
  assert.ok(pacingBaseline.summaries.every(s => s.shapedDrops >= 3), 'Catch-up bursts must overflow the shaped link: ' + JSON.stringify(pacingBaseline.summaries));
  for (const s of pacingFixed.summaries) { assert.equal(s.shapedDrops, 0, JSON.stringify(s)); assert.equal(s.sequenceErrors, 0); assert.equal(s.burstsUnder5ms, 0); }
  return { passed: true, transport: 'loopback-udp-with-rtp', discordReceiverVerified: false, sourceStallMs: 500, workerStallMs: 70, linkKbpsPerVC: 80, sourceBaseline, sourceFixed, pacingBaseline, pacingFixed };
}
