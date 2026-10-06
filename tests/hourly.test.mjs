import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { GainEnvelope, hourlyProgram, threePointPcm, pcmWav, nextHour } from '../apps/desktop/core/hourly-audio.mjs';
import { SmallWordModel, lexicalTokens, tokenizer, generateSlm } from '../apps/desktop/core/hourly-language.mjs';
import { HourlyHistory } from '../apps/desktop/runtime/hourly-history.mjs';
import { HourlyRuntime } from '../apps/desktop/runtime/hourly.mjs';
import { PcmMixer } from '../apps/desktop/runtime/voice-output.mjs';
import { SpeechPool } from '../apps/desktop/core/speech-pool.mjs';
import { MediaPool } from '../apps/desktop/core/media-pool.mjs';
import { Store } from '../apps/desktop/core/store.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { mediaScript } from '../apps/desktop/core/media-script.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
const temp = t => { const path = mkdtempSync(join(tmpdir(), 'nyan-hourly-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
test('third beep begins exactly at the selected hour regardless of announcement duration and the short beeps stay one second apart', () => {
  const target = new Date(2026, 9, 5, 12, 0, 0, 0).getTime();
  for (const duration of [700, 3600, 12340]) {
    const announcement = Buffer.alloc(duration * 192), program = hourlyProgram(announcement, target);
    assert.equal(program.startAt + program.thirdOffsetMs, target); assert.equal(program.pcm.length / 192 + program.startAt, target + 1000);
    const beepStart = announcement.length + 250 * 192;
    for (const second of [0, 1, 2]) assert.ok(program.pcm.subarray(beepStart + second * 192000 + 4, beepStart + second * 192000 + 4800).some(v => v !== 0));
    assert.ok(program.pcm.subarray(beepStart + 100 * 192, beepStart + 1000 * 192).every(v => v === 0));
    assert.equal(pcmWav(program.pcm).readUInt32LE(40), program.pcm.length);
  }
  assert.equal(nextHour(target), target + 3600000);
});
test('scheduled Discord PCM waits for its wall-clock slot and keeps the third beep aligned after a delayed frame', async t => {
  const mixer = new PcmMixer(); t.after(() => mixer.destroy()); const at = 100000, pcm = threePointPcm();
  const finished = mixer.addSpeech(pcm, 1, undefined, at);
  assert.ok(mixer.takeFrame(at - 20).every(v => v === 0));
  mixer.takeFrame(at); mixer.takeFrame(at + 1980);
  const third = mixer.takeFrame(at + 2000); assert.ok(third.some(v => v !== 0));
  assert.deepEqual(third, pcm.subarray(384000, 387840)); mixer.takeFrame(at + 2980); await finished;
});
test('clock reservations preempt active speech including stop announcements, preserve waiting items and release per-server independently', async t => {
  const store = new Store(temp(t)), started = [];
  const pool = new SpeechPool(store, (job, signal) => new Promise((resolve, reject) => { started.push(job.payload.text); job.finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const first = pool.enqueue({ guildId: '11111', text: 'one' }), queued = pool.enqueue({ guildId: '11111', text: 'queued' });
  pool.enqueue({ guildId: '22222', text: 'two' });
  const release = pool.reserve(); const stop = pool.enqueue({ guildId: '11111', text: 'stop', priority: 100 }); await turn();
  assert.equal(first.status, 'cancelled'); assert.equal(queued.status, 'waiting'); assert.equal(stop.status, 'waiting'); assert.deepEqual(started, ['one', 'two']);
  const guildRelease = pool.reserve(['11111', 'master', 'local']); release(); pool.enqueue({ guildId: '22222', text: 'other server' }); await turn(); assert.equal(started.at(-1), 'other server');
  guildRelease(); await turn(); assert.equal(started.at(-1), 'stop'); stop.finish(); await turn(); assert.equal(queued.status, 'running'); queued.finish(); pool.clear(); await turn();
});
test('media and BGM use independent buffers and fades; a media ending during a fade is never queued or restarted', async t => {
  let clock = 0; const envelope = new GainEnvelope(1, () => clock); envelope.fade(0, 1500); clock = 750; assert.equal(envelope.value(), 0.5); clock = 1500; assert.equal(envelope.value(), 0);
  const mixer = new PcmMixer(); t.after(() => mixer.destroy()); const frame = Buffer.alloc(3840 * 4); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1000, i);
  mixer.mediaVolume = 1; mixer.backgroundVolume = 1; mixer.addMedia(frame); mixer.addBackground(frame); mixer.mediaGain.fade(0); assert.equal(mixer.takeFrame().readInt16LE(0), 1000);
  mixer.backgroundGain.fade(0); assert.equal(mixer.takeFrame().readInt16LE(0), 0); assert.ok(mixer.media.length < frame.length);
  const store = new Store(temp(t)); let played = 0, finish;
  const pool = new MediaPool(store, () => ({ setPaused() {}, setDucked() {}, setOverlayGain() {}, close() {}, play: () => { played++; return new Promise(resolve => { finish = resolve; }); } }));
  const media = pool.enqueue({ guildId: '11111', url: 'https://youtu.be/jNQXAC9IVRw' }); await turn(); pool.fadeOverlay(0.15, 1000); finish(); await turn(); pool.fadeOverlay(1, 1000); await turn(); assert.equal(media.status, 'completed'); assert.equal(played, 1); pool.close();
});
test('browser fade changes volume smoothly without pausing or replaying naturally ended media', () => {
  let clock = 0, timer; const video = { tagName: 'VIDEO', currentTime: 10, duration: 20, readyState: 4, paused: false, ended: false, volume: 1, addEventListener() {}, play() { throw new Error('must not restart'); }, pause() { this.paused = true; } };
  const context = { document: { querySelectorAll: () => [video], querySelector: () => null }, window: { __nyanMedia: video, __nyanStarted: true }, Date: { now: () => clock }, setInterval: fn => { timer = fn; return 1; }, clearInterval() {} };
  runInNewContext(mediaScript({ mode: 'direct', volume: 0, volumeRampMs: 1500 }), context); clock = 750; timer(); assert.equal(video.volume, 0.5); assert.equal(video.paused, false);
  clock = 1500; timer(); assert.equal(video.volume, 0); video.ended = video.paused = true;
  const state = runInNewContext(mediaScript({ mode: 'direct', volume: 1, volumeRampMs: 1000 }), context); assert.equal(state.ended, true); assert.equal(video.paused, true);
});
test('all selected channel history is paginated, persisted, updated, deleted and cut off at generation time', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nyan-hourly-history-')); let history;
  t.after(async () => { await history?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const c = normalizeConfig({ hourly: { servers: [{ guildId: '11111', enabled: true, bgm: false, channelIds: ['22222', '33333'] }] } });
  const messages = Array.from({ length: 230 }, (_, i) => ({ id: String(10000 + i), channelId: '22222', guildId: '11111', content: i === 0 ? '猫 時計' : '森 太陽', createdTimestamp: i + 1 }));
  let calls = 0, denied = false;
  const channel = id => ({ guildId: '11111', name: id, permissionsFor: () => ({ has: () => !denied }), messages: { fetch: async options => { calls++; return new Map(messages.filter(m => m.channelId === id && (!options.before || BigInt(m.id) < BigInt(options.before))).reverse().slice(0, options.limit).map(m => [m.id, m])); } } });
  const client = { isReady: () => true, user: { id: '99999' }, channels: { fetch: async id => channel(id) } };
  history = new HourlyHistory(directory, () => client, () => c); await history.sync(); assert.equal(history.snapshot().messages, 230); assert.ok(calls >= 4);
  const model = await history.model(c.hourly.servers[0], 1); assert.equal(model.vocabulary('名詞').length, 2); await history.close();
  history = new HourlyHistory(directory, () => client, () => c);
  const before = calls; await history.sync(); assert.equal(calls - before, 2); assert.equal(history.snapshot().messages, 230);
  await history.record({ ...messages[0], content: '月 料理' }); await history.deleted(messages[1].id); assert.equal(history.snapshot().messages, 229);
  denied = true; await assert.rejects(history.model(c.hourly.servers[0], 999), /現在の履歴閲覧権限/);
});
test('the local SLM receives words, produces a subject and predicate, and supplies two nouns actually present in its output', async () => {
  const analyzer = await tokenizer(), model = new SmallWordModel(() => 0); model.train(lexicalTokens('猫が時計を眺める。', analyzer));
  let body;
  const result = await generateSlm(model, normalizeConfig().hourly, undefined, async (url, options) => { assert.equal(url.hostname, '127.0.0.1'); body = JSON.parse(options.body); return new Response(JSON.stringify({ response: JSON.stringify({ subject: '猫', object: '時計', verb: '眺める', adjective: '' }) })); });
  assert.equal(body.model, 'qwen3:0.6b'); assert.equal(body.think, false); assert.deepEqual(result.nouns, ['猫', '時計']); assert.equal(result.text, '猫は、時計を眺める。');
  await assert.rejects(generateSlm(model, normalizeConfig().hourly, undefined, async () => new Response(JSON.stringify({ response: '{"text":"猫と時計。"}' }))), /主語・述語/);
  assert.throws(() => normalizeConfig({ hourly: { slmUrl: 'https://example.com' } }), /PC内/);
});
test('common chime and custom speech enforce the 1.5-second tail then the configured fade (3 seconds by default) and restore every reservation on cancellation', async t => {
  const c = normalizeConfig({ hourly: { enabled: true, servers: [{ guildId: '11111', channelIds: ['22222'], enabled: true, bgm: true }] } }); let time = 100000, holds = 0, reserved = 0; const events = [];
  const handlers = { targets: () => ['11111', '33333'], reserve: () => { reserved++; return () => { reserved--; }; }, hold: (_, on) => { holds += on ? 1 : -1; }, log: () => {}, fadeMedia: () => {},
    history: { model: async () => new SmallWordModel() }, model: { start: async () => {} }, generate: async () => ({ text: '猫は時計を運ぶ。', nouns: ['猫', '時計'], model: 'fixture' }),
    synthesize: async () => Buffer.alloc(700 * 192), play: async (pcm, targets, signal, startAt) => { events.push(['play', targets, startAt || time]); time = (startAt || time) + pcm.length / 192; await turn(); },
    background: async () => ({ fade: async ms => { events.push(['fade', time, ms]); time += ms; }, stop: async () => events.push(['stop', time]) }) };
  const runtime = new HourlyRuntime(temp(t), () => c, handlers, { now: () => time, delay: async ms => { time += ms; await turn(); } });
  runtime.controller = new AbortController(); const program = { ...hourlyProgram(Buffer.alloc(700 * 192), time + 4000), text: '時報' }; await runtime.execute(program, { test: true });
  assert.deepEqual(events[0][1], ['11111', '33333']); assert.deepEqual(events[1][1], ['11111']); assert.equal(events[2][0], 'fade'); assert.equal(events[2][2], 3000); assert.equal(events[2][1] - events[1][2], 700 + 1500); assert.equal(events[3][1] - events[2][1], 3000); assert.equal(holds, 0); assert.equal(reserved, 0);
  handlers.play = async () => { runtime.cancel(); throw new DOMException('cancel', 'AbortError'); }; time = 200000; runtime.controller = new AbortController();
  await assert.rejects(runtime.execute({ ...hourlyProgram(Buffer.alloc(700 * 192), time + 4000), text: '時報' }, { test: true }), { name: 'AbortError' }); assert.equal(holds, 0); assert.equal(reserved, 0); runtime.close();
});
test('daily fallback saves one calendar day once, reuses ordered hour slots after restart and keeps its original corpus cutoff', async t => {
  const directory = temp(t), c = normalizeConfig({ hourly: { generationMode: 'daily', servers: [{ guildId: '11111', channelIds: ['22222'], enabled: true, bgm: false }] } });
  let generated = 0; const now = new Date(2026, 9, 5, 10, 30).getTime(), at = nextHour(now), server = c.hourly.servers[0];
  const handlers = { model: { start: async () => {} }, history: { model: async () => new SmallWordModel() }, generate: async () => ({ text: `猫は時計を${++generated}回眺める。`, nouns: ['猫', '時計'], model: 'fixture' }), log() {} };
  const runtime = new HourlyRuntime(directory, () => c, handlers, { now: () => now });
  await runtime.batch(server, at); assert.equal(generated, 24); await runtime.batch(server, nextHour(at)); assert.equal(generated, 24);
  const restored = new HourlyRuntime(directory, () => c, handlers, { now: () => now });
  const first = await restored.sentence(server, at, 1000), second = await restored.sentence(server, nextHour(at), 1000); assert.notEqual(first.text, second.text); assert.equal(first.cutoff, now); assert.equal(second.cutoff, now); runtime.close(); restored.close();
});
test('late common chimes are rejected before reserving or interrupting any audio', async t => {
  let interrupted = false; const at = 100000;
  const runtime = new HourlyRuntime(temp(t), () => normalizeConfig(), { reserve: () => { interrupted = true; }, log() {} }, { now: () => at });
  await assert.rejects(runtime.execute({ ...hourlyProgram(Buffer.alloc(700 * 192), at), text: '時報' }), /間に合いません/); assert.equal(interrupted, false); runtime.close();
});
test('cancelling a pending automatic hour also cancels its slot, so polling cannot recreate it', async t => {
  const at = new Date(2026, 9, 5, 12, 0).getTime(), c = normalizeConfig({ hourly: { enabled: true, output: 'local' } }); let prepared = 0;
  const runtime = new HourlyRuntime(temp(t), () => c, { synthesize: async () => { prepared++; return Buffer.alloc(700 * 192); }, log() {} }, { now: () => at - 50000 });
  runtime.tick(); await turn(); assert.equal(runtime.snapshot().busy, true); runtime.cancel(); runtime.tick(); await turn(); assert.equal(prepared, 1); assert.equal(runtime.snapshot().busy, false); runtime.close();
});
