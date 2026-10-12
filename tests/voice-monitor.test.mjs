import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import OpusScript from '../apps/desktop/runtime/opus-codec.mjs';
import { VoiceMonitor } from '../apps/desktop/runtime/voice-monitor.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

function setup(t) {
  const messages = [], streams = new Map(), speaking = new EventEmitter(); speaking.users = new Map();
  const entry = { channelId: '33333', connection: { receiver: { speaking, subscribe: id => { const stream = new PassThrough({ objectMode: true }); streams.set(id, stream); return stream; } } } };
  const monitor = new VoiceMonitor(m => messages.push(m), () => {}, () => {}); t.after(() => monitor.stop());
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO); t.after(() => encoder.delete());
  const pcm = Buffer.alloc(3840); for (let i = 0; i < 960; i++) { const sample = Math.round(5000 * Math.sin(2 * Math.PI * 660 * i / 48000)); pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2); }
  return { monitor, entry, speaking, streams, messages, packet: () => Buffer.from(encoder.encode(pcm, 960)) };
}
test('one VC monitor decodes and mixes real Opus while excluding the Bot, without a Discord output lane', t => {
  const s = setup(t); s.monitor.attach(s.entry, '11111', '99999');
  s.speaking.emit('start', '99999'); assert.equal(s.streams.size, 0);
  for (const userId of ['44444', '55555']) { s.speaking.emit('start', userId); for (let i = 0; i < 16; i++) s.streams.get(userId).write(s.packet()); }
  const output = Buffer.concat(Array.from({ length: 8 }, () => s.monitor.frame()));
  let peak = 0; for (let i = 0; i < output.length; i += 2) peak = Math.max(peak, Math.abs(output.readInt16LE(i)));
  assert.ok(peak > 5000); assert.equal(s.monitor.snapshot().guildId, '11111'); assert.equal(s.monitor.users.size, 2);
  s.monitor.stop(); assert.equal(s.speaking.listenerCount('start'), 0); assert.ok([...s.streams.values()].every(stream => stream.destroyed)); assert.equal(s.messages.at(-1).type, 'stop');
});
test('selection changes release old subscriptions; jitter and stalled-user buffers remain bounded', t => {
  const s = setup(t); s.monitor.attach(s.entry, '11111', '99999'); s.speaking.emit('start', '44444');
  for (let i = 0; i < 100; i++) s.streams.get('44444').write(s.packet());
  assert.ok(s.monitor.users.get('44444').bytes.length <= 192000);
  s.monitor.users.get('44444').progressAt = Date.now() - 4000; s.monitor.frame(); assert.equal(s.monitor.users.size, 0);
  const next = { ...s.entry, channelId: '66666' }; s.monitor.attach(next, '22222', '99999'); assert.equal(s.monitor.snapshot().channelId, '66666'); assert.equal(s.speaking.listenerCount('start'), 1);
});
test('local monitor worklet outputs stereo with a bounded buffer after renderer stalls', () => {
  let Processor; runInNewContext(readFileSync(new URL('../apps/desktop/renderer/voice-monitor-worklet.js', import.meta.url), 'utf8'), { AudioWorkletProcessor: class { constructor() { this.port = {}; } }, registerProcessor: (_, cls) => { Processor = cls; }, Uint8Array, DataView, Float32Array });
  const processor = new Processor(), bytes = new Uint8Array(7680), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 4) { view.setInt16(i, 8192, true); view.setInt16(i + 2, -8192, true); }
  for (let i = 0; i < 100; i++) processor.port.onmessage({ data: bytes });
  assert.ok(processor.samples <= 48000);
  const outputs = [[new Float32Array(128), new Float32Array(128)]]; processor.process([], outputs);
  assert.equal(outputs[0][0][0], 0.25); assert.equal(outputs[0][1][0], -0.25);
});
test('shared PC speaker migrates from old speech setting and monitor volume/selection are validated', () => {
  assert.equal(normalizeConfig({ speech: { outputDevice: 'speaker-id' } }).desktop.outputDevice, 'speaker-id');
  assert.equal(normalizeConfig({ desktop: { outputDevice: 'new-id' }, speech: { outputDevice: 'old-id' } }).speech.outputDevice, 'new-id');
  assert.throws(() => normalizeConfig({ desktop: { voiceMonitorVolume: 1.1 } }), /通話音量/);
  assert.throws(() => normalizeConfig({ desktop: { voiceMonitorGuildId: 'bad' } }), /サーバー/);
});
