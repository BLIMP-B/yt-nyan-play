import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HourlyModel } from '../apps/desktop/runtime/hourly-model.mjs';
import { generateSlm, lexicalTokens, tokenizer, SmallWordModel } from '../apps/desktop/core/hourly-language.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
const directory = mkdtempSync(join(tmpdir(), 'nyan-slm-')), config = normalizeConfig();
const reports = resolve('dist/hourly-model-verification'); mkdirSync(reports, { recursive: true });
const runtime = new HourlyModel(directory, () => config), report = { platform: process.platform, model: config.hourly.slmModel, passed: false, samples: [] };
let last = 0; runtime.on('change', () => { if (Date.now() - last > 10000) { last = Date.now(); console.log(runtime.progress); } });
try {
  await runtime.setup(); report.runtime = runtime.snapshot();
  const model = new SmallWordModel(), analyzer = await tokenizer();
  model.train(lexicalTokens('猫は時計を眺める。森が太陽を食べる。雲は音楽を集める。', analyzer));
  for (let i = 0; i < 3; i++) { const began = Date.now(); const sample = await generateSlm(model, { ...config.hourly, sentenceStyle: ['brief', 'extended', 'random'][i] }); assert.ok(sample.text.endsWith('のだ。') && sample.text.length <= 200 && sample.nouns.length === 2); assert.ok(sample.plan.clauseCount >= 1); report.samples.push({ ...sample, elapsedMs: Date.now() - began }); console.log('SLM_SAMPLE ' + JSON.stringify(report.samples.at(-1))); }
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error); }
finally { runtime.cancel(); await runtime.stop(); runtime.close(); writeFileSync(join(reports, 'model-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} }
