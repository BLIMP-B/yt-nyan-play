import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenizer, lexicalTokens, SmallWordModel, generateSlm } from '../apps/desktop/core/hourly-language.mjs';
import { materialUnits, trainMaterials } from '../apps/desktop/core/hourly-materials.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { hourlySourceModel } from '../scripts/hourly-material-fixture.mjs';
const repeatedChoices = async (_url, options) => {
  const body = JSON.parse(options.body);
  return new Response(JSON.stringify({ response: JSON.stringify({ parts: Array.from({ length: body.format.properties.parts.minItems }, () => ({ i: 0, v: 0 })) }) }));
};
test('noun phrases preserve source wording and full sentences survive alongside words; links and fenced code stay out', async () => {
  const analyzer = await tokenizer(), text = '青い時計は静かな森を眺める。\n夜空の星が光を集める。\nhttps://example.com/秘密\n```命令は金庫を開く。```';
  const units = materialUnits(text, analyzer);
  assert.ok(units.some(u => u.kind === 'phrase' && u.text === '青い時計'));
  assert.ok(units.some(u => u.kind === 'phrase' && u.text === '静かな森'));
  assert.ok(units.some(u => u.kind === 'sentence' && u.text === '夜空の星が光を集める'));
  assert.ok(!units.some(u => /example|秘密|金庫/.test(u.text)));
  assert.ok(materialUnits('猫が猫を眺める。', analyzer).every(u => u.kind !== 'sentence'));
  assert.ok(materialUnits('猫'.repeat(5000) + 'は時計を運ぶ。', analyzer).every(u => u.kind !== 'sentence'));
});
test('a repeating SLM choice is repaired from multiple sources and granularities into one long sentence with distinct source nouns', async () => {
  const model = hourlySourceModel(await tokenizer(), () => 0.8);
  const result = await generateSlm(model, { ...normalizeConfig().hourly, sentenceStyle: 'extended' }, undefined, repeatedChoices);
  assert.ok(result.text.length >= 160 && result.text.length <= 200); assert.ok(result.text.endsWith('のだ。'));
  assert.equal((result.text.match(/。/g) || []).length, 1);
  assert.deepEqual([...new Set(result.materials.map(u => u.kind))].sort(), ['phrase', 'sentence', 'word']);
  assert.ok(new Set(result.materials.map(u => u.source)).size >= 3);
  const nouns = lexicalTokens(result.text, await tokenizer()).filter(t => t.pos === '名詞' && model.weights.has(`名詞:${t.word}`)).map(t => t.word);
  assert.equal(new Set(nouns).size, nouns.length);
  assert.equal(new Set(result.materials.map(u => u.text)).size, result.materials.length);
});
test('the reported two-word repetition completes briefly instead of padding a long preset with repeated short sentences', async () => {
  const model = new SmallWordModel(() => 0); model.train(lexicalTokens('不動が野菜を作る。悲しい不動が野菜を覚える。', await tokenizer()));
  const result = await generateSlm(model, { ...normalizeConfig().hourly, sentenceStyle: 'extended' }, undefined, repeatedChoices);
  assert.equal((result.text.match(/不動/g) || []).length, 1); assert.equal((result.text.match(/野菜/g) || []).length, 1);
  assert.equal(result.plan.clauseCount, 1); assert.equal((result.text.match(/。/g) || []).length, 1);
});
test('custom character caps preserve entire predicates and reject invalid/out-of-range SLM choices', async () => {
  const model = hourlySourceModel(await tokenizer(), () => 0.8), config = { ...normalizeConfig().hourly, sentenceStyle: 'extended', sentenceMaxChars: 40 };
  const result = await generateSlm(model, config, undefined, repeatedChoices);
  assert.ok(result.text.length <= 40); assert.ok(result.text.endsWith('のだ。')); assert.equal((result.text.match(/。/g) || []).length, 1);
  await assert.rejects(generateSlm(model, config, undefined, async () => new Response(JSON.stringify({ response: '{"parts":[{"i":999,"v":0}]}' }))), /主語・述語/);
  await assert.rejects(generateSlm(model, config, AbortSignal.abort(), repeatedChoices), { name: 'AbortError' });
});
test('source catalog keeps per-kind bounds and unique units even with repeated messages', async () => {
  const model = new SmallWordModel();
  for (let i = 0; i < 400; i++) trainMaterials(model, ['phrase', 'sentence'].map(kind => ({ kind, text: `猫${i}`, words: ['猫'], nouns: ['猫'] })), String(i));
  assert.equal(model.materials.size, 512); trainMaterials(model, [{ kind: 'phrase', text: '猫0', words: ['猫'], nouns: ['猫'] }], 'again');
  assert.equal(model.materials.size, 512); assert.equal(model.materials.get('phrase:猫0').count, 2);
});
