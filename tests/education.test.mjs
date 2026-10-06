import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../apps/desktop/core/store.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { parseEducationCommand, applyEducation } from '../apps/desktop/core/education.mjs';
import { prepareSpeech } from '../apps/desktop/core/text.mjs';
import { ChatEducation } from '../apps/desktop/runtime/chat-education.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'damare-education-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory); store.updateConfig({ bot: { bindings: [{ guildId: '11111', textChannelIds: ['22222'], voiceChannelId: '33333' }] }, speech: { readNames: false } });
  const replies = [], spoken = [], education = new ChatEducation(store); let id = 0;
  const bot = new DiscordBot(store, { education: c => education.apply(c), speech: p => spoken.push(p) }); bot.client = { user: { id: '99999' } };
  const message = content => ({ id: String(++id), content, author: { id: '44444', username: 'user', bot: false }, member: { displayName: 'user', roles: { cache: new Map() } }, guildId: '11111', channelId: '22222', guild: { name: 'test' }, channel: { name: 'text' }, attachments: new Map(), reply: async r => replies.push(r.content) });
  return { directory, store, bot, education, replies, spoken, message };
}
test('Discord education supports every half/full width bracket and equals combination without broadcaster mode or imported files', async t => {
  const f = setup(t);
  for (const left of ['(', '（']) for (const right of [')', '）']) for (const equals of ['=', '＝']) {
    await f.bot.message(f.message(`教育${left}猫猫${equals}ねこ${right}`));
    assert.equal(f.store.config.education.length, 1); assert.equal(f.store.config.education[0].reading, 'ねこ');
    await f.bot.message(f.message('猫猫')); assert.equal(f.spoken.at(-1).text, 'ねこ');
  }
  assert.equal(f.replies.length, 8); assert.equal(f.spoken.filter(p => p.literal).length, 8);
});
test('mute removes the word, persists over restart, and forgetting restores normal pronunciation without deleting ordinary dictionaries', async t => {
  const f = setup(t);
  f.store.updateConfig({ ...f.store.config, dictionary: [{ source: '猫猫', replacement: 'こてい', scope: 'global', regex: false }] });
  await f.bot.message(f.message('無音（猫猫)')); await f.bot.message(f.message('猫猫こんにちは')); assert.equal(f.spoken.at(-1).text, 'こんにちは');
  const count = f.spoken.length; await f.bot.message(f.message('猫猫')); assert.equal(f.spoken.length, count);
  const restored = new Store(f.directory); assert.equal(applyEducation('猫猫', restored.config.education), '');
  await f.bot.message(f.message('忘却(猫猫）')); await f.bot.message(f.message('猫猫')); assert.equal(f.spoken.at(-1).text, 'こてい'); assert.equal(f.store.config.dictionary.length, 1);
});
test('education overwrite, same-reading forgetting, literal replacements and English boundaries match the intended dictionary behavior', async t => {
  const f = setup(t);
  await f.education.apply(parseEducationCommand('教育（cat＝ねこ）')); assert.equal(applyEducation('CAT cat ＣＡＴ catalog', f.store.config.education), 'ねこ ねこ ねこ catalog');
  await f.education.apply(parseEducationCommand('教育(cat=$&)')); assert.equal(applyEducation('cat', f.store.config.education), '$&');
  await f.education.apply(parseEducationCommand('教育（ＣＡＴ＝cat）')); assert.equal(f.store.config.education.length, 0);
  assert.equal(parseEducationCommand('(Study 猫猫=ねこ)'), null);
});
test('Discord education and forgetting preserve specified readings before the romaji fallback', async t => {
  const f = setup(t);
  await f.bot.message(f.message('ka n N')); assert.equal(f.spoken.at(-1).text, 'か ん エヌ');
  await f.bot.message(f.message('教育（nyan＝CAT）'));
  await f.bot.message(f.message('NYAN ka n')); assert.equal(f.spoken.at(-1).text, 'CAT か ん');
  await f.bot.message(f.message('忘却(nyan)'));
  await f.bot.message(f.message('nyan')); assert.equal(f.spoken.at(-1).text, 'にゃん');
});
test('education follows read-channel and user policy, deduplicates messages, and reports malformed input', async t => {
  const f = setup(t), first = f.message('教育(猫猫=ねこ)'); await f.bot.message(first); const count = f.spoken.length; await f.bot.message(first); assert.equal(f.spoken.length, count);
  await f.bot.message(f.message('教育(猫猫)')); assert.match(f.replies.at(-1), /区切って/); assert.equal(f.store.config.education[0].reading, 'ねこ');
  f.store.updateConfig({ ...f.store.config, speech: { ...f.store.config.speech, ignoredUserIds: ['44444'] } }); await f.bot.message(f.message('忘却(猫猫)')); assert.equal(f.store.config.education.length, 1);
  f.store.updateConfig({ ...f.store.config, speech: { ...f.store.config.speech, ignoredUserIds: [] }, bot: { ...f.store.config.bot, bindings: [{ ...f.store.config.bot.bindings[0], readEnabled: false }] } }); await f.bot.message(f.message('忘却(猫猫)')); assert.equal(f.store.config.education.length, 1);
});
test('native education uses the original Study/Forget/Mute API and only removes matching fallback education after success', async t => {
  const f = setup(t), calls = []; await f.education.apply(parseEducationCommand('教育(猫猫=前の読み)'));
  const native = new ChatEducation(f.store, () => ({ learn: async (type, args) => { calls.push([type, args]); return { text: '保存しました' }; } }));
  for (const text of ['教育（猫猫＝ねこ）', '無音(猫猫)', '忘却（猫猫）']) await native.apply(parseEducationCommand(text));
  assert.deepEqual(calls, [['Study', '猫猫=ねこ'], ['Mute', '猫猫'], ['Forget', '猫猫']]); assert.deepEqual(f.store.config.education, []);
  await f.education.apply(parseEducationCommand('教育(猫猫=ねこ)'));
  const failed = new ChatEducation(f.store, () => ({ learn: async () => { throw new Error('write failed'); } }));
  await assert.rejects(failed.apply(parseEducationCommand('忘却(猫猫)')), /write failed/); assert.equal(f.store.config.education.length, 1);
});
test('old configs enable chat education by default; native provider receives fallback readings too', () => {
  const c = normalizeConfig({ speech: { provider: 'bouyomi', readNames: false }, education: [{ source: '猫猫', reading: 'ねこ' }] }); assert.equal(c.speech.chatEducationEnabled, true);
  assert.equal(prepareSpeech({ content: '猫猫' }, c), 'ねこ');
  assert.throws(() => normalizeConfig({ education: [{ source: 'a\tb', reading: 'x' }] }));
});
