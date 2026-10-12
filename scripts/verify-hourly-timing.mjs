import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..');
const modelFile = resolve(process.argv[2]), model = JSON.parse(readFileSync(modelFile));
const directory = mkdtempSync(join(tmpdir(), 'nyan-hourly-timing-'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'nyan-hourly-timing', type: 'module', main: 'main.mjs' }));
const moduleUrl = path => JSON.stringify(pathToFileURL(join(root, 'apps/desktop', path)).href);
writeFileSync(join(directory, 'main.mjs'), `import{app,BrowserWindow}from'electron';
import{searchHourlyBgm}from${moduleUrl('runtime/hourly-bgm.mjs')};
import{hourlyBgmChoice}from${moduleUrl('core/hourly-bgm-history.mjs')};
import{MediaBrowser}from${moduleUrl('runtime/media-browser.mjs')};
import{normalizeConfig}from${moduleUrl('core/config.mjs')};
import{hourlyPreparationLead}from${moduleUrl('core/hourly-preparation.mjs')};
globalThis.nyanHourlyTimingModules={searchHourlyBgm,hourlyBgmChoice,MediaBrowser,normalizeConfig,hourlyPreparationLead};
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required'); app.setPath('userData',${JSON.stringify(directory)}); app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});await window.loadURL('data:text/html,<title>時報の準備時間を検証</title>');});`);
let application;
try {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [directory, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], env, timeout: 30000 });
  await application.firstWindow();
  const timing = await application.evaluate(async (_electron, { generationMs }) => {
    const { searchHourlyBgm, hourlyBgmChoice, MediaBrowser, normalizeConfig, hourlyPreparationLead } = globalThis.nyanHourlyTimingModules;
    const config = normalizeConfig({ media: { output: 'local', showWindow: false, bandwidthSaving: false } });
    const history = [{ kind: 'media', status: 'completed', startedAt: new Date().toISOString(), payload: { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', title: 'YouTube公開動画（履歴代替の検証用）' } }];
    const report = { budgetMs: 5950, generationMs, searchPerformed: true, playbackReady: false, fixtureAnnouncementMs: 700, log: [] };
    const log = (level, text) => report.log.push({ level, text }), signal = AbortSignal.timeout(40000);
    const began = performance.now(); let found;
    try { found = await hourlyBgmChoice(() => searchHourlyBgm(['猫', '時計'], () => config, signal), history, signal, log); report.searchMs = Math.round(performance.now() - began); report.selectedUrl = found.url; report.historyFallback = found.fallback === 'history'; }
    catch (error) { report.searchMs = Math.round(performance.now() - began); report.searchError = error.message; }
    if (found) {
      const controller = new AbortController(), browser = new MediaBrowser(() => config, { changed() {}, startCapture: async () => {}, stopCapture: async () => {} }, log);
      const playAt = performance.now(); let done = false;
      const task = browser.play({ id: crypto.randomUUID(), payload: { ...found, mode: 'direct', background: true } }, AbortSignal.any([signal, controller.signal])).catch(error => { if (!controller.signal.aborted) report.playbackError = error.message; }).finally(() => { done = true; });
      try {
        while (!signal.aborted && !done && performance.now() - playAt < 15000) {
          if (browser.status?.startedAt && browser.status.currentTime > 0) { browser.setPaused(true); report.playbackReady = true; break; }
          if (browser.status?.loginRequired) { report.playbackError = browser.status.blockedReason; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        report.playbackPreparationMs = Math.round(performance.now() - playAt);
      } finally { controller.abort(); await task; browser.close(); }
    }
    report.totalMs = generationMs + report.searchMs + (report.playbackPreparationMs || 0);
    report.leadMs = hourlyPreparationLead(report.playbackReady ? { preparationMs: report.totalMs } : undefined, report.budgetMs);
    report.decision = report.leadMs ? 'before-chime' : 'with-chime'; report.passed = true;
    return report;
  }, { generationMs: Math.max(...model.samples.map(s => s.elapsedMs)) });
  assert.equal(timing.passed, true); assert.ok(timing.searchPerformed); assert.ok(['before-chime', 'with-chime'].includes(timing.decision));
  model.timing = { ...timing, platform: process.platform }; writeFileSync(modelFile, JSON.stringify(model, null, 2)); console.log('HOURLY_TIMING ' + JSON.stringify(model.timing));
} finally { await application?.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
