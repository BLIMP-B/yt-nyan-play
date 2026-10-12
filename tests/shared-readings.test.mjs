import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../apps/desktop/core/store.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { parseEducationCommand } from '../apps/desktop/core/education.mjs';
import { readingKey, readingSlots } from '../apps/desktop/core/shared-readings.mjs';
import { prepareSpeech } from '../apps/desktop/core/text.mjs';
import { ChatEducation } from '../apps/desktop/runtime/chat-education.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';

function setup(t) {
  const path = mkdtempSync(join(tmpdir(), 'nyan-shared-readings-')); t.after(() => rmSync(path, { recursive: true, force: true }));
  const store = new Store(path); store.updateConfig({ speech: { readNames: false } });
  return { path, store, service: new ChatEducation(store) };
}
const emoji = '<:erai:1541190483315790015>';
const spoken = (store, text = emoji) => prepareSpeech({ content: text }, store.config);

test('legacy duplicate sources migrate to one value, keeping the previously audible dedicated setting', () => {
  const c = normalizeConfig({ education: [{ source: 'ERAI', reading: '前の教育' }], speech: { emojiReadings: [{ source: ':erai:', replacement: '設定の読み' }] } });
  assert.equal(c.education.length, 1); assert.equal(c.education[0].reading, '設定の読み');
  assert.equal(c.speech.emojiReadings.length, 1); assert.equal(readingSlots(c).length, 1);
  assert.equal(readingKey(emoji), readingKey('ｅｒａｉ'));
});

test('settings then chat, chat then settings, mute and forget overwrite the same slot and survive restart', async t => {
  const { store, service, path } = setup(t);
  const body = 'erai (Sound erai.wav)', bodyBefore = spoken(store, body);
  await service.set('erai', '設定の読み'); assert.equal(spoken(store), '設定の読み');
  assert.equal(spoken(store, body), bodyBefore, 'metadata-only registration must not rename the body');
  assert.equal(prepareSpeech({ content: body }, normalizeConfig({ ...store.config, speech: { ...store.config.speech, bouyomiPreprocess: true } })), body, 'native tag arguments must stay intact');
  await service.apply(parseEducationCommand('教育（ＥＲＡＩ＝チャットの読み）'));
  assert.equal(spoken(store, emoji + ' erai'), 'チャットの読み チャットの読み');
  assert.equal(store.config.speech.emojiReadings[0].replacement, 'チャットの読み');
  await service.set(':erai:', '後の設定'); assert.equal(spoken(store, emoji + ' erai'), '後の設定 後の設定');
  const restored = new Store(path); assert.equal(readingSlots(restored.config).length, 1); assert.equal(spoken(restored), '後の設定');
  await service.apply(parseEducationCommand('無音(erai)')); assert.equal(spoken(store), '');
  await service.apply(parseEducationCommand('忘却（erai）')); assert.equal(spoken(store), 'えらい');
  assert.deepEqual(store.config.education, []); assert.deepEqual(store.config.speech.emojiReadings, []);
});

test('forgetting a settings-only entry never resurrects a shadow reading, and other dictionaries stay intact', async t => {
  const { store, service } = setup(t);
  store.updateConfig({ ...store.config, dictionary: [{ source: '猫猫', replacement: 'ねこ', scope: 'global' }] });
  await service.set(emoji, '設定の読み'); await service.forget(':ERAI:');
  assert.equal(spoken(store), 'えらい'); assert.equal(store.config.dictionary.length, 1);
});

test('JSON changes in either legacy array update the same value, and deleting either side removes the slot', async t => {
  const { store, service } = setup(t); await service.set('erai', '最初'); await service.apply(parseEducationCommand('教育(erai=教育)'));
  let draft = store.exportConfig(); draft.education[0].reading = 'JSON教育';
  await service.saveConfig(draft, c => store.updateConfig(c)); assert.equal(spoken(store), 'JSON教育');
  draft = store.exportConfig(); draft.speech.emojiReadings[0].replacement = 'JSON設定';
  await service.saveConfig(draft, c => store.updateConfig(c)); assert.equal(spoken(store), 'JSON設定');
  draft = store.exportConfig(); draft.speech.emojiReadings = [];
  await service.saveConfig(draft, c => store.updateConfig(c)); assert.equal(spoken(store), 'えらい'); assert.equal(store.config.education.length, 0);
});

test('unrelated stale UI saves preserve chat updates received after the UI snapshot', async t => {
  const { store, service } = setup(t); await service.set('erai', '古い読み');
  const draft = store.exportConfig(); draft.__readingBase = { education: draft.education, speech: { emojiReadings: draft.speech.emojiReadings } }; draft.media.volume = .4;
  await service.apply(parseEducationCommand('教育(erai=新しい読み)'));
  await service.saveConfig(draft, c => store.updateConfig(c)); assert.equal(spoken(store), '新しい読み'); assert.equal(store.config.media.volume, .4);
  await service.saveConfig({ speech: { readNames: false } }, c => store.updateConfig(c)); assert.equal(spoken(store), '新しい読み');
});

test('real Discord message handling updates a settings-created slot and forgetting removes both', async t => {
  const { store, service } = setup(t);
  store.updateConfig({ ...store.config, bot: { ...store.config.bot, bindings: [{ guildId: '11111', textChannelIds: ['22222'], voiceChannelId: '33333' }] } });
  const output = [], bot = new DiscordBot(store, { education: command => service.apply(command), speech: p => output.push(p) }); bot.client = { user: { id: '99999' } }; let id = 0;
  const message = content => ({ id: String(++id), content, author: { id: '44444', username: 'fixture' }, guildId: '11111', channelId: '22222', attachments: new Map(), stickers: new Map(), reply: async () => {} });
  await service.set('erai', '設定'); await bot.message(message('教育（erai＝チャット）')); await bot.message(message(emoji));
  assert.equal(output.at(-1).text, 'チャット'); assert.equal(store.config.speech.emojiReadings[0].replacement, 'チャット');
  await bot.message(message('忘却(erai)')); await bot.message(message(emoji)); assert.equal(output.at(-1).text, 'えらい'); assert.equal(readingSlots(store.config).length, 0);
});

function nativeFixture() {
  const values = new Map(), calls = [], failReadings = new Set();
  const learn = async (type, args, restoring = false) => {
    const index = args.indexOf('='), source = type === 'Study' ? args.slice(0, index) : args, reading = type === 'Study' ? args.slice(index + 1) : '';
    calls.push([type, args]);
    if (!restoring && type !== 'Forget' && ([...source].length > 30 || [...reading].length > 30)) throw new Error('native limit');
    if (failReadings.has(reading)) throw new Error('native write failed');
    if (type === 'Forget') { if (!values.delete(readingKey(source))) throw new Error('native missing'); }
    else values.set(readingKey(source), reading);
    return { text: '保存しました', source, reading, forgot: type === 'Forget' };
  };
  return { values, calls, failReadings,
    lookup: async source => values.has(readingKey(source)) ? { registered: true, source, reading: values.get(readingKey(source)) } : { registered: false, source },
    learn: (type, args) => learn(type, args),
    restore: (type, args) => learn(type, args, true),
  };
}

test('native education, settings and generated tags share one persisted value even when preprocessing is switched off', async t => {
  const { store } = setup(t), native = nativeFixture(); let enabled = true;
  store.updateConfig({ ...store.config, speech: { ...store.config.speech, bouyomiPreprocess: true } });
  const service = new ChatEducation(store, () => enabled ? native : null, () => native);
  await service.set('erai', '設定'); assert.equal(native.calls.length, 0, 'metadata-only setting must not create a native body rule');
  await service.apply(parseEducationCommand('教育(erai=教育)')); assert.equal(native.values.get('ERAI'), '教育'); assert.equal(spoken(store), '教育');
  assert.equal(spoken(store, 'erai'), 'erai', 'native body rules run in the original pipeline rather than twice');
  await service.set('erai', '上書き'); assert.equal(native.values.get('ERAI'), '上書き'); assert.equal(spoken(store), '上書き');
  await service.applyTag('Study', 'erai=タグの読み', new AbortController().signal, native);
  assert.equal(spoken(store), 'タグの読み'); assert.equal(store.config.speech.emojiReadings[0].replacement, 'タグの読み');
  enabled = false; store.updateConfig({ ...store.config, speech: { ...store.config.speech, bouyomiPreprocess: false } });
  await service.set('erai', '切替後'); assert.equal(native.values.get('ERAI'), '切替後'); assert.equal(spoken(store, 'erai'), '切替後');
  await service.forget('erai'); assert.equal(native.values.size, 0); assert.equal(spoken(store), 'えらい');
});

test('settings update and forgetting can find imported native education without an app-side mirror', async t => {
  const { store } = setup(t), native = nativeFixture(); native.values.set('ERAI', '原本');
  const service = new ChatEducation(store, () => native);
  await service.set('erai', '設定'); assert.equal(native.values.get('ERAI'), '設定'); assert.equal(store.config.education[0].native, true);
  await service.forget(emoji); assert.equal(native.values.size, 0); assert.equal(spoken(store), 'えらい');
});

test('failed native writes leave both projections intact and the next operation still works', async t => {
  const { store } = setup(t), native = nativeFixture(), service = new ChatEducation(store, () => native);
  await service.apply(parseEducationCommand('教育(erai=前の読み)')); await service.set('erai', '設定');
  native.failReadings.add('保存エラー');
  await assert.rejects(service.set('erai', '保存エラー'), /native write failed/);
  assert.equal(spoken(store), '設定'); assert.equal(native.values.get('ERAI'), '設定');
  await service.apply(parseEducationCommand('無音(erai)')); assert.equal(spoken(store), ''); assert.equal(native.values.get('ERAI'), '');
});

test('batch config failure rolls back completed native updates as well as the app config', async t => {
  const { store } = setup(t), native = nativeFixture(), service = new ChatEducation(store, () => native);
  await service.apply(parseEducationCommand('教育(erai=最初)')); await service.apply(parseEducationCommand('教育(neko=ねこ)'));
  const draft = store.exportConfig(); draft.education[0].reading = '変更'; draft.education[1].reading = '保存エラー'; native.failReadings.add('保存エラー');
  await assert.rejects(service.saveConfig(draft, c => store.updateConfig(c)), /native write failed/);
  assert.equal(native.values.get('ERAI'), '最初'); assert.equal(store.config.education[0].reading, '最初');
});
test('native education, tags and settings accept one emoji and 30 characters but reject longer changes before writing', async t => {
  const { store } = setup(t), native = nativeFixture(), service = new ChatEducation(store, () => native);
  await service.apply(parseEducationCommand('教育(✅=ちぇっく)')); assert.equal(native.values.get('✅'), 'ちぇっく');
  const reading = 'よ'.repeat(30);
  await service.applyTag('Study', `✅=${reading}`, new AbortController().signal, native);
  assert.equal(native.values.get('✅'), reading);
  await service.set('✅', '🐈'.repeat(30)); assert.equal(native.values.get('✅'), '🐈'.repeat(30));
  const count = native.calls.length;
  await assert.rejects(service.set('✅', 'よ'.repeat(31)), /30文字/); assert.equal(native.calls.length, count);
});
test('a failed batch restores an imported native reading longer than the new registration limit', async t => {
  const { store } = setup(t), native = nativeFixture(), service = new ChatEducation(store, () => native);
  const original = '旧'.repeat(40); native.values.set('ERAI', original);
  store.updateConfig({ ...store.config, education: [{ source: 'erai', reading: original, native: true }] });
  const draft = store.exportConfig(); draft.education[0].reading = '新';
  draft.education.push({ source: 'neko', reading: '保存エラー' }); native.failReadings.add('保存エラー');
  await assert.rejects(service.saveConfig(draft, c => store.updateConfig(c)), /native write failed/);
  assert.equal(native.values.get('ERAI'), original); assert.equal(store.config.education[0].reading, original);
});
