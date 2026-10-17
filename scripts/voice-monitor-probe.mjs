import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import Opus from '../apps/desktop/runtime/opus-codec.mjs';
import { VoiceMonitor } from '../apps/desktop/runtime/voice-monitor.mjs';
import { VoiceMonitor as LegacyMonitor } from '../tests/fixtures/voice-monitor-v0.5.23.mjs';
import { monitorProcessor, monitorBlock } from './voice-monitor-harness.mjs';
import { pcmContinuity } from './media-buffer-probe.mjs';

export function verifyVoiceMonitorContinuity({ durationMs = 18000 } = {}) {
  const encoder = new Opus(), pcm = Buffer.alloc(3840);
  for (let i = 0; i < 960; i++) { const sample = Math.round(8000 * Math.sin(i * 2 * Math.PI * 1000 / 48000)); pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2); }
  const packet = Buffer.from(encoder.encode(pcm, 960)); encoder.delete();
  const simulate = legacy => {
    let processor; const streams = new Map(), speaking = new EventEmitter(); speaking.users = new Map();
    const entry = { channelId: '33333', connection: { receiver: { speaking, subscribe(id) { const stream = new PassThrough({ objectMode: true }); streams.set(id, stream); return stream; } } } };
    const errors = [];
    const monitor = new (legacy ? LegacyMonitor : VoiceMonitor)(message => {
      if (message.type === 'start') processor = monitorProcessor(message.rendererMs, legacy);
      else if (message.type === 'pcm' || message.type === 'end' && !legacy) processor.port.onmessage({ data: legacy ? new Uint8Array(message.bytes) : message });
    }, () => {}, (_level, text) => errors.push(text));
    monitor.attach(entry, '11111', '99999'); clearInterval(monitor.timer); speaking.emit('start', '44444');
    const output = Buffer.alloc(Math.ceil((durationMs + 1200) * 48) * 4);
    let arrival = 0, priorDue = 0, timerAt = 46.875, write = 0, maxBufferedMs = 0;
    // A 40-ms timer rounded to three 15.625-ms Windows ticks supplies only
    // 40 ms every 46.875 ms. The input and audio hardware still run at 48 kHz.
    // Add 180-ms packet batching and 160-ms IPC batching, in order, to both.
    const due = index => {
      let at = index * 20 + (index % 100 >= 20 && index % 100 < 28 ? 180 : 0);
      if (at % 2000 >= 900 && at % 2000 < 1060) at += 1060 - at % 2000;
      return Math.max(priorDue, at);
    };
    let nextDue = due(0);
    try {
      for (let frame = 0; frame < output.length / 4; frame += 128) {
        const at = frame / 48;
        while (arrival * 20 < durationMs && nextDue <= at) {
          streams.get('44444').write(packet); priorDue = nextDue; nextDue = due(++arrival);
        }
        if (!legacy && arrival * 20 >= durationMs && monitor.users.has('44444')) monitor.remove('44444');
        if (legacy) while (timerAt <= at) { processor.port.onmessage({ data: new Uint8Array(Buffer.concat([monitor.frame(), monitor.frame()])) }); timerAt += 46.875; }
        const count = Math.min(128, output.length / 4 - frame), block = monitorBlock(processor, count);
        for (let i = 0; i < count; i++) for (let ch = 0; ch < 2; ch++) output.writeInt16LE(Math.round(block[ch][i] * 32767), write + i * 4 + ch * 2);
        write += count * 4;
        if (!legacy) for (const user of processor.users.values()) maxBufferedMs = Math.max(maxBufferedMs, user.available / 48);
      }
      assert.deepEqual(errors, []);
      const measured = output.subarray(48000 * 4, Math.floor((durationMs - 200) * 48) * 4);
      return { ...pcmContinuity(measured), maxBufferedMs, underruns: processor.reports.at(-1)?.underruns ?? null, framesDelivered: arrival, pcm: output };
    } finally { monitor.stop(); }
  };
  const baseline = simulate(true), fixed = simulate(false);
  assert.ok(baseline.gapsOver100ms >= 2, 'Coarse timer regression did not reproduce');
  assert.equal(fixed.gapsOver100ms, 0); assert.equal(fixed.longestInternalSilenceMs, 0); assert.equal(fixed.underruns, 0);
  assert.ok(fixed.maxBufferedMs <= 1000 && fixed.audibleFrames > (durationMs - 1600) / 20);
  const { pcm: baselinePcm, ...before } = baseline, { pcm: fixedPcm, ...after } = fixed;
  return { passed: true, durationMs, packetJitterMs: 180, ipcBatchingMs: 160, legacyTimerMs: 46.875, actualDiscordReceiver: false, baseline: before, fixed: after, baselinePcm, fixedPcm };
}
