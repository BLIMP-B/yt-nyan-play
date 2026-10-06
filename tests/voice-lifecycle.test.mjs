import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Events } from 'discord.js';
import { Store } from '../apps/desktop/core/store.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';
import { VoiceOutput } from '../apps/desktop/runtime/voice-output.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { hasHumanListeners } from '../apps/desktop/core/voice-audience.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-voice-')), store = new Store(dir), joined = [], left = [], spoken = [];
  const client = new EventEmitter(); Object.assign(client, { isReady: () => true, user: { id: '99999' }, guilds: { cache: new Map() }, login: async () => {}, destroy: () => {} });
  const bot = new DiscordBot(store, { join: async id => joined.push(id), leave: async id => left.push(id), speech: p => spoken.push(p) }, () => client); bot.client = client;
  t.after(() => { bot.stop(); rmSync(dir, { recursive: true, force: true }); });
  const guild = (id, channelId, humans = 0, bots = 0) => {
    const members = new Map(); for (let i = 0; i < humans + bots; i++) members.set(String(44444 + i), { id: String(44444 + i), displayName: '猫', user: { bot: i >= humans, username: 'ねこ' } });
    const channel = { id: channelId, name: 'VC', members };
    const g = { id, name: 'サーバー', channels: { cache: new Map([[channelId, channel]]) }, voiceStates: { cache: new Map([...members].map(([id, member]) => [id, { id, member, channelId }])) } };
    client.guilds.cache.set(id, g); return g;
  };
  store.updateConfig({ bot: { autoJoin: true, autoLeave: true, bindings: [{ guildId: '11111', voiceChannelId: '33333', textChannelIds: [] }] } });
  const state = (guild, channelId, id = '44444', bot = false) => ({ id, guild, channelId, channel: guild.channels.cache.get(channelId), member: { displayName: '猫', user: { bot, username: 'ねこ' } } });
  return { store, client, bot, joined, left, spoken, guild, state };
}
test('startup joins occupied VCs, leaves empty or Bot-only VCs and isolates failed servers', async t => {
  const s = setup(t); s.guild('11111', '33333', 1); s.guild('55555', '66666', 0, 2); s.guild('77777', '88888', 1);
  const c = s.store.exportConfig(); c.bot.bindings.push({ guildId: '55555', voiceChannelId: '66666', textChannelIds: [] }, { guildId: '77777', voiceChannelId: '88888', textChannelIds: [] }); s.store.updateConfig(c);
  const original = s.bot.handlers.join; s.bot.handlers.join = async id => { if (id === '11111') throw new Error('接続権限がありません'); return original(id); };
  let ready = false; s.bot.handlers.ready = () => { ready = true; }; s.bot.client = null; await s.bot.start('fixture'); s.client.emit(Events.ClientReady);
  for (let i = 0; i < 20 && !ready; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, true); assert.deepEqual(s.joined, ['77777']); assert.deepEqual(s.left, ['55555']); assert.match(s.store.logs.map(l => l.text).join('\n'), /11111.*接続権限/);
});
test('human joins/moves trigger the configured VC only; mute changes and other Bots do not join', async t => {
  const s = setup(t), g = s.guild('11111', '33333', 1);
  let changes = 0; s.store.on('change', () => changes++);
  await s.bot.voiceState(s.state(g, null), s.state(g, '33333')); assert.deepEqual(s.joined, ['11111']); assert.ok(changes > 0, 'connection completion must refresh the UI');
  await s.bot.voiceState(s.state(g, '33333'), s.state(g, '33333')); assert.equal(s.joined.length, 1);
  await s.bot.voiceState(s.state(g, null, '55555', true), s.state(g, '33333', '55555', true)); assert.equal(s.joined.length, 1);
  await s.bot.voiceState(s.state(g, '77777'), s.state(g, '88888')); assert.equal(s.joined.length, 1);
});
test('last human departure ignores a stale member cache and leaves before announcing or reconnecting', async t => {
  const s = setup(t), g = s.guild('11111', '33333', 1, 1); s.store.config.bot.announceJoinLeave = true;
  await s.bot.voiceState(s.state(g, '33333'), s.state(g, null));
  assert.deepEqual(s.left, ['11111']); assert.equal(s.spoken.length, 0); assert.equal(s.joined.length, 0);
  g.voiceStates.cache.delete('44444'); await s.bot.reconcileVoices(); assert.equal(s.left.length, 2);
});
test('join in flight is cancelled immediately when the last human leaves, with no later rejoin', async t => {
  const s = setup(t), g = s.guild('11111', '33333', 1); let finish, entered;
  const starting = new Promise(resolve => { entered = resolve; });
  s.bot.handlers.join = async () => { entered(); await new Promise(resolve => { finish = resolve; }); };
  const joining = s.bot.voiceState(s.state(g, null), s.state(g, '33333')); await starting;
  g.voiceStates.cache.clear(); g.channels.cache.get('33333').members.clear();
  await s.bot.voiceState(s.state(g, '33333'), s.state(g, null)); assert.deepEqual(s.left, ['11111']);
  finish(); await joining; await s.bot.reconcileVoices(); assert.equal(s.joined.length, 0); assert.equal(s.spoken.length, 0);
});
test('enabling settings/resuming reconciles current humans; disabling toggles stops automatic actions', async t => {
  const s = setup(t), g = s.guild('11111', '33333', 0, 1); s.store.config.bot.autoJoin = false; s.store.config.bot.autoLeave = false;
  await s.bot.reconcileVoices(); assert.equal(s.left.length, 0);
  g.voiceStates.cache.set('44444', s.state(g, '33333')); s.store.config.bot.autoJoin = true; await s.bot.reconcileVoices(); assert.deepEqual(s.joined, ['11111']);
  s.bot.client = null; await s.bot.start('fixture'); s.client.emit(Events.ShardResume); await new Promise(resolve => setImmediate(resolve)); assert.equal(s.joined.length, 2);
  s.bot.stop(); assert.equal(s.bot.voiceTimer, null); await s.bot.reconcileVoices(); assert.equal(s.joined.length, 2);
});
test('audience counts humans across authoritative voice states and channel-member fallback', () => {
  const members = new Map([['human', { id: 'human', user: { bot: false } }], ['bot', { id: 'bot', user: { bot: true } }]]), guild = { channels: { cache: new Map([['vc', { members }]]) } };
  assert.equal(hasHumanListeners(guild, 'vc'), true); members.delete('human'); assert.equal(hasHumanListeners(guild, 'vc'), false);
  assert.equal(hasHumanListeners({}, 'vc'), null);
});
test('disconnect/close cancels pending channel fetches and an old completion cannot erase a new connection task', async () => {
  let resolveFirst, resolveSecond, count = 0;
  const client = { isReady: () => true, channels: { fetch: () => new Promise(resolve => { if (++count === 1) resolveFirst = resolve; else resolveSecond = resolve; }) } };
  const c = normalizeConfig({ bot: { bindings: [{ guildId: '11111', voiceChannelId: '33333', textChannelIds: [] }] } }), output = new VoiceOutput(() => client, () => c, () => {});
  const old = output.connect('11111'); output.disconnect('11111'); const next = output.connect('11111');
  resolveFirst({}); await assert.rejects(old, { name: 'AbortError' }); assert.equal(output.connecting.size, 1);
  output.close(); resolveSecond({}); await assert.rejects(next, { name: 'AbortError' }); assert.equal(output.connecting.size, 0); assert.equal(output.connections.size, 0);
});
test('automatic audio cannot reopen an empty VC; other guild listeners cannot satisfy that audience check', async () => {
  const guild = { channels: { cache: new Map([['33333', { members: new Map([['bot', { id: 'bot', user: { bot: true } }]]) }]]) } };
  const channel = { guildId: '11111', guild, isVoiceBased: () => true }, client = { isReady: () => true, channels: { fetch: async () => channel } };
  const c = normalizeConfig({ bot: { bindings: [{ guildId: '11111', voiceChannelId: '33333', textChannelIds: [] }] } }), output = new VoiceOutput(() => client, () => c, () => {});
  await assert.rejects(output.connect('11111'), /人がいる/); assert.equal(output.connections.size, 0);
});
test('leaving one VC detaches its scheduled chime while the other guild continues; global cancellation still propagates', async () => {
  const output = new VoiceOutput(() => null, () => normalizeConfig(), () => {}), finished = new Map();
  output.connect = async guildId => ({ mixer: { addSpeech: (_pcm, _volume, signal) => new Promise((resolve, reject) => { finished.set(guildId, resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) } });
  const a = output.pcm('11111', Buffer.alloc(3840), 1), b = output.pcm('22222', Buffer.alloc(3840), 1);
  await new Promise(resolve => setImmediate(resolve)); output.disconnect('11111'); await a;
  assert.equal(output.pcmControllers.has('11111'), false); assert.equal(output.pcmControllers.has('22222'), true);
  finished.get('22222')(); await b;
  const controller = new AbortController(), c = output.pcm('33333', Buffer.alloc(3840), 1, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(c, { name: 'AbortError' }); assert.equal(output.pcmControllers.size, 0);
});
