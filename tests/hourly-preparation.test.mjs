import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlyPreparationLead } from '../apps/desktop/core/hourly-preparation.mjs';
import { hourlyBgmChoice, recentYoutubeMedia } from '../apps/desktop/core/hourly-bgm-history.mjs';
import { sentencePlan, sentenceFromClauses, SENTENCE_PRESETS } from '../apps/desktop/core/hourly-sentence.mjs';
import { SmallWordModel, generateSlm } from '../apps/desktop/core/hourly-language.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
test('unmeasured and over-budget end-to-end preparation starts early; only measured fast paths start with the chime', () => {
  assert.equal(hourlyPreparationLead(undefined, 7000), 60000);
  assert.equal(hourlyPreparationLead({ preparationMs: 5500 }, 7000), 0);
  assert.equal(hourlyPreparationLead({ preparationMs: 8000 }, 7000), 60000);
  assert.equal(hourlyPreparationLead({ preparationMs: 75000 }, 7000), 80000);
});
test('failed/empty YouTube search uses latest actually started YouTube media, excluding waiting/failed items and hostile URLs', async () => {
  const item = (url, time, status = 'completed') => ({ kind: 'media', status, startedAt: new Date(time).toISOString(), payload: { url } });
  const jobs = [item('https://youtu.be/abcdefghijk', 1), item('https://www.youtube.com/watch?v=h9c0gegwcM0', 2), item('https://nicovideo.jp/watch/sm9', 10), item('https://youtube.com.evil.test/video', 11), item('https://youtu.be/ro_v7LqdI58', 12, 'failed'), { kind: 'media', status: 'waiting', payload: { url: 'https://youtu.be/jNQXAC9IVRw' } }];
  assert.match(recentYoutubeMedia(jobs).url, /h9c0gegwcM0/);
  assert.equal((await hourlyBgmChoice(async () => { throw new Error('no results'); }, jobs, undefined, () => {})).fallback, 'history');
  await assert.rejects(hourlyBgmChoice(async () => { throw new Error('no results'); }, [], undefined, () => {}), /no results/);
  await assert.rejects(hourlyBgmChoice(async () => { throw new Error('no results'); }, jobs, AbortSignal.abort(), () => {}), { name: 'AbortError' });
});
test('length and style are chosen before generation and complete grammatical clauses fit 200 characters including のだ', async () => {
  const model = new SmallWordModel(() => 0.8); model.train([{ word: '猫', pos: '名詞' }, { word: '時計', pos: '名詞' }]);
  const lengths = [];
  for (const style of Object.keys(SENTENCE_PRESETS)) {
    const c = normalizeConfig({ hourly: { sentenceStyle: style } }).hourly; let sent;
    const result = await generateSlm(model, c, undefined, async (_url, options) => {
      sent = JSON.parse(options.body);
      const clause = { subject: '猫', object: '時計', verb: '運ぶ', adjective: '' }, count = sent.format.properties.clauses?.minItems || 1;
      return new Response(JSON.stringify({ response: JSON.stringify(count === 1 ? clause : { clauses: Array.from({ length: count }, () => [0, 1, 0, 0]) }) }));
    }, async () => [{ word: '猫', pos: '名詞' }, { word: '時計', pos: '名詞' }]);
    assert.ok(sent.prompt.includes(style)); assert.ok(result.text.endsWith('のだ。')); assert.ok(result.text.length <= 200); lengths.push(result.text.length);
  }
  assert.ok(lengths.at(-1) >= 160); assert.ok(lengths.every((length, i) => i === 0 || length > lengths[i - 1]));
  const plan = sentencePlan({ sentenceStyle: 'extended', sentenceMaxChars: 40 }, ['猫', '時計'], () => 0.9);
  assert.equal(plan.maxChars, 40); assert.ok(sentenceFromClauses(Array.from({ length: 10 }, () => ({ subject: '猫', object: '時計', verb: '運ぶ', adjective: '' })), plan).length <= 40);
});
