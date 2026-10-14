import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { prepareSpeech, prepareSpeakerSuffix, prepareNativeText, speakerName } from '../apps/desktop/core/text.mjs';
import { runNativeSpeech } from '../apps/desktop/core/bouyomi-pipeline.mjs';
import { applyEducation } from '../apps/desktop/core/education.mjs';
import { ReadingText } from '../apps/desktop/core/latin-reading.mjs';
const message = () => ({ content: '本文', channelId: '22222', guildId: '11111', userId: '44444', userName: 'neko', serverNickname: '猫', displayName: 'Discord全体の表示名' });
test('attribution uses nickname, username then ID, never global display name', () => {
  const c = normalizeConfig(), m = message();
  assert.equal(prepareSpeech(m, c), '本文、猫の発言');
  m.serverNickname = ''; assert.equal(prepareSpeech(m, c), '本文、ねこの発言');
  m.userName = ''; assert.equal(prepareSpeech(m, c), '本文、44444の発言');
  assert.equal(speakerName({ serverNickname: ' ', userName: 'neko' }), 'neko');
});
test('speaker switches are independent for text, VC text and master and survive normalization', () => {
  const c = normalizeConfig({ speech: { speakerSuffixDisabledChannelIds: ['22222', '22222'] } });
  assert.deepEqual(c.speech.speakerSuffixDisabledChannelIds, ['22222']);
  assert.equal(prepareSpeech(message(), c), '本文');
  for (const channelId of ['33333', '55555']) assert.equal(prepareSpeech({ ...message(), channelId }, c), '本文、猫の発言');
  const restored = normalizeConfig(JSON.parse(JSON.stringify(c)));
  assert.equal(prepareSpeech(message(), restored), '本文');
  assert.throws(() => normalizeConfig({ speech: { speakerSuffixDisabledChannelIds: ['invalid'] } }), /チャンネルID/);
});
test('legacy disabled name reading migrates the selected channels and master once', () => {
  const c = normalizeConfig({ speech: { readNames: false }, bot: { masterTextChannelId: '55555', bindings: [{ guildId: '11111', voiceChannelId: '33333', textChannelIds: ['22222'] }] } });
  assert.deepEqual(new Set(c.speech.speakerSuffixDisabledChannelIds), new Set(['22222', '33333', '55555']));
  c.speech.speakerSuffixDisabledChannelIds = [];
  assert.equal(prepareSpeech(message(), normalizeConfig(c)), '本文、猫の発言');
});
test('education, mute, forgetting, regex and scoped dictionaries affect the suffix', () => {
  const m = { ...message(), serverNickname: 'neko' }, c = normalizeConfig({ education: [{ source: 'neko', reading: 'CAT' }] });
  assert.equal(prepareSpeech(m, c), '本文、CATの発言', 'explicit Latin readings are preserved');
  c.education[0].reading = ''; assert.equal(prepareSpeech(m, c), '本文、の発言');
  c.education = []; assert.equal(prepareSpeech(m, c), '本文、ねこの発言');
  c.dictionary = normalizeConfig({ dictionary: [{ source: '^.*neko', replacement: '、にゃん', regex: true, scope: 'guild', scopeId: '11111' }] }).dictionary;
  assert.equal(prepareSpeech(m, c), '本文、にゃんの発言');
  assert.equal(prepareSpeech({ ...m, guildId: '55555' }, c), '本文、ねこの発言');
  c.dictionary = []; c.education = [{ source: 'neko', reading: 'CAT' }]; c.speech.chatEducationEnabled = false;
  assert.equal(prepareSpeech(m, c), '本文、ねこの発言');
});
test('emoji names receive shared readings and bracket contents remain audible', () => {
  const c = normalizeConfig({ education: [{ source: '✅', reading: 'ちぇっく' }] });
  assert.equal(prepareSpeech({ ...message(), serverNickname: '✅「猫」（ねこ）' }, c), '本文、ちぇっく猫ねこの発言');
});
test('body limits retain attribution once, empty or muted bodies never gain an attribution', () => {
  const c = normalizeConfig({ speech: { maxChars: 3 } });
  assert.equal(prepareSpeech({ ...message(), content: 'あいうえお' }, c), 'あいう、猫の発言');
  assert.equal(prepareSpeech({ ...message(), content: '' }, c), '');
  c.education = [{ source: '本文', reading: '' }];
  assert.equal(prepareSpeech(message(), c), '');
});
test('unaddressed titles and system previews do not acquire a speaker suffix', () => {
  const c = normalizeConfig({ speech: { readNames: false } });
  assert.equal(prepareSpeech({ ...message(), channelId: undefined }, c), '本文');
});
test('native preprocessing applies imported education to the suffix after the original body limit', async () => {
  const c = normalizeConfig({ speech: { bouyomiPreprocess: true, bouyomiUseDefaults: false }, education: [{ source: '猫', reading: 'ねこさん', native: true }] }), m = message();
  const text = prepareSpeech({ ...m, content: 'あいうえお' }, c), suffix = prepareSpeakerSuffix(m, c), calls = [], spoken = [];
  assert.equal(text, 'あいうえお、（猫）の発言');
  const processor = { process: async (input, mode, _signal, enabled) => {
    calls.push({ input, mode, enabled });
    return { text: applyEducation(new ReadingText(input), c.education).text, tags: [], readings: ['ねこさん'] };
  } };
  await runNativeSpeech({ text, speakerSuffix: suffix, settings: c.speech, original: { TextLengthEnable: 'true', TextLengthNum: '3', TextLengthAdd: '以下略', BroadcasterMode: 'false' }, pendingCharacters: 0, processor,
    output: async (value, _settings, _signal, readings) => spoken.push(prepareNativeText(value, c, m, readings)),
  }, new AbortController().signal);
  assert.deepEqual(calls, [{ input: 'あいう以下略、（猫）の発言', mode: 'original', enabled: true }]);
  assert.deepEqual(spoken, ['あいう以下略、ねこさんの発言']);
});
test('external Bouyomi input includes attribution for its native dictionary processing', () => {
  const c = normalizeConfig({ speech: { provider: 'bouyomi', bouyomiNativeRules: true } });
  assert.equal(prepareSpeech(message(), c), '本文、（猫）の発言');
});
