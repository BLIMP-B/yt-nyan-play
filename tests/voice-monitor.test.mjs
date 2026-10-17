import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import OpusScript from '../apps/desktop/runtime/opus-codec.mjs';
import { VoiceMonitor } from '../apps/desktop/runtime/voice-monitor.mjs';
import { VoiceMonitorBuffer } from '../apps/desktop/core/voice-monitor-buffer.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { monitorProcessor, monitorFrame, monitorBlock } from '../scripts/voice-monitor-harness.mjs';
import { verifyVoiceMonitorContinuity } from '../scripts/voice-monitor-probe.mjs';

function setup(t) {
  const messages = [], streams = new Map(), speaking = new EventEmitter(); speaking.users = new Map(); let processor;
  const entry = { channelId: '33333', connection: { receiver: { speaking, subscribe: id => { const stream = new PassThrough({ objectMode: true }); streams.set(id, stream); return stream; } } } };
  const monitor = new VoiceMonitor(m => { messages.push(m); if (m.type === 'start') processor = monitorProcessor(m.rendererMs); else if (m.type === 'pcm' || m.type === 'end' || m.type === 'idle') processor.port.onmessage({ data: m }); }, () => {}, () => {}); t.after(() => monitor.stop());
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO); t.after(() => encoder.delete());
  const pcm = Buffer.alloc(3840); for (let i = 0; i < 960; i++) { const sample = Math.round(5000 * Math.sin(2 * Math.PI * 1000 * i / 48000)); pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2); }
  return { monitor, entry, speaking, streams, messages, pcm, processor: () => processor, frame: () => monitorFrame(processor), packet: () => Buffer.from(encoder.encode(pcm, 960)) };
}
test('one VC monitor decodes and mixes real Opus while excluding the Bot, without a Discord output lane', t => {
  const s = setup(t); s.monitor.attach(s.entry, '11111', '99999');
  s.speaking.emit('start', '99999'); assert.equal(s.streams.size, 0);
  for (const userId of ['44444', '55555']) { s.speaking.emit('start', userId); for (let i = 0; i < 20; i++) s.streams.get(userId).write(s.packet()); }
  const output = Buffer.concat(Array.from({ length: 24 }, () => s.frame()));
  let peak = 0; for (let i = 0; i < output.length; i += 2) peak = Math.max(peak, Math.abs(output.readInt16LE(i)));
  assert.ok(peak > 5000); assert.equal(s.monitor.snapshot().guildId, '11111'); assert.equal(s.monitor.users.size, 2);
  assert.equal(s.monitor.snapshot().rendererMs, 360); assert.equal(s.monitor.timer, undefined);
  s.monitor.stop(); assert.equal(s.speaking.listenerCount('start'), 0); assert.ok([...s.streams.values()].every(stream => stream.destroyed)); assert.equal(s.messages.at(-1).type, 'stop');
});
test('selection/profile changes release subscriptions and bounded per-speaker queues; close frees a decoder', async t => {
  const s = setup(t); s.monitor.attach(s.entry, '11111', '99999'); s.speaking.emit('start', '44444');
  for (let i = 0; i < 100; i++) s.streams.get('44444').write(s.packet());
  assert.ok(s.processor().users.get('44444').available <= 48000);
  s.streams.get('44444').destroy(); await new Promise(resolve => setImmediate(resolve)); assert.equal(s.monitor.users.size, 0);
  const oldId = s.monitor.id; s.monitor.attach(s.entry, '11111', '99999', 'balanced'); assert.notEqual(s.monitor.id, oldId); assert.equal(s.monitor.snapshot().rendererMs, 200);
  const next = { ...s.entry, channelId: '66666' }; s.monitor.attach(next, '22222', '99999'); assert.equal(s.monitor.snapshot().channelId, '66666'); assert.equal(s.speaking.listenerCount('start'), 1);
});
test('PC audio clock fixes the v0.5.23 coarse timer gaps with real Opus and bounded arrival jitter', () => {
  const { baselinePcm, fixedPcm, ...report } = verifyVoiceMonitorContinuity();
  assert.equal(report.passed, true); assert.ok(report.baseline.gapsOver100ms >= 2); assert.equal(report.fixed.longestInternalSilenceMs, 0);
});
test('local worklet keeps speakers separate, rejects stale end events and clips the mixed output', () => {
  const p = monitorProcessor(80), bytes = new Uint8Array(7680), view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 4) { view.setInt16(i, 24576, true); view.setInt16(i + 2, -24576, true); }
  for (const userId of ['1', '2']) for (let i = 0; i < 100; i++) p.port.onmessage({ data: { type: 'pcm', userId, streamId: 'new', bytes } });
  assert.ok([...p.users.values()].every(u => u.available <= 48000));
  p.port.onmessage({ data: { type: 'end', userId: '1', streamId: 'old' } }); assert.equal(p.users.get('1').ended, false);
  monitorFrame(p); const output = monitorBlock(p);
  assert.equal(output[0][0], 1); assert.equal(output[1][0], -1);
  p.port.onmessage({ data: { type: 'end', userId: '1', streamId: 'new' } });
  for (let i = 0; i < 52; i++) monitorFrame(p); assert.equal(p.users.has('1'), false);
});
test('a 20-ms utterance starts within the jitter budget, and an ended utterance drains its tail', () => {
  const p = monitorProcessor(360), bytes = new Uint8Array(3840); new DataView(bytes.buffer).setInt16(4, 10000, true);
  p.port.onmessage({ data: { type: 'pcm', userId: '1', streamId: 'a', bytes } });
  for (let i = 0; i < 18; i++) assert.equal(monitorFrame(p).some(b => b), false);
  p.port.onmessage({ data: { type: 'idle', userId: '1', streamId: 'a' } }); assert.ok(monitorFrame(p).some(b => b));
  const q = monitorProcessor(360); q.port.onmessage({ data: { type: 'pcm', userId: '1', streamId: 'a', bytes } }); q.port.onmessage({ data: { type: 'end', userId: '1', streamId: 'a' } });
  assert.ok(monitorFrame(q).some(b => b)); monitorFrame(q); assert.equal(q.users.size, 0);
});
for (const drift of [-.002, .002]) test(`per-speaker drift correction stays continuous for 240 simulated seconds (${drift})`, () => {
  const b = new VoiceMonitorBuffer(360), bytes = new Uint8Array(3840), view = new DataView(bytes.buffer);
  for (let i = 0; i < 960; i++) { const sample = Math.round(8000 * Math.sin(i * Math.PI / 24)); view.setInt16(i * 4, sample, true); view.setInt16(i * 4 + 2, sample, true); }
  let due = 0, count = 0; const output = [new Float32Array(128), new Float32Array(128)];
  for (let clock = 0; clock < 240 * 48000; clock += 128) {
    while (due <= clock) { b.push(bytes, clock); due = ++count * 960 * (1 + drift); }
    output[0].fill(0); output[1].fill(0); b.mix(output, clock);
  }
  assert.equal(b.underruns, 0); assert.equal(b.discarded, 0); assert.ok(b.corrected > 100); assert.ok(b.available > 4800 && b.available < 30000);
});
test('shared PC speaker migrates from old speech setting and monitor volume/selection are validated', () => {
  assert.equal(normalizeConfig({ speech: { outputDevice: 'speaker-id' } }).desktop.outputDevice, 'speaker-id');
  assert.equal(normalizeConfig({ desktop: { outputDevice: 'new-id' }, speech: { outputDevice: 'old-id' } }).speech.outputDevice, 'new-id');
  assert.throws(() => normalizeConfig({ desktop: { voiceMonitorVolume: 1.1 } }), /通話音量/);
  assert.throws(() => normalizeConfig({ desktop: { voiceMonitorGuildId: 'bad' } }), /サーバー/);
});

test('PCM arriving during asynchronous PC device/worklet setup is preserved in order', async () => {
  const { readFileSync } = await import('node:fs'), { runInNewContext } = await import('node:vm');
  const contexts = [], nodes = [], callbacks = {}, failures = [];
  const window = { nyan: { onVoiceMonitor: cb => { callbacks.monitor = cb; }, onAudio() {}, audioResult: data => failures.push(data) } };
  class Context {
    constructor() { contexts.push(this); this.audioWorklet = { addModule: () => new Promise(resolve => { this.ready = resolve; }) }; }
    createGain() { return { gain: { value: 0 }, connect() { return this; }, disconnect() {} }; }
    async resume() {} async close() {}
  }
  class Node {
    constructor() { this.messages = []; this.port = { postMessage: m => this.messages.push(m) }; nodes.push(this); }
    connect(gain) { return gain; } disconnect() {}
  }
  const source = readFileSync(new URL('../apps/desktop/renderer/audio.js', import.meta.url), 'utf8').replace(/^import .*;\n/, '');
  runInNewContext(source, { window, AudioContext: Context, AudioWorkletNode: Node, Uint8Array, scheduleGain() {} });
  callbacks.monitor({ type: 'start', id: 'a', rendererMs: 360 }); await new Promise(resolve => setImmediate(resolve));
  callbacks.monitor({ type: 'pcm', id: 'a', userId: '1', streamId: 'one', bytes: new Uint8Array(3840) });
  callbacks.monitor({ type: 'end', id: 'a', userId: '1', streamId: 'one' });
  callbacks.monitor({ type: 'pcm', id: 'a', userId: '1', streamId: 'two', bytes: new Uint8Array(3840) });
  contexts[0].ready(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nodes[0].messages.map(m => m.streamId), ['one', 'one', 'two']);
  callbacks.monitor({ type: 'stop', id: 'old' }); callbacks.monitor({ type: 'pcm', id: 'old', bytes: new Uint8Array(3840) });
  assert.equal(nodes[0].messages.length, 3); assert.deepEqual(failures, []);
  callbacks.monitor({ type: 'stop', id: 'a' });
});


test('device render-ahead cannot start a partial buffer while the receiver is still active', () => {
  const b = new VoiceMonitorBuffer(360), bytes = new Uint8Array(3840); new DataView(bytes.buffer).setInt16(0, 10000, true);
  b.push(bytes, 0);
  for (let at = 0; at < 48000; at += 128) b.mix([new Float32Array(128), new Float32Array(128)], at);
  assert.equal(b.available, 960); assert.equal(b.underruns, 0); assert.equal(b.primed, false);
  for (let i = 0; i < 17; i++) b.push(bytes, 48000);
  b.mix([new Float32Array(128), new Float32Array(128)], 48000);
  assert.equal(b.starts[0].reason, 'buffer'); assert.equal(b.starts[0].bufferedMs, 360);
});
test('receiver idle notification uses wall time and is cancelled when a stream is retired', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup(t); s.monitor.attach(s.entry, '11111', '99999'); s.speaking.emit('start', '44444'); s.streams.get('44444').write(s.packet());
  t.mock.timers.tick(359); assert.equal(s.messages.some(m => m.type === 'idle'), false);
  t.mock.timers.tick(1); assert.equal(s.messages.filter(m => m.type === 'idle').length, 1);
  s.streams.get('44444').write(s.packet()); s.monitor.remove('44444'); t.mock.timers.tick(1000); assert.equal(s.messages.filter(m => m.type === 'idle').length, 1);
});


test('profile changes re-subscribe after the actual Discord receiver releases a cached destroyed stream', async t => {
  const { VoiceReceiver } = await import('@discordjs/voice');
  const s = setup(t), receiver = s.entry.connection.receiver;
  receiver.subscriptions = new Map(); receiver.subscribe = VoiceReceiver.prototype.subscribe;
  s.monitor.attach(s.entry, '11111', '99999'); receiver.speaking.users.set('44444', true); receiver.speaking.emit('start', '44444');
  const old = receiver.subscriptions.get('44444'); old.push(s.packet()); await new Promise(resolve => setImmediate(resolve)); const originalId = s.monitor.users.get('44444').streamId;
  s.monitor.attach(s.entry, '11111', '99999', 'balanced');
  await new Promise(resolve => setImmediate(resolve));
  const current = receiver.subscriptions.get('44444'); assert.notEqual(current, old); assert.equal(current.destroyed, false);
  assert.notEqual(s.monitor.users.get('44444').streamId, originalId); current.push(s.packet()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.messages.filter(m => m.type === 'pcm').length, 2);
  // A pending retry must not revive a monitor that was stopped meanwhile.
  s.monitor.attach(s.entry, '11111', '99999', 'poor'); s.monitor.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.monitor.users.size, 0); assert.equal(s.monitor.snapshot().status, 'waiting');
});
test('a subscription receiving no first packet releases its decoder after three seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const s = setup(t);
  s.monitor.attach(s.entry, '11111', '99999'); s.speaking.emit('start', '44444');
  t.mock.timers.tick(2999); assert.equal(s.monitor.users.size, 1); t.mock.timers.tick(1); assert.equal(s.monitor.users.size, 0);
  assert.equal(s.streams.get('44444').destroyed, true);
});
