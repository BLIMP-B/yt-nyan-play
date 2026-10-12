import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';
const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'nyan-reading-ui-'));
const report = { platform: process.platform, desktopVersion: null, scope: 'desktop-ui-and-settings', discordReceiverVerified: false, passed: false };
writeFileSync(join(directory, 'config.json'), JSON.stringify({ desktop: { closeToTray: false, notifications: false },
  speech: { readNames: false, emojiReadings: [{ source: 'erai', replacement: '以前の設定' }] }, education: [{ source: 'erai', reading: '以前の教育' }] }));
let app;
async function launch() {
  const env = { ...process.env, NYAN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require('electron'), args: [resolve(import.meta.dirname, '..'), ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], env });
  const page = await app.firstWindow(); await page.waitForFunction(() => document.querySelector('#emoji-reading-list')?.textContent.includes('erai'));
  await page.locator('[data-view="dictionary"]').click(); return page;
}
const state = async page => { const result = await page.evaluate(() => window.nyan.invoke('state')); assert.equal(result.ok, true, result.error); return result.value; };
async function set(page, source, reading) {
  await page.locator('#emoji-source').fill(source); await page.locator('#emoji-replacement').fill(reading);
  await page.locator('#emoji-reading-form button').click(); await page.waitForFunction(value => document.querySelector('#emoji-reading-list').textContent.includes(value), reading);
  const current = await state(page); assert.equal(current.readings.length, 1);
  assert.equal(current.config.education[0].reading, reading); assert.equal(current.config.speech.emojiReadings[0].replacement, reading);
}
try {
  let page = await launch(), current = await state(page); report.desktopVersion = current.version;
  assert.equal(current.readings.length, 1); assert.equal(current.readings[0].reading, '以前の設定'); report.legacyMigration = true;
  await set(page, ':ERAI:', '画面で変更'); report.uiOverwrite = true;
  const saved = await page.evaluate(async () => { const current = (await window.nyan.invoke('state')).value; current.config.education[0].reading = '教育設定から変更'; return window.nyan.invoke('config:save', current.config); });
  assert.equal(saved.ok, true, saved.error);
  await page.waitForFunction(() => document.querySelector('#emoji-reading-list').textContent.includes('教育設定から変更'));
  current = await state(page); assert.equal(current.config.speech.emojiReadings[0].replacement, '教育設定から変更'); report.educationProjection = true;
  await set(page, 'erai', '再起動後の読み'); await app.close(); app = null;
  page = await launch(); current = await state(page); assert.equal(current.readings[0].reading, '再起動後の読み'); report.restart = true;
  await page.locator('#emoji-reading-list button').click(); await page.waitForFunction(() => document.querySelector('#emoji-reading-list').textContent.includes('登録した読み方はありません'));
  current = await state(page); assert.equal(current.config.education.length, 0); assert.equal(current.config.speech.emojiReadings.length, 0); report.sharedForget = true;
  report.passed = true;
} finally {
  if (app) await app.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const out = resolve(import.meta.dirname, '../dist/shared-readings-verification'); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `shared-readings-${process.platform}-report.json`), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
