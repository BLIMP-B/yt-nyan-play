import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/desktop/core/store.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { parseEducationCommand } from '../apps/desktop/core/education.mjs';
import { convertedMedia } from '../apps/desktop/core/media-conversions.mjs';
import { ChatEducation } from '../apps/desktop/runtime/chat-education.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';

const url = 'https://youtu.be/ro_v7LqdI58?t=12&si=a=b';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'damare-conversion-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory), education = new ChatEducation(store), media = [], speech = [], replies = [];
  store.updateConfig({ bot: { autoLeave: false, bindings: [{ guildId: '11111', voiceChannelId: '33333', textChannelIds: ['22222'] }, { guildId: '55555', voiceChannelId: '66666', textChannelIds: ['77777'] }] } });
  const bot = new DiscordBot(store, { education: c => education.apply(c), media: p => media.push(p), speech: p => speech.push(p) }); bot.client = { user: { id: '99999' } };
  let count = 0;
  const message = (content, channelId = '22222', guildId = '11111') => ({ id: String(++count), content, author: { id: '44444', username: 'user', bot: false }, member: { nickname: '猫', roles: { cache: new Map() } }, guildId, channelId, attachments: new Map(), stickers: new Map(), reply: async r => replies.push(r.content) });
  const register = (source = '✅', target = url) => bot.message(message(`変換（${source}＝${target}）`));
  return { store, directory, education, bot, media, speech, replies, message, register };
}
test('conversion tags support mixed delimiters, query equals and literal URL parentheses without the reading-length limit', async t => {
  const f = fixture(t);
  for (const left of ['(', '（']) for (const right of [')', '）']) for (const eq of ['=', '＝']) {
    await f.bot.message(f.message(`変換${left}✅${eq}${url}${right}`));
    assert.deepEqual(f.store.config.mediaConversions, [{ source: '✅', url }]);
  }
  const target = 'https://cdn.discordapp.com/attachments/123/a_(b).mp3?signature=' + 'a'.repeat(80);
  await f.register('😀'.repeat(30), target); assert.equal(f.store.config.mediaConversions.length, 2);
  const saved = f.store.exportConfig();
  await f.register('😀'.repeat(31)); assert.match(f.replies.at(-1), /30文字/); assert.deepEqual(f.store.config, saved);
  assert.deepEqual(new Store(f.directory).config.mediaConversions, saved.mediaConversions);
  assert.equal(f.media.length, 0, 'registration must never play its URL');
});
test('a containing message plays once, directly, at the URL offset, rather than speaking the command or the body', async t => {
  const f = fixture(t); await f.register(); f.speech.length = 0;
  const message = f.message('前の文✅✅後の文'); await f.bot.message(message); await f.bot.message(message);
  assert.equal(f.media.length, 1); assert.equal(f.speech.length, 0);
  assert.equal(f.media[0].mode, 'direct'); assert.equal(f.media[0].url, url); assert.equal(f.media[0].startSeconds, 12);
  assert.equal(f.media[0].guildId, '11111'); assert.equal(f.media[0].master, false);
  await f.bot.message(f.message('✅', '33333')); assert.equal(f.media.at(-1).guildId, '11111');
  await f.bot.message(f.message('✅', '77777', '55555')); assert.equal(f.media.at(-1).guildId, '55555');
  f.store.updateConfig({ ...f.store.config, bot: { ...f.store.config.bot, masterTextChannelId: '22222' } });
  await f.bot.message(f.message('✅')); assert.equal(f.media.at(-1).master, true);
});
test('custom/Unicode emoji, sticker names and speaker names convert before native education changes the reading', async t => {
  const f = fixture(t); await f.register('nyan');
  f.store.updateConfig({ ...f.store.config, speech: { ...f.store.config.speech, bouyomiPreprocess: true }, education: [{ source: 'nyan', reading: 'ねこ', native: true }] });
  await f.bot.message(f.message('前<:nyan:123456>後')); assert.equal(f.media.length, 1);
  const sticker = f.message(''); sticker.stickers.set('1', { id: '123456', name: 'nyan' }); await f.bot.message(sticker); assert.equal(f.media.length, 2);
  const named = f.message('本文'); named.member.nickname = 'nyan'; await f.bot.message(named); assert.equal(f.media.length, 3);
  await f.register('猫');
  const guild = { id: '11111', name: '試験' }, member = { nickname: '猫', user: { username: 'user', bot: false } };
  f.store.config.bot.announceJoinLeave = true;
  await f.bot.voiceState({ channelId: null, guild }, { channelId: '33333', channel: { name: '作業部屋' }, guild, member, id: '44444' });
  assert.equal(f.media.length, 4); assert.equal(f.media.at(-1).master, false);
});
test('normalization keeps Latin word boundaries and chooses the first occurrence with a longest-match tie', async t => {
  const f = fixture(t); await f.register('cat'); await f.register('猫'); await f.register('猫さん', 'https://nico.ms/sm9');
  const c = f.store.config;
  assert.equal(convertedMedia({ content: 'catalog', channelId: '22222' }, c), null);
  assert.equal(convertedMedia({ content: 'ＣＡＴ 猫さん' }, c).url, url);
  assert.equal(convertedMedia({ content: '猫さん cat' }, c).url, 'https://nico.ms/sm9');
  assert.equal(convertedMedia({ content: '別の文章' }, c, '猫さん').url, 'https://nico.ms/sm9');
});
test('read switches, sender filters and hidden metadata do not start converted playback', async t => {
  const f = fixture(t); await f.register();
  const base = f.store.exportConfig();
  for (const content of ['||✅||', '```✅```', 'https://youtu.be/✅']) await f.bot.message(f.message(content));
  f.store.updateConfig({ ...base, speech: { ...base.speech, bouyomiPreprocess: true } });
  for (const content of ['||✅||', '```✅```', 'https://youtu.be/✅']) await f.bot.message(f.message(content));
  f.store.updateConfig({ ...base, speech: { ...base.speech, maxChars: 3 } }); await f.bot.message(f.message('あいう✅'));
  f.store.updateConfig(base);
  const attachment = f.message('本文'); attachment.attachments.set('x', { name: '✅.png' }); await f.bot.message(attachment);
  const outsider = f.message('✅', '88888'); await f.bot.message(outsider);
  for (const patch of [{ enabled: false }, { chatEducationEnabled: false }, { readEmoji: false }, { ignoredUserIds: ['44444'] }]) {
    f.store.updateConfig({ ...base, speech: { ...base.speech, ...patch } }); await f.bot.message(f.message('✅'));
  }
  f.store.updateConfig({ ...base, bot: { ...base.bot, bindings: base.bot.bindings.map(b => ({ ...b, readEnabled: false })) } }); await f.bot.message(f.message('✅'));
  f.store.updateConfig({ ...base, media: { ...base.media, enabled: false } }); await f.bot.message(f.message('✅'));
  assert.equal(f.media.length, 0);
  f.store.updateConfig(base); await f.bot.message(f.message('✅')); assert.equal(f.media.length, 1);
});
test('forget removes conversion and same-word education, while stale settings cannot resurrect or overwrite chat edits', async t => {
  const f = fixture(t); await f.register();
  const stale = f.store.exportConfig(); stale.__readingBase = f.store.exportConfig();
  await f.register('✅', 'https://nico.ms/sm9');
  await f.education.saveConfig(stale, c => f.store.updateConfig(c)); assert.equal(f.store.config.mediaConversions[0].url, 'https://nico.ms/sm9');
  await f.education.set('✅', 'ちぇっく'); await f.bot.message(f.message('忘却（✅）'));
  assert.equal(f.store.config.mediaConversions.length, 0); assert.equal(f.store.config.education.length, 0);
  await f.education.saveConfig(stale, c => f.store.updateConfig(c)); assert.equal(f.store.config.mediaConversions.length, 0);
  await f.register(); await f.bot.message(f.message('忘却(✅)')); assert.equal(f.store.config.mediaConversions.length, 0);
  await f.bot.message(f.message('✅')); assert.equal(f.media.length, 0);
});
test('invalid URLs and failed saves preserve mappings; disabled education cannot execute URL arguments', async t => {
  const f = fixture(t); await f.register(); const before = f.store.exportConfig();
  for (const target of ['file:///C:/x.mp3', 'http://127.0.0.1/a.mp3', 'https://youtu.be.evil.test/a', 'https://u:p@youtu.be/a']) await f.register('✅', target);
  assert.deepEqual(f.store.config, before);
  for (const input of ['変換（✅）', '変換（＝https://youtu.be/a）', '変換(✅=)', '変換(✅=https://youtu.be/a']) assert.throws(() => parseEducationCommand(input));
  const update = f.store.updateConfig; f.store.updateConfig = () => { throw Error('disk full'); };
  await assert.rejects(f.education.apply(parseEducationCommand('変換(✅=https://nico.ms/sm9)')), /disk full/); assert.deepEqual(f.store.config, before); f.store.updateConfig = update;
  f.store.config.speech.chatEducationEnabled = false;
  await f.bot.message(f.message('変換（✅=https://youtu.be/a直接 ）')); assert.equal(f.media.length, 0);
  assert.deepEqual(normalizeConfig({}).mediaConversions, []);
});
test('settings snapshots preserve custom allowed hosts when validating converted URLs', async t => {
  const f = fixture(t);
  f.store.updateConfig({ ...f.store.config, media: { ...f.store.config.media, allowedHosts: [...f.store.config.media.allowedHosts, 'media.example.test'] } });
  await f.register('✅', 'https://media.example.test/audio.mp3');
  const c = f.store.exportConfig();
  c.__readingBase = structuredClone({ education: c.education, mediaConversions: c.mediaConversions, media: { allowedHosts: c.media.allowedHosts }, speech: { emojiReadings: c.speech.emojiReadings } });
  c.mediaConversions.push({ source: '猫', url: 'https://media.example.test/cat.mp3' });
  await f.education.saveConfig(c, next => f.store.updateConfig(next));
  assert.equal(f.store.config.mediaConversions.length, 2);
  c.mediaConversions = [];
  c.media.allowedHosts = c.media.allowedHosts.filter(h => h !== 'media.example.test');
  c.__readingBase.mediaConversions = f.store.config.mediaConversions;
  await f.education.saveConfig(c, next => f.store.updateConfig(next));
  assert.equal(f.store.config.mediaConversions.length, 0);
});
test('forget removes a conversion and unmirrored native education atomically', async t => {
  const f = fixture(t), calls = []; await f.register();
  const native = { lookup: async () => ({ registered: true, source: '✅', reading: 'ちぇっく' }), learn: async (type, source) => { calls.push([type, source]); return { forgot: true, text: '忘れました' }; } };
  const education = new ChatEducation(f.store, () => native);
  await education.apply(parseEducationCommand('忘却(✅)'));
  assert.deepEqual(calls, [['Forget', '✅']]); assert.equal(f.store.config.mediaConversions.length, 0);
  await f.register(); native.learn = async () => { throw Error('native write failed'); };
  await assert.rejects(education.apply(parseEducationCommand('忘却(✅)')), /native write failed/);
  assert.equal(f.store.config.mediaConversions.length, 1);
});
test('failed media enqueue remains retryable and does not speak the conversion body', async t => {
  const f = fixture(t); await f.register(); f.speech.length = 0;
  const handler = f.bot.handlers.media; f.bot.handlers.media = () => { throw Error('queue full'); };
  const message = f.message('✅'); await assert.rejects(f.bot.message(message), /queue full/);
  assert.ok(!f.store.seen.includes('message:' + message.id)); assert.equal(f.speech.length, 0);
  f.bot.handlers.media = handler; await f.bot.message(message); assert.equal(f.media.length, 1);
});
