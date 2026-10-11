import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { prepareSpeech, prepareNativeText } from '../apps/desktop/core/text.mjs';
import { nativeSegments, runNativeSpeech } from '../apps/desktop/core/bouyomi-pipeline.mjs';
import { Voicevox } from '../apps/desktop/core/voicevox.mjs';

const config = normalizeConfig({ speech: { readNames: false } });
const content = '川柳を検出しました！\n「件目です 停止優先 試験です」';
const expected = '川柳を検出しました！\n件目です 停止優先 試験です';

test('quotes and nested full/half-width brackets keep their complete contents', () => {
  assert.equal(prepareSpeech({ content }, config), expected);
  assert.equal(prepareNativeText(content, config), expected);
  for (const text of ['（件目です 停止優先 試験です）', '(件目です 停止優先 試験です)', '【件目です 停止優先 試験です】', '『件目です 停止優先 試験です』']) {
    assert.equal(prepareSpeech({ content: text }, config), '件目です 停止優先 試験です');
    assert.equal(prepareNativeText(text, config), '件目です 停止優先 試験です');
  }
  assert.equal(prepareSpeech({ content: '前（中「奥」後）末（未閉じ' }, config), '前中奥後末未閉じ');
});

test('native split text starting with parentheses is spoken without executing raw syntax', async () => {
  const result = { parts: ['前', '(件目です 停止優先 試験です)', '(Ｔ １)', '後'], tags: [{ type: 'Speed', args: '150' }] };
  assert.deepEqual(nativeSegments(result).map(s => s.kind), ['text', 'text', 'tag', 'text']);
  const spoken = [];
  await runNativeSpeech({ text: content, settings: { ...config.speech, bouyomiUseDefaults: false }, original: { SpeedTag: 'true', SpeedMin: '50', SpeedMax: '300' }, pendingCharacters: 0,
    processor: { process: async () => result }, output: async text => spoken.push(prepareNativeText(text, config)),
  }, new AbortController().signal);
  assert.deepEqual(spoken, ['前', '件目です 停止優先 試験です', '後']);
});

test('synthesis receives all quoted text for literal/system messages too', async () => {
  const calls = [];
  const voice = new Voicevox('http://localhost:50021', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return url.includes('/audio_query?') ? new Response('{}') : new Response(Buffer.from('RIFFtest'));
  });
  await voice.synthesize(content, config.speech);
  assert.equal(calls[0].url.searchParams.get('text'), expected);
});
