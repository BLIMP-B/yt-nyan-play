import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/desktop/core/store.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';
function setup(t) { const path = mkdtempSync(join(tmpdir(), 'nyan-bot-')); t.after(() => rmSync(path, { recursive: true, force: true })); const store = new Store(path); store.updateConfig({ bot: { bindings: [{ guildId: '11111', textChannelIds: ['22222'], voiceChannelId: '33333' }] } }); const speech = [], media = [], replies = [], controls = []; const bot = new DiscordBot(store, { speech: p => speech.push(p), media: p => media.push(p), control: c => controls.push(c), speakers: async () => [{ name: 'ずんだもん', styles: [{ id: 3 }] }] }); bot.client = { user: { id: '99999' } }; const message = (content, id = '1', admin = false) => ({ id, content, author: { id: '44444', username: '猫', bot: false }, member: { displayName: 'ねこ', roles: { cache: new Map() }, permissions: { has: () => admin } }, guildId: '11111', channelId: '22222', guild: { name: 'サーバー' }, channel: { name: 'テキスト' }, attachments: new Map(), reply: async r => replies.push(r) }); return { store, bot, message, speech, media, replies, controls }; }
test('extension webhook queues media once, without also speaking the command', async t => {
  const s = setup(t); s.store.config.speech.enabled = false; const m = s.message('https://youtu.be/abc再生\n**【猫】**'); m.webhookId = '55555'; m.author.bot = true;
  await s.bot.message(m); await s.bot.message(m); assert.equal(s.media.length, 1); assert.equal(s.speech.length, 0); assert.equal(s.media[0].guildId, '11111');
});
test('management commands require explicit permission and never ping via replies', async t => {
  const s = setup(t); await s.bot.message(s.message('!nyan stop')); assert.equal(s.controls.length, 0); assert.deepEqual(s.replies[0].allowedMentions.parse, []);
  await s.bot.message(s.message('!nyan stop', '2', true)); assert.deepEqual(s.controls, ['stop']);
});
test('invalid self-service command cannot mutate stored profile', async t => {
  const s = setup(t); await s.bot.message(s.message('!nyan speed 9')); assert.equal(s.store.config.speech.profiles.length, 0); assert.match(s.replies[0].content, /話速/);
  await s.bot.message(s.message('!nyan speed 1.2', '2')); assert.equal(s.store.config.speech.profiles[0].speed, 1.2);
});
test('ordinary speech uses template while unconfigured channels and self messages are ignored', async t => {
  const s = setup(t); await s.bot.message(s.message('こんにちは')); assert.equal(s.speech[0].text, 'ねこ、こんにちは');
  const m = s.message('無視', '2'); m.channelId = '77777'; await s.bot.message(m); m.channelId = '22222'; m.author.id = '99999'; await s.bot.message(m); assert.equal(s.speech.length, 1);
});
test('read-channel off persists and suppresses speech while accepting media and admin commands', async t => {
  const s = setup(t);
  await s.bot.message(s.message('!nyan read-channel 22222 off', '1', true));
  assert.deepEqual(s.store.config.bot.bindings[0].disabledTextChannelIds, ['22222']);
  await s.bot.message(s.message('読み上げない', '2'));
  await s.bot.message(s.message('https://youtu.be/abc再生', '3'));
  assert.equal(s.speech.length, 0); assert.equal(s.media.length, 1);
  await s.bot.message(s.message('!nyan read-channel 22222 on', '4', true));
  await s.bot.message(s.message('読み上げる', '5')); assert.equal(s.speech.length, 1);
});
test('master media routing and failed enqueue do not lose retryable incoming requests', async t => {
  const s = setup(t); s.store.config.bot.masterTextChannelId = '22222';
  const handler = s.bot.handlers.media;
  s.bot.handlers.media = () => { throw new Error('queue full'); };
  const m = s.message('https://youtu.be/abc再生');
  await assert.rejects(s.bot.message(m), /queue full/); assert.equal(s.store.seen.includes('message:1'), false);
  s.bot.handlers.media = handler; await s.bot.message(m);
  assert.equal(s.media.length, 1); assert.equal(s.media[0].master, true);
});
