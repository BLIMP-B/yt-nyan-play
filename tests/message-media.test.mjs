import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { attachmentKind } from '../apps/desktop/core/message-media.mjs';
import { prepareSpeech, prepareNativeText } from '../apps/desktop/core/text.mjs';
import { Store } from '../apps/desktop/core/store.mjs';
import { ChatEducation } from '../apps/desktop/runtime/chat-education.mjs';
import { DiscordBot } from '../apps/desktop/runtime/bot.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config = patch => normalizeConfig({ ...patch, speech: { readNames: false, ...patch?.speech } });

test('attachments speak their type, prioritize the real extension and never leak names', () => {
  const c = config(), message = { content: '添付です', attachments: [
    { name: '秘密の住所.JPG', contentType: 'audio/mpeg' }, { name: '個人情報.MP4' }, { name: '非公開.OPUS' }, { name: 'archive.tar.gz' }, { name: '履歴.PDF' }, { name: 'unknown.zzz' },
  ] };
  assert.equal(prepareSpeech(message, c), '添付です。添付ファイル6件、画像ファイル、動画ファイル、音声ファイル、圧縮ファイル、文書ファイル、ファイル');
  assert.equal(attachmentKind({ name: 'opaque', contentType: 'audio/ogg; codecs=opus' }), '音声ファイル');
  assert.equal(attachmentKind({ name: 'clip.ＭＰ４' }), '動画ファイル');
  message.attachments = [{ name: 'secret.mp4', spoiler: true }];
  assert.equal(prepareSpeech(message, c), '添付です。添付ファイル1件、ネタバレ');
  c.speech.readAttachments = false; assert.equal(prepareSpeech(message, c), '添付です');
});

test('custom emoji and stickers romanize names and use configured token, name and ID readings', () => {
  const message = { content: '<:nyan:12345> <a:ka:12346>', stickers: [{ id: '12347', name: 'neko' }] }, c = config();
  assert.equal(prepareSpeech(message, c), 'にゃん か。スタンプ、ねこ');
  c.speech.emojiReadings = [{ source: '<:nyan:12345>', replacement: 'CAT' }, { source: '12346', replacement: 'DOG' }, { source: 'neko', replacement: 'ABC' }];
  c.education = [{ source: '無関係', reading: '別の読み' }, { source: 'CAT', reading: '別の教育' }];
  assert.equal(prepareSpeech(message, c), 'CAT DOG。スタンプ、ABC', 'NFKC education must preserve explicit Latin readings');
  c.speech.readEmoji = false; c.speech.readStickers = false; assert.equal(prepareSpeech(message, c), '');
});

test('education learns emoji and sticker names, forgetting restores romaji and mute hides the name', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nyan-media-reading-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory); store.updateConfig({ speech: { readNames: false }, bot: { bindings: [{ guildId: '11111', textChannelIds: ['22222'], voiceChannelId: '33333' }] } });
  const spoken = [], education = new ChatEducation(store), bot = new DiscordBot(store, { speech: p => spoken.push(p), education: p => education.apply(p) }); bot.client = { user: { id: '99999' } }; let id = 0;
  const message = (content, stickers = []) => ({ id: String(++id), content, author: { id: '44444', username: 'name' }, guildId: '11111', channelId: '22222', attachments: new Map(), stickers: new Map(stickers.map(s => [s.id, s])), reply: async () => {} });
  await bot.message(message('教育（nyan＝CAT）'));
  await bot.message(message('<:nyan:55555>', [{ id: '66666', name: 'nyan' }])); assert.equal(spoken.at(-1).text, 'CAT。スタンプ、CAT');
  await bot.message(message('忘却(nyan)'));
  await bot.message(message('<:nyan:55555>')); assert.equal(spoken.at(-1).text, 'にゃん');
  await bot.message(message('無音（nyan）')); const count = spoken.length;
  await bot.message(message('<:nyan:55555>')); assert.equal(spoken.length, count);
  await bot.message(message('', [{ id: '66666', name: 'neko' }])); assert.equal(spoken.at(-1).text, '。スタンプ、ねこ');
});

test('native tag processing gets attachment types and sticker names while preserving raw tags', () => {
  const c = config({ speech: { bouyomiPreprocess: true, emojiReadings: [{ source: 'nyan', replacement: 'CAT' }] } });
  const prepared = prepareSpeech({ content: 'AB (Sound nyan.wav) <:nyan:12345>', attachments: [{ name: 'secret.mp3' }], stickers: [{ name: 'neko', id: '12346' }] }, c);
  assert.equal(prepared, 'AB (Sound nyan.wav) CAT。添付ファイル1件、音声ファイル。スタンプ、neko');
  assert.equal(prepareNativeText('CAT neko', c), 'CAT ねこ');
});

test('unregistered erai uses romaji while explicit education and settings retain their readings', () => {
  for (const chatEducationEnabled of [false, true]) {
    const c = config({ speech: { chatEducationEnabled } });
    const message = { content: '<:erai:1541190483315790015>', stickers: [{ name: 'erai', id: '12345' }] };
    assert.equal(prepareSpeech(message, c), 'えらい。スタンプ、えらい');
    c.speech.chatEducationEnabled = true; c.education = [{ source: 'erai', reading: 'CAT' }];
    assert.equal(prepareSpeech(message, c), 'CAT。スタンプ、CAT');
    c.speech.emojiReadings = [{ source: 'erai', replacement: '専用の読み' }];
    assert.equal(prepareSpeech(message, c), '専用の読み。スタンプ、専用の読み');
  }
});
