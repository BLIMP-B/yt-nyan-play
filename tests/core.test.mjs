import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, validateMediaUrl } from '../apps/desktop/core/config.mjs';
import { parseMediaCommand, parseBotCommand } from '../apps/desktop/core/protocol.mjs';
import { prepareSpeech, shouldRead, applyDictionary } from '../apps/desktop/core/text.mjs';
import { Store } from '../apps/desktop/core/store.mjs';
import { JobRunner } from '../apps/desktop/core/queue.mjs';
export const config = () => normalizeConfig({ bot: { bindings: [{ guildId: '11111', textChannelIds: ['22222'], voiceChannelId: '33333' }] } });
const message = () => ({ content: 'こんにちは', userId: '44444', userName: 'user', displayName: 'ねこ', guildId: '11111', channelId: '22222', roleIds: [] });
function temporary(t) { const path = mkdtempSync(join(tmpdir(), 'nyan-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
test('configuration rejects invalid IDs, speeds and unknown fields without mutating defaults', () => {
  const c = config(); c.speech.speed = 9; assert.throws(() => normalizeConfig(c));
  assert.equal(config().speech.speed, 1); assert.equal(normalizeConfig({ token: 'do not export' }).token, undefined);
  assert.throws(() => normalizeConfig({ bot: { bindings: [{ guildId: 'bad', textChannelIds: [], voiceChannelId: '33333' }] } }));
  assert.throws(() => normalizeConfig({ speech: { engineUrl: 'file:///tmp/run' } }));
});

test('legacy server bindings keep speech and inherit VC notifications, invalid switches are rejected', () => {
  const binding = config().bot.bindings[0];
  assert.equal(binding.readEnabled, true); assert.equal(binding.announceJoinLeave, null);
  for (const fields of [{ readEnabled: 'false' }, { readEnabled: null }, { announceJoinLeave: 'true' }]) assert.throws(() => normalizeConfig({ bot: { bindings: [{ ...binding, ...fields }] } }));
});
test('media allowlist blocks local, credentials, non-HTTP and deceptive domains', () => {
  const allowed = config().media.allowedHosts;
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'file:///tmp/file', 'https://youtube.com.evil.test/', 'https://user:pass@youtube.com', 'https://youtube.com:8443/']) assert.throws(() => validateMediaUrl(url, allowed));
  assert.equal(validateMediaUrl('https://www.nicovideo.jp/watch/sm1', allowed), 'https://www.nicovideo.jp/watch/sm1');
});
test('existing extension commands preserve titles, playback mode and time offsets', () => {
  assert.deepEqual(parseMediaCommand('https://www.youtube.com/watch?v=abc&t=1h2m3s再生\n**【ねこ】**', config()), { url: 'https://www.youtube.com/watch?v=abc&t=1h2m3s', title: 'ねこ', mode: 'preview', startSeconds: 3723 });
  assert.equal(parseMediaCommand('https://youtu.be/abc無限', config()).mode, 'full');
  assert.equal(parseMediaCommand('<https://youtu.be/abc?t=42> 無限', config()).startSeconds, 42);
  assert.equal(parseMediaCommand('普通の会話 https://youtu.be/abc', config()), null);
});
test('versioned commands validate type and offsets', () => {
  const payload = { version: 1, type: 'play', mediaUrl: 'https://cdn.discordapp.com/a.mp3', title: '音声', loop: true, startSeconds: 10 };
  assert.equal(parseMediaCommand('NYANPLAY/1 ' + JSON.stringify(payload), config()).startSeconds, 10);
  assert.throws(() => parseMediaCommand('NYANPLAY/1 ' + JSON.stringify({ ...payload, startSeconds: -1 }), config()));
  assert.throws(() => parseMediaCommand('NYANPLAY/1 {}', config()));
  assert.equal(parseBotCommand('!nyan-other stop', '!nyan'), null);
});
test('bot and webhook policies are independent and enforce binding and exclusions', () => {
  const c = config(), m = message(); m.isBot = true;
  assert.equal(shouldRead(m, c), false); m.webhookId = '55555'; assert.equal(shouldRead(m, c), true);
  c.bot.allowedWebhookIds = ['66666']; assert.equal(shouldRead(m, c), false); c.bot.allowedWebhookIds = [];
  c.speech.enabled = false; assert.equal(shouldRead(m, c), true, 'media may still be received');
  m.channelId = '99999'; assert.equal(shouldRead(m, c), false); m.channelId = '22222';
  c.speech.ignoredUserIds = ['44444']; assert.equal(shouldRead(m, c), false);
});
test('speech resolves mentions, suppresses spoilers and handles attachments', () => {
  const c = config(), m = message(); m.content = '<@55555> ||秘密|| https://example.test/a <a:cat:66666>'; m.mentions = { '55555': 'あお' }; m.attachments = [{ name: 'image.png' }];
  assert.equal(prepareSpeech(m, c), 'ねこ、あお ネタバレ URL 。添付ファイル1件、いまげ.ピーんジー');
  c.speech.maxChars = 4; m.content = '猫😀猫'; assert.equal([...prepareSpeech(m, c)].length, 4);
});
test('dictionary applies only matching scopes and safely handles literal punctuation', () => {
  const entries = normalizeConfig({ dictionary: [{ source: 'C++', replacement: 'シープラスプラス', scope: 'global' }, { source: '猫', replacement: 'にゃん', scope: 'user', scopeId: '44444' }, { source: '猫', replacement: 'ねこ', scope: 'guild', scopeId: '99999' }] }).dictionary;
  assert.equal(applyDictionary('C++と猫', entries, message()), 'シープラスプラスとにゃん');
  assert.throws(() => applyDictionary('猫', [{ source: '(?=猫)', replacement: 'a', regex: true, scope: 'global' }], message()));
});
test('state survives restart, deduplicates messages, and requires explicit retry for interrupted jobs', t => {
  const path = temporary(t), first = new Store(path); first.updateConfig(config());
  assert.equal(first.remember('id'), false); assert.equal(first.remember('id'), true);
  const job = first.enqueue('media', { url: 'https://youtu.be/abc' }); first.changeJob(job.id, { status: 'running' });
  const second = new Store(path); assert.equal(second.jobs[0].status, 'interrupted'); assert.equal(second.remember('id'), true); assert.equal(second.config.bot.bindings.length, 1);
});
test('invalid JSON is preserved before refusing startup', t => {
  const path = temporary(t); writeFileSync(join(path, 'config.json'), '{broken'); assert.throws(() => new Store(path)); assert.ok(readdirSync(path).some(n => n.startsWith('config.json.invalid-'))); assert.equal(readFileSync(join(path, 'config.json'), 'utf8'), '{broken');
});
test('queue executes once in order and isolates failures', async t => {
  const store = new Store(temporary(t)), called = [];
  const jobs = [store.enqueue('speech', { n: 1 }), store.enqueue('speech', { n: 2 }), store.enqueue('speech', { n: 3 })];
  const runner = new JobRunner(store, 'speech', async j => { called.push(j.payload.n); if (j.payload.n === 2) throw new Error('engine unavailable'); });
  const finished = new Promise(resolve => runner.on('idle', () => { if (called.length === 3) resolve(); }));
  await Promise.all([runner.drain(), runner.drain()]); await finished;
  assert.deepEqual(called, [1, 2, 3]); assert.deepEqual(jobs.map(j => j.status), ['completed', 'failed', 'completed']);
});
test('paused queues remain pending and stopping cancels active execution', async t => {
  const store = new Store(temporary(t)); const job = store.enqueue('speech', { text: '猫' });
  const runner = new JobRunner(store, 'speech', (_j, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  runner.pause(); await runner.drain(); assert.equal(job.status, 'waiting');
  const drained = runner.drain(); await drained; runner.pause(false); runner.clear();
  await new Promise(resolve => runner.once('idle', resolve)); assert.equal(job.status, 'cancelled');
  assert.throws(() => runner.cancel(job.id));
});
test('diagnostic logs redact credentials', t => {
  const store = new Store(temporary(t)); const token = 'a'.repeat(25) + '.' + 'b'.repeat(7) + '.' + 'c'.repeat(25);
  store.log('error', token + ' https://discord.com/api/webhooks/12345/private'); assert.ok(!store.logs[0].text.includes(token)); assert.ok(!store.logs[0].text.includes('private'));
});
test('server management pauses and clears only that server queue', async t => {
  const store = new Store(temporary(t)); const a = store.enqueue('speech', { guildId: '11111' }); const b = store.enqueue('speech', { guildId: '99999' });
  const runner = new JobRunner(store, 'speech', async () => {}); runner.pauseGuild('11111', true); await runner.drain();
  assert.equal(a.status, 'waiting'); assert.equal(b.status, 'completed'); runner.clear('99999'); assert.equal(a.status, 'waiting'); runner.clear('11111'); assert.equal(a.status, 'cancelled');
});
