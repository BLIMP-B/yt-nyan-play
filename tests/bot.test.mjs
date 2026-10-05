import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/desktop/core/store.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';
import { PermissionFlagsBits, Events } from 'discord.js';
import { EventEmitter } from 'node:events';
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
test('plain ていし is scoped, deduplicated and received with speech disabled without admin permission', async t => {
  const s = setup(t), stopped = []; s.bot.handlers.stopRequested = payload => stopped.push(payload);
  s.store.config.speech.enabled = false; s.store.config.bot.bindings[0].disabledTextChannelIds = ['22222'];
  const m = s.message(' ていし '); await s.bot.message(m); await s.bot.message(m);
  assert.deepEqual(stopped, [{ guildId: '11111', master: false }]); assert.equal(s.speech.length, 0);
  s.store.config.bot.masterTextChannelId = '22222'; await s.bot.message(s.message('ていし', '2')); assert.equal(stopped[1].master, true);
  const unregistered = s.message('ていし', '3'); unregistered.channelId = '77777'; await s.bot.message(unregistered); assert.equal(stopped.length, 2);
});
test('VC text is read and can be disabled through read-channel', async t => {
  const s = setup(t), m = s.message('VC内の会話'); m.channelId = '33333'; await s.bot.message(m); assert.equal(s.speech.length, 1);
  const control = s.message('!nyan read-channel 33333 off', '2', true); control.channelId = '33333'; await s.bot.message(control);
  const disabled = s.message('読まない', '3'); disabled.channelId = '33333'; await s.bot.message(disabled); assert.equal(s.speech.length, 1);
});
test('VC join, move and leave are announced for the configured channel only', async t => {
  const s = setup(t); s.store.config.bot.announceJoinLeave = true; s.store.config.bot.autoLeave = false;
  const guild = { id: '11111', name: 'サーバー', channels: { cache: new Map() } }, member = { displayName: 'ねこ', user: { username: '猫', bot: false } };
  const state = (id, name) => ({ channelId: id, channel: id ? { name } : null, guild, member, id: '44444' });
  await s.bot.voiceState(state(null), state('33333', 'VC')); await s.bot.voiceState(state('33333', 'VC'), state('55555', '別VC')); await s.bot.voiceState(state('33333', 'VC'), state(null));
  await s.bot.voiceState(state('55555', '別VC'), state('66666', '無関係'));
  assert.deepEqual(s.speech.map(p => p.text), ['ねこがVCに参加しました', 'ねこがVCから別VCへ移動しました', 'ねこがVCから退出しました']);
});
test('Bot activity prioritizes master then newest media, reverts on end and clears on stop', t => {
  const s = setup(t), presence = []; s.bot.status = 'online'; s.bot.client.user.setPresence = p => presence.push(p);
  const a = { scope: '11111', startedAt: 1, title: '猫', service: 'YouTube' }, b = { scope: '22222', startedAt: 2, title: '音楽', service: 'ニコニコ動画', audioOnly: true }, master = { scope: 'master', startedAt: 1, title: '共通', service: 'X' };
  s.bot.updateMediaActivity([a, b]); assert.equal(presence.at(-1).activities[0].name, 'ニコニコ動画：音楽'); assert.equal(presence.at(-1).activities[0].type, 2);
  s.bot.updateMediaActivity([a, b]); assert.equal(presence.length, 1);
  s.bot.updateMediaActivity([a, b, master]); assert.equal(presence.at(-1).activities[0].name, 'X：共通');
  s.bot.updateMediaActivity([a]); assert.equal(presence.at(-1).activities[0].name, 'YouTube：猫'); assert.equal(presence.at(-1).activities[0].type, 3);
  s.bot.updateMediaActivity([{ ...a, paused: true }]); assert.match(presence.at(-1).activities[0].name, /一時停止/);
  s.bot.updateMediaActivity([]); assert.deepEqual(presence.at(-1).activities, []);
});

test('server speech mute preserves media commands and master speech and stays isolated', async t => {
  const s = setup(t); const config = s.store.exportConfig();
  config.bot.bindings[0].readEnabled = false;
  config.bot.bindings.push({ guildId: '55555', voiceChannelId: '66666', textChannelIds: ['77777'] });
  s.store.updateConfig(config);
  await s.bot.message(s.message('このサーバーでは読まない', 'server-off'));
  await s.bot.message(s.message('https://youtu.be/abc再生', 'media-still-on'));
  const other = s.message('別サーバーは読む', 'other'); other.guildId = '55555'; other.channelId = '77777';
  await s.bot.message(other); assert.equal(s.speech.length, 1); assert.equal(s.media.length, 1);
  const master = s.store.exportConfig(); master.bot.masterTextChannelId = '22222'; s.store.updateConfig(master);
  await s.bot.message(s.message('マスタは読む', 'master')); assert.equal(s.speech.length, 2);
  const loaded = new Store(s.store.directory); assert.equal(loaded.config.bot.bindings[0].readEnabled, false);
  assert.equal(loaded.config.bot.bindings[1].readEnabled, true);
});

test('per-server VC notifications override global defaults independently from chat speech', async t => {
  const s = setup(t); s.store.config.bot.autoLeave = false;
  const guild = { id: '11111', name: 'サーバー', channels: { cache: new Map() } };
  const member = { displayName: 'ねこ', user: { username: '猫', bot: false } };
  const state = id => ({ channelId: id, channel: id ? { name: 'VC' } : null, guild, member, id: '44444' });
  s.store.config.bot.bindings[0].readEnabled = false; s.store.config.bot.bindings[0].announceJoinLeave = true;
  await s.bot.voiceState(state(null), state('33333')); assert.equal(s.speech.length, 1);
  s.store.config.bot.announceJoinLeave = true; s.store.config.bot.bindings[0].announceJoinLeave = false;
  await s.bot.voiceState(state('33333'), state(null)); assert.equal(s.speech.length, 1);
  s.store.config.bot.bindings[0].announceJoinLeave = null;
  await s.bot.voiceState(state(null), state('33333')); assert.equal(s.speech.length, 2);
});

test('catalog supplies category names and Bot permission checks and refreshes on channel changes', async t => {
  const s = setup(t); let name = '雑談';
  const channel = (id, voice, allowed) => ({ id, get name() { return name; }, parentId: '88888', parent: { name: '共有', position: 2 }, position: voice ? 2 : 1,
    isTextBased: () => true, isVoiceBased: () => voice, permissionsFor: user => { assert.equal(user.id, '99999'); return { has: bits => (allowed & bits) === bits }; } });
  const all = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect | PermissionFlagsBits.Speak;
  const client = new EventEmitter(); Object.assign(client, { isReady: () => true, user: { id: '99999' }, guilds: { cache: new Map([['11111', { id: '11111', name: 'サーバー', channels: { cache: new Map([
    ['22222', channel('22222', false, PermissionFlagsBits.ViewChannel)], ['33333', channel('33333', true, all)], ['55555', channel('55555', true, 0n)],
  ]) } }]]) }, login: async () => {}, destroy: () => {} });
  s.bot.client = null; s.bot.clientFactory = () => client; await s.bot.start('fixture');
  const channels = s.bot.catalog()[0].channels;
  assert.equal(channels[0].parentName, '共有'); assert.equal(channels[0].canRead, true);
  assert.equal(channels[1].canConnect, true); assert.equal(channels[2].canRead, false); assert.equal(channels[2].canConnect, false);
  let changes = 0; s.store.on('change', () => changes++); name = '更新した名前'; client.emit(Events.ChannelUpdate);
  assert.equal(changes, 1); assert.equal(s.bot.catalog()[0].channels[0].name, '更新した名前'); s.bot.stop();
});
