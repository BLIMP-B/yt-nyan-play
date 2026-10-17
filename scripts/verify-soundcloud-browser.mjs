import { app } from 'electron';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MediaBrowser } from '../apps/desktop/runtime/media-browser.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

// A short real-site probe before the broad renderer suite. This validates the
// production browser controller and audible page, not a Discord receiver.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'nyan-soundcloud-browser-')));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
await app.whenReady();
const directory = resolve('dist/soundcloud-browser-verification'); mkdirSync(directory, { recursive: true });
const config = normalizeConfig({ media: { output: 'local', bandwidthSaving: false, showWindow: true } });
const report = { passed: false, platform: process.platform, receiverVerified: false, captureVerified: false, states: [], logs: [] };
const controller = new AbortController();
const browser = new MediaBrowser(() => config, { changed() {}, async startCapture() {}, async stopCapture() {} }, (level, text) => report.logs.push({ level, text }));
const job = { id: 'soundcloud-browser-probe', payload: { url: 'https://on.soundcloud.com/mnTxXSOAB7VR8gVSVm', mode: 'full' } };
let taskError, ended = false;
const playing = browser.play(job, controller.signal, { browserOnly: true }).catch(error => { if (error.name !== 'AbortError') taskError = error.message; }).finally(() => { ended = true; });
try {
  const until = Date.now() + 90000;
  while (Date.now() < until && !ended) {
    const state = browser.status;
    if (state) report.states.push({ ...state, audible: !browser.window?.isDestroyed() && browser.window?.webContents.isCurrentlyAudible() });
    if (state?.shareExpanded && state.startedAt && state.currentTime > 2 && browser.window?.webContents.isCurrentlyAudible()) { report.passed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (browser.window && !browser.window.isDestroyed()) report.page = await browser.window.webContents.executeJavaScript(`(() => ({
    title: document.title, text: document.body.innerText.slice(0,2500), attempts: window.__nyanSitePlay,
    controls: [...document.querySelectorAll('.soundTitle__playButton, .playButton, .playControl')].slice(0,12).map(n => n.outerHTML.slice(0,2000)),
    tracked: (window.__nyanMediaElements?.() || []).map(n => ({tag:n.tagName,ready:n.readyState,paused:n.paused,time:n.currentTime})),
    frames: [...document.querySelectorAll('iframe')].map(n => ({src:n.src,title:n.title}))
  }))()`, true);
  if (!report.passed) report.error = taskError || 'The production SoundCloud browser did not reach audible playback';
} catch (error) { report.error = error.stack; }
finally {
  controller.abort(); await playing; browser.close();
  writeFileSync(join(directory, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, page: report.page, last: report.states.at(-1) }));
  app.exit(report.passed ? 0 : 1);
}
