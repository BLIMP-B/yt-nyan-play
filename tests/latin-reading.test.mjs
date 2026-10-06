import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingText, readLatin } from '../apps/desktop/core/latin-reading.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { prepareSpeech, prepareNativeText, applyDictionary } from '../apps/desktop/core/text.mjs';
import { parseMediaCommand } from '../apps/desktop/core/protocol.mjs';
import { runNativeSpeech } from '../apps/desktop/core/bouyomi-pipeline.mjs';
const config = options => normalizeConfig({ ...options, speech: { readNames: false, ...options?.speech } });
const speech = (content, c = config(), context = {}) => prepareSpeech({ content, ...context }, c);

test('single Latin letters use Japanese letter names with case and fullwidth equivalence', () => {
  const expected = 'エー ビー シー ディー イー エフ ジー エイチ アイ ジェー ケー エル エム エヌ オー ピー キュー アール エス ティー ユー ブイ ダブリュー エックス ワイ ゼット';
  for (const value of ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', 'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ', 'ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ']) assert.equal(speech([...value].join(' ')), /[nｎ]/u.test(value) ? expected.replace('エヌ', 'ん') : expected);
  assert.equal(speech('文字ABC、ab12cd。'), '文字あビーシー、あビー12シーディー。');
});
test('recognized URLs are excluded while adjacent letter sequences are spelled', () => {
  const url = 'HTTPS://example.test/A_b?key=CD#EF';
  assert.equal(readLatin(`AB ${url}。CD`), `あビー ${url}。シーディー`);
  assert.equal(speech(`AB ${url}。CD`), 'あビー URL。シーディー');
  assert.equal(speech(`AB ${url}。CD`, config({ speech: { readUrls: true } })), `あビー ${url}。シーディー`);
  assert.equal(readLatin('www.example.test/ABC ftp://example.test/AB'), 'www.example.test/ABC ftp://example.test/AB');
  assert.equal(speech('URL HTTP abc'), 'うアールエル エイチっティーピー あビーシー');
  assert.equal(speech('https://?abc'), 'エイチっティーピーエス://?あビーシー');
});
test('two or more letters use Japanese romaji, including contracted sounds and nasal boundaries', () => {
  for (const [input, expected] of [
    ['ka', 'か'], ['ai', 'あい'], ['nyan', 'にゃん'], ['NYAN', 'にゃん'], ['Ｎｙａｎ', 'にゃん'],
    ['konnichiwa', 'こんにちわ'], ['gakkou', 'がっこう'], ['matcha', 'まっちゃ'], ['shinbun', 'しんぶん'],
    ['shinnyuu', 'しんにゅう'], ["kan'i", 'かんい'], ['kan’i', 'かんい'], ['nn', 'ん'],
    ['shi si chi ti tsu tu fu hu', 'し し ち ち つ つ ふ ふ'], ['xtsu ltu kya she fa va', 'っ っ きゃ しぇ ふぁ ゔぁ'],
    ['QR', 'キューアール'], ['A-ka-12-n-N', 'エー-か-12-ん-エヌ'],
  ]) assert.equal(speech(input), expected, input);
});
test('only standalone lowercase n is the letter-name exception, and dictionaries retain precedence', () => {
  assert.equal(speech('n N ｎ Ｎ'), 'ん エヌ ん エヌ');
  assert.equal(speech('n n', config({ dictionary: [{ source: 'n', replacement: 'エヌ', caseSensitive: true, scope: 'global' }] })), 'エヌ エヌ');
});
test('Markdown speaks its label and actual URL playback commands remain unchanged', () => {
  assert.equal(speech('[AB](https://example.test/ABC) **CD**'), 'あビー シーディー');
  assert.equal(parseMediaCommand('https://youtu.be/AbCdEF?t=72無限', config()).url, 'https://youtu.be/AbCdEF?t=72');
  assert.equal(parseMediaCommand('https://youtu.be/AbCdEF?t=72無限', config()).mode, 'full');
});
test('literal and regex dictionaries protect explicit readings and keep replacement semantics', () => {
  const c = config({ dictionary: [
    { source: 'CAT', replacement: 'ねこ', scope: 'global' },
    { source: '犬', replacement: 'DOG', scope: 'global' },
    { source: '([A-Z]+)-([0-9]+)', replacement: '$1番号$2$$', regex: true, scope: 'global' },
  ] });
  assert.equal(speech('cat 犬 AB-12 CD', c), 'ねこ DOG AB番号12$ シーディー');
  for (const replacement of ['$&', '$`', "$'", '$$', '$1:$2:$12']) {
    const entries = [{ source: '(A)(B)', replacement, regex: true, scope: 'global' }];
    assert.equal(applyDictionary(new ReadingText('xABz'), entries, {}).text, applyDictionary('xABz', entries, {}));
  }
  for (const text of ['AB', new ReadingText('AB')]) assert.throws(() => applyDictionary(text, [{ source: '(A)(B)', replacement: '$0', regex: true, scope: 'global' }], {}), /replacement/);
});
test('dictionary scope, case and cascading replacements remain respected', () => {
  const c = config({ dictionary: [
    { source: 'AB', replacement: 'ねこ', scope: 'guild', scopeId: '11111', caseSensitive: true },
    { source: 'ねこ', replacement: 'CAT', scope: 'user', scopeId: '22222' },
  ] });
  assert.equal(speech('AB ab', c, { guildId: '11111', userId: '22222' }), 'CAT あビー');
  assert.equal(speech('AB', c, { guildId: '33333' }), 'あビー');
});
test('education readings including Latin replacements and mute take priority', () => {
  const c = config({ education: [{ source: 'CAT', reading: 'ねこ' }, { source: 'DOG', reading: 'ABC' }, { source: 'MUTE', reading: '' }] });
  assert.equal(speech('cat ＣＡＴ DOG MUTE abc', c), 'ねこ ねこ ABC  あビーシー');
  c.education = [];
  assert.equal(speech('cat', c), 'シーあティー');
  c.education = [{ source: 'CAT', reading: 'ねこ' }]; c.speech.chatEducationEnabled = false;
  assert.equal(speech('cat', c), 'シーあティー');
});
test('names, attachments and emoji readings use the same fallback while explicit readings stay intact', () => {
  const c = config({ speech: { readNames: true, readEmoji: true, emojiReadings: [{ source: '😀', replacement: 'ABC' }] } });
  assert.equal(prepareSpeech({ content: 'AB 😀', userName: 'CD', attachments: [{ name: 'EF.mp3' }] }, c), 'シーディー、あビー ABC。添付ファイル1件、えエフ.エムピー3');
});
test('expanded speech stays bounded and user marker-looking text cannot bypass spelling', () => {
  assert.equal(speech('QW'.repeat(1000), config({ speech: { maxChars: 10 } })), 'キューダブリュー'.repeat(1000).slice(0, 10));
  assert.equal(speech('\uE000ABC\uE001'), '\uE000あビーシー\uE001');
  assert.equal(readLatin('かな🦊AB', 5), 'かな🦊あビ');
});
test('native fallback runs after generated tags and preserves command arguments', async () => {
  const c = config({ speech: { bouyomiPreprocess: true } }), operations = [], spoken = [];
  const text = '原文 AB (Study cat=ABC) https://example.test/AB';
  assert.equal(speech(text, c), text);
  const processor = { process: async input => { operations.push(input); return { text: 'AB(Ｔ １)CD https://example.test/AB', tags: [{ type: 'SoundW', args: 'ABC.wav' }] }; } };
  await runNativeSpeech({ text, settings: c.speech, original: { SoundTag: 'true' }, pendingCharacters: 0, processor,
    output: async value => spoken.push(prepareNativeText(value, c)), sound: async name => operations.push(name),
  }, new AbortController().signal);
  assert.deepEqual(operations, [text, 'ABC.wav']);
  assert.deepEqual(spoken, ['あビー', 'シーディー https://example.test/AB']);
  assert.equal(prepareNativeText('DOG nyan n N', c, {}, ['DOG']), 'DOG にゃん ん エヌ');
});
