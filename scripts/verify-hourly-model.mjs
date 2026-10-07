import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HourlyModel } from '../apps/desktop/runtime/hourly-model.mjs';
import { generateSlm, lexicalTokens, tokenizer, SmallWordModel } from '../apps/desktop/core/hourly-language.mjs';
import { hourlySourceModel } from './hourly-material-fixture.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
const directory = mkdtempSync(join(tmpdir(), 'nyan-slm-')), config = normalizeConfig();
const reports = resolve('dist/hourly-model-verification'); mkdirSync(reports, { recursive: true });
const fetcher = (url, options = {}) => {
  const headers = new Headers(options.headers);
  // CI's read-only token avoids shared runner IP rate limits. Never send it
  // to download redirects, model registries, or the local inference server.
  if (url === 'https://api.github.com/repos/ollama/ollama/releases/latest' && process.env.NYAN_VERIFY_GITHUB_TOKEN) headers.set('Authorization', 'Bearer ' + process.env.NYAN_VERIFY_GITHUB_TOKEN);
  return fetch(url, { ...options, headers });
};
const runtime = new HourlyModel(directory, () => config, fetcher), report = { platform: process.platform, model: config.hourly.slmModel, passed: false, samples: [] };
let last = 0; runtime.on('change', () => { if (Date.now() - last > 10000) { last = Date.now(); console.log(runtime.progress); } });
try {
  await runtime.setup(); report.runtime = runtime.snapshot();
  const analyzer = await tokenizer(), model = hourlySourceModel(analyzer, () => 0.8);
  for (const style of ['brief', 'extended', 'random']) {
    const began = Date.now(), sample = await generateSlm(model, { ...config.hourly, sentenceStyle: style });
    assert.ok(sample.text.endsWith('のだ。') && sample.text.length <= 200 && sample.nouns.length === 2); assert.ok(sample.plan.clauseCount >= 1);
    const nouns = lexicalTokens(sample.text, analyzer).filter(t => t.pos === '名詞' && model.weights.has(`名詞:${t.word}`)).map(t => t.word);
    sample.quality = { sentenceCount: (sample.text.match(/。/g) || []).length, uniqueSourceNouns: new Set(nouns).size === nouns.length, sourceKinds: [...new Set(sample.materials.map(u => u.kind))], sourceMessages: new Set(sample.materials.map(u => u.source)).size };
    assert.equal(sample.quality.sentenceCount, 1); assert.equal(sample.quality.uniqueSourceNouns, true);
    if (style === 'extended') { assert.ok(sample.text.length >= 150); assert.deepEqual(sample.quality.sourceKinds.slice().sort(), ['phrase', 'sentence', 'word']); assert.ok(sample.quality.sourceMessages >= 3); }
    report.samples.push({ ...sample, elapsedMs: Date.now() - began }); console.log('SLM_SAMPLE ' + JSON.stringify(report.samples.at(-1)));
  }
  const sparse = new SmallWordModel(() => 0); sparse.train(lexicalTokens('不動が野菜を作る。悲しい不動が野菜を覚える。', analyzer));
  report.repetitionRegression = await generateSlm(sparse, { ...config.hourly, sentenceStyle: 'extended' });
  assert.equal((report.repetitionRegression.text.match(/不動/g) || []).length, 1); assert.equal((report.repetitionRegression.text.match(/野菜/g) || []).length, 1);
  assert.equal(report.repetitionRegression.plan.clauseCount, 1);
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally { runtime.cancel(); await runtime.stop(); runtime.close(); writeFileSync(join(reports, 'model-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} }
