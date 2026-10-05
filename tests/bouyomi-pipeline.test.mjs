import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSegments, nativeSpeed, nativeTagSettings, nativeSpeechDefaults, runNativeSpeech } from '../apps/desktop/core/bouyomi-pipeline.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { prepareSpeech } from '../apps/desktop/core/text.mjs';
const original = () => ({ BroadcasterMode: 'true', Speed: '139', Volume: '100', Tone: '100', SpeedUpEnable: 'true', SpeedUpMin: '120', SpeedUpMax: '300', SpeedUpStartCount: '120', SpeedUpRate: '500', TextLengthEnable: 'false', TagEnable: 'true', StudyTag: 'true', ForgetTag: 'true', SpeedTag: 'true', ToneTag: 'true', VolumeTag: 'true', VoiceTag: 'true', SpeedMin: '150', SpeedMax: '300', ToneMin: '50', ToneMax: '200', VolumeMin: '0', VolumeMax: '300' });
test('native VOICEVOX preprocessing preserves education syntax, punctuation and long messages', () => {
  const c = normalizeConfig({ speech: { bouyomiPreprocess: true, readNames: false, maxChars: 4 } }), text = '教育(abc_def=ねこ) **原文** https://example.test/a';
  assert.equal(prepareSpeech({ content: text }, c), text);
});
test('native segment provenance requires generated tag markers; raw command syntax cannot execute', () => {
  const result = { text: '(STUDY raw=word) 猫(Ｔ １)ねこ', tags: [{ type: 'Study', args: '猫猫=ねこ' }] };
  assert.deepEqual(nativeSegments(result), [{ kind: 'text', text: '(STUDY raw=word) 猫' }, { kind: 'tag', type: 'Study', args: '猫猫=ねこ' }, { kind: 'text', text: 'ねこ' }]);
  assert.deepEqual(nativeSegments({ text: '', tags: [], parts: ['本文', '(STUDY raw=word)', 'その後'] }), [{ kind: 'text', text: '本文' }, { kind: 'text', text: 'その後' }]);
  assert.deepEqual(nativeSegments({ text: '(Ｔ ９)', tags: [] }), []);
});
test('native acceleration uses accumulated source characters and respects global broadcaster switch', () => {
  const s = original(); assert.equal(nativeSpeed(s, 120), 120); assert.equal(nativeSpeed(s, 370), 170); assert.equal(nativeSpeed(s, 10000), 300);
  s.BroadcasterMode = 'false'; assert.equal(nativeSpeed(s, 10000), 139);
  const defaults = nativeSpeechDefaults(normalizeConfig().speech, s, 10000); assert.equal(defaults.speed, 1.39); assert.equal(defaults.volume, 1); assert.equal(defaults.pitch, 0);
});
test('native voice IDs require an explicit mapping, speed/volume obey original tag limits', () => {
  const settings = normalizeConfig({ speech: { bouyomiVoiceMap: [{ voiceId: 10001, styleId: 22 }] } }).speech;
  assert.equal(nativeTagSettings({ type: 'Voice', args: '9' }, settings, original()).styleId, 22);
  assert.throws(() => nativeTagSettings({ type: 'Voice', args: '16' }, settings, original()), /10008/);
  assert.equal(nativeTagSettings({ type: 'Speed', args: '500' }, settings, original()).speed, 3);
  assert.equal(nativeTagSettings({ type: 'Volume', args: '150' }, settings, original()).volume, 1.2);
});
test('native processing applies tags in order, learns only through generated tags and speaks confirmation before remaining text', async () => {
  const operations = [], processor = {
    process: async (text, mode) => { operations.push(['process', text, mode]); return text === '原文' ? { text: '前(Ｔ １)(Ｔ ２)後', tags: [{ type: 'Speed', args: '200' }, { type: 'Study', args: '猫猫=ねこ' }] } : { text, tags: [] }; },
    learn: async (type, args) => { operations.push(['learn', type, args]); return { text: '猫猫 わ ねこ を 覚えました' }; },
  };
  const spoken = [], settings = normalizeConfig({ speech: { bouyomiPreprocess: true, bouyomiUseDefaults: true, bouyomiTagMode: 'on' } }).speech;
  await runNativeSpeech({ text: '原文', settings, original: original(), pendingCharacters: 120, processor, output: async (text, opts) => spoken.push([text, opts.speed]), sound() {} }, new AbortController().signal);
  assert.deepEqual(spoken, [['前', 1.2], ['猫猫 わ ねこ を 覚えました', 2.4], ['後', 2.4]]);
  assert.deepEqual(operations, [['process', '原文', 'on'], ['learn', 'Study', '猫猫=ねこ'], ['process', '猫猫 わ ねこ を 覚えました', 'off']]);
});
test('cancelled native preprocessing cannot start synthesis or mutate the education dictionary', async () => {
  const controller = new AbortController(), errors = []; let spoken = false, learned = false;
  const processor = { process: async () => { controller.abort(); return { text: '(Ｔ １)', tags: [{ type: 'Forget', args: '猫猫' }] }; }, learn: async () => { learned = true; } };
  await assert.rejects(runNativeSpeech({ text: '原文', settings: normalizeConfig().speech, original: original(), pendingCharacters: 0, processor, output: async () => { spoken = true; }, log: (_level, text) => errors.push(text) }, controller.signal), { name: 'AbortError' });
  assert.equal(spoken, false); assert.equal(learned, false); assert.deepEqual(errors, []);
});
