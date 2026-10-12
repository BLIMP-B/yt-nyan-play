import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { _electron } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { PcmMixer, createDiscordAudioResource } from '../apps/desktop/runtime/voice-output.mjs';
import { createAudioPlayer, NoSubscriberBehavior } from '@discordjs/voice';
import OpusScript from '../apps/desktop/runtime/opus-codec.mjs';
import { verifyAudioNetwork } from './audio-network-probe.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { mediaScope } from '../apps/desktop/core/media-pool.mjs';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'damare-audio-'));
const reports = resolve(process.env.NYAN_AUDIO_REPORT_DIR || join(root, 'dist/audio-verification')); mkdirSync(reports, { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.7', '-ar', '48000', '-ac', '2', join(directory, 'speech.wav')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:v', 'libvpx', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-shortest', join(directory, 'video.webm')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', join(directory, 'audio.ogg')]);
for (const [name, frequency] of [['scope-video', 880], ['scope-audio', 660]]) execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=30`, '-c:a', 'libopus', '-ar', '48000', '-ac', '2', join(directory, `${name}.ogg`)]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '48000', '-ac', '2', join(directory, 'scope-speech.wav')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '48000', '-ac', '2', join(directory, 'long-title.wav')]);
const wav = readFileSync(join(directory, 'speech.wav'));
const synthesisTexts = [];
const synthesisSettings = [];
const engine = createServer((req, res) => {
  if (req.url.startsWith('/audio_query')) { const text = new URL(req.url, 'http://localhost').searchParams.get('text'); synthesisTexts.push(text); res.end(JSON.stringify({ verificationText: text })); }
  else if (req.url.startsWith('/synthesis')) { let body = ''; req.on('data', bytes => { body += bytes; }); req.on('end', () => { synthesisSettings.push(JSON.parse(body)); res.setHeader('Content-Type', 'audio/wav'); res.end(body.includes('再生開始に重なる長い題名') ? readFileSync(join(directory, 'long-title.wav')) : body.includes('別サーバー読み上げ') ? readFileSync(join(directory, 'scope-speech.wav')) : wav); }); }
  else { res.statusCode = 404; res.end(); }
});
engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
const config = normalizeConfig({ desktop: { closeToTray: false, notifications: false }, speech: { output: 'both', engineUrl: `http://127.0.0.1:${engine.address().port}`, bouyomiPreprocess: false }, media: { output: 'both', allowedHosts: [...normalizeConfig().media.allowedHosts, 'media-fixture.test'] } });
writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'nyan-audio-verification', type: 'module', main: 'audio-bootstrap.mjs', version: JSON.parse(readFileSync(join(root, 'package.json'))).version }));
writeFileSync(join(directory, 'audio-bootstrap.mjs'), `
import { app, session } from 'electron';
app.whenReady().then(() => { const originalDisplayHandler = session.defaultSession.setDisplayMediaRequestHandler;
session.defaultSession.setDisplayMediaRequestHandler = function(handler, ...args) { globalThis.nyanProductionDisplayHandler = handler; this.setDisplayMediaRequestHandler = originalDisplayHandler; return originalDisplayHandler.call(this, handler, ...args); }; });
import { VoiceOutput, PcmMixer } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/runtime/voice-output.mjs')).href)};
// This renderer/PC test substitutes a Discord receiver. The isolated production
// worker and packet clock have a separate real worker/UDP continuity probe.
VoiceOutput.prototype.createAudioBackend = () => null;
import { EventEmitter } from 'node:events'; import { PassThrough } from 'node:stream';
const originalVoiceConnect = VoiceOutput.prototype.connect, originalDisconnect = VoiceOutput.prototype.disconnect;
VoiceOutput.prototype.connect = async function(guildId, ...args) {
  if (['11111', '33333'].includes(guildId)) {
    globalThis.nyanScopeVoice = this;
    if (!this.connections.has(guildId)) {
      const mixer = new PcmMixer(), stats = { frames: 0, peaks: [], clears: 0, rawPeaks: [] }, connection = { state: {status:'ready'}, joinConfig:{selfDeaf:true}, rejoin(){return true;}, destroy(){this.state.status='destroyed';clearInterval(timer);} };
      const clear = mixer.clearMedia.bind(mixer); mixer.clearMedia = () => { stats.clears++; clear(); };
      const add = mixer.addMedia.bind(mixer); mixer.addMedia = bytes => { let peak=0;for(let i=0;i+1<bytes.length;i+=2)peak=Math.max(peak,Math.abs(bytes.readInt16LE(i)));stats.rawPeaks.push(peak);if(stats.rawPeaks.length>100)stats.rawPeaks.shift();add(bytes); };
      const timer = setInterval(() => { if(mixer.destroyed)return;const bytes=mixer.takeFrame();let peak=0;for(let i=0;i+1<bytes.length;i+=2)peak=Math.max(peak,Math.abs(bytes.readInt16LE(i)));stats.frames++;stats.peaks.push(peak);if(stats.peaks.length>20)stats.peaks.shift(); },20);
      const channelId = this.getConfig().bot.bindings.find(b=>b.guildId===guildId).voiceChannelId; this.connections.set(guildId,{channelId,connection,mixer,stats,player:{stop(){}}});this.mediaSettings(mixer,this.getConfig());
    }
    this.changed();return this.connections.get(guildId);
  }
  if (guildId !== '99998') return originalVoiceConnect.call(this, guildId, ...args);
  if (!this.connections.has(guildId)) {
    const speaking = new EventEmitter(); speaking.users = new Map(); const streams = new Map();
    const connection = new EventEmitter(); Object.assign(connection, { state: { status: 'ready' }, joinConfig: { selfDeaf: false }, rejoin: () => true, destroy: () => { connection.state.status = 'destroyed'; }, receiver: { speaking, subscribe: id => { const stream = new PassThrough({ objectMode: true }); streams.set(id, stream); return stream; } } });
    this.monitorFixtureClient = this.getClient; this.getClient = () => ({ user: { id: '99999' }, isReady: () => true });
    const entry = { channelId: '33333', connection, mixer: new PcmMixer(), player: { stop() {} } }; this.connections.set(guildId, entry); globalThis.nyanMonitorFixture = { speaking, streams, monitor: this.monitor };
  }
  this.syncMonitor(); this.changed(); return this.connections.get(guildId);
};
VoiceOutput.prototype.disconnect = function(guildId, ...args) { const result = originalDisconnect.call(this, guildId, ...args); if (guildId === '99998' && this.monitorFixtureClient) { this.getClient = this.monitorFixtureClient; this.monitorFixtureClient = null; } return result; };
import { MediaTitleCalls } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/core/media-title-calls.mjs')).href)};
const titlePlay = MediaTitleCalls.prototype.play;
MediaTitleCalls.prototype.play = function(job, ...args) {
  if (job.payload.url.startsWith('http://media-fixture.test/title-')) job.payload.source = '送信者由来の名前';
  if (job.payload.url.endsWith('/title-slow-preparation')) job.payload.title = '取得中に読む短い題名';
  if (job.payload.url.endsWith('/title-long-overlap') || job.payload.url.endsWith('/title-direct-overlap')) job.payload.title = '再生開始に重なる長い題名';
  return titlePlay.call(this, job, ...args);
};
import { MediaStreamResolver } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/runtime/media-streams.mjs')).href)};
import { HourlyHistory } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/runtime/hourly-history.mjs')).href)};
const historyRows = Array.from({length:5000},(_,i)=>({id:String(10000+i),guildId:'11111',channelId:'22222',createdTimestamp:i+1,content:'猫が時計を眺める。森の太陽は月の料理を運ぶ。'.repeat(70)}));
const historyClient={isReady:()=>true,user:{},channels:{fetch:async()=>({guildId:'11111',name:'負荷試験',permissionsFor:()=>({has:()=>true}),messages:{fetch:async options=>{await new Promise(resolve=>setTimeout(resolve,200));return new Map(historyRows.filter(m=>!options.before||BigInt(m.id)<BigInt(options.before)).reverse().slice(0,options.limit).map(m=>[m.id,m]));}}})}};
const sync = HourlyHistory.prototype.sync;
HourlyHistory.prototype.sync = function(...args) {
  this.getClient=()=>historyClient; globalThis.nyanAudioHistory=this;
  const metrics=globalThis.nyanHistoryMetrics={ticks:0,maxGapMs:0}; let previous=performance.now();
  const timer=setInterval(()=>{const now=performance.now();metrics.ticks++;metrics.maxGapMs=Math.max(metrics.maxGapMs,now-previous);previous=now;},20);
  return sync.apply(this,args).finally(()=>clearInterval(timer));
};
const original = MediaStreamResolver.prototype.resolve;
MediaStreamResolver.prototype.resolve = function(url, signal) {
  if (['/title-slow-preparation', '/title-long-overlap', '/title-direct-overlap'].includes(new URL(url).pathname)) {
    const timing = { url, extractionStartedAt: Date.now() }; (globalThis.nyanTitleTimings ||= []).push(timing);
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); timing.extractionFinishedAt = Date.now(); resolve({ url: ${JSON.stringify(join(directory, 'audio.ogg'))}, audioOnly: true, service: 'fixture', headers: {} }); }, url.endsWith('/title-slow-preparation') ? 4000 : 400);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
  if (url === 'https://www.youtube.com/watch?v=NyanBgm0001') return Promise.resolve({ url: ${JSON.stringify(join(directory, 'audio.ogg'))}, audioOnly: true, service: 'youtube', headers: {} });
  if (url.startsWith('http://media-fixture.test/stream')) return Promise.resolve({ url: ${JSON.stringify(join(directory, 'audio.ogg'))}, audioOnly: true, service: 'fixture', headers: {} });
  return original.call(this, url, signal);
};
import { HourlyRuntime } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/runtime/hourly.mjs')).href)};
const originalSentence = HourlyRuntime.prototype.sentence;
HourlyRuntime.prototype.sentence = function(...args) { return globalThis.nyanBgmFixture ? Promise.resolve({ text: '猫は時計を眺めるのだ。', nouns: ['猫', '時計'] }) : originalSentence.apply(this, args); };
import { AndroidRuntime } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/runtime/android.mjs')).href)};
import { shellQuote } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/core/android-packages.mjs')).href)};
const originalAdb = AndroidRuntime.prototype.adb;
AndroidRuntime.prototype.start = async function() { this.child = {exitCode:0, signalCode:null, kill(){}, unref(){}}; this.status = 'running'; globalThis.nyanNotificationRecords = new Map(); this.change(); return this.snapshot(); };
AndroidRuntime.prototype.adb = function(args, options) {
  const records = globalThis.nyanNotificationRecords;
  if (records && args[1] === 'cmd notification list') return Promise.resolve([...records.keys()].join('\\n'));
  if (records && args[1]?.startsWith('cmd notification get ')) return Promise.resolve([...records.entries()].find(([key]) => args[1] === 'cmd notification get ' + shellQuote(key))?.[1] || '');
  return originalAdb.call(this, args, options);
};
await import(${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/main.mjs')).href)});
`);
let application, monitor;
const monitorChunks = [];
if (process.env.NYAN_AUDIO_MONITOR_SOURCE) {
  monitor = spawn(process.env.NYAN_PAREC || 'parec', ['--device=' + process.env.NYAN_AUDIO_MONITOR_SOURCE, '--rate=48000', '--channels=2', '--format=s16le', '--raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
  monitor.stdout.on('data', bytes => monitorChunks.push(bytes));
  monitor.on('error', error => { console.error(error); process.exitCode = 1; });
}
const networkReport = await verifyAudioNetwork();
const report = { network: networkReport, platform: process.platform, version: JSON.parse(readFileSync(join(root, 'package.json'))).version, fixtureEngine: true, discordLogin: false, speech: [], media: [] };
const call = async (page, action, data) => {
  const result = await page.evaluate(async ({ action, data }) => window.nyan.invoke(action, data), { action, data });
  assert.equal(result.ok, true, result.error); return result.value;
};
const waitForJob = async (page, id, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const state = await call(page, 'state'), job = state.jobs.find(j => j.id === id);
    if (job && !['waiting', 'running'].includes(job.status)) { assert.equal(job.status, 'completed', job.error); return state; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Job ${id} did not complete within ${timeout}ms`);
};
async function encodedAudio(pcm) {
  const mixer = new PcmMixer(); mixer.mediaVolume = 1;
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  let packets = 0, peak = 0, nonSilentSamples = 0;
  player._preparePacket = packet => {
    packets++; const bytes = decoder.decode(packet);
    for (let i = 0; i + 1 < bytes.length; i += 2) { const sample = Math.abs(bytes.readInt16LE(i)); peak = Math.max(peak, sample); if (sample > 1) nonSilentSamples++; }
  };
  try {
    player.play(createDiscordAudioResource(mixer));
    for (let position = 0; position < pcm.length; position += 3840) { mixer.addMedia(pcm.subarray(position, position + 3840)); await new Promise(resolve => setTimeout(resolve, 20)); }
    await new Promise(resolve => setTimeout(resolve, 200));
    return { packets, peak, nonSilentSamples };
  } finally { player.stop(true); mixer.destroy(); decoder.delete(); }
}
const liveService = url => /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(url).hostname) ? 'youtube' : /(^|\.)nicovideo\.jp$/.test(new URL(url).hostname) ? 'niconico' : new URL(url).hostname;
try {
  const env = { ...process.env, NYAN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [directory, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], env, timeout: 20000 });
  application.on('console', message => console.log('Electron:', message.text()));
  const page = await application.firstWindow(); await page.waitForFunction(() => Boolean(window.nyan && document.querySelector('#version').textContent.includes('0.')));
  const fadeFields = ['media.duckFadeOutMs', 'media.duckFadeInMs', 'hourly.bgmFadeInMs', 'hourly.bgmFadeOutMs'];
  for (const key of fadeFields) assert.equal(await page.locator(`[data-config="${key}"]`).inputValue(), '3');
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator('[data-config="desktop.networkProfile"]').inputValue(), 'poor');
  assert.equal(await page.locator('[data-config="desktop.audioBitrateKbps"]').inputValue(), '48');
  await page.locator('[data-config="desktop.networkProfile"]').selectOption('balanced');
  assert.equal(await page.locator('[data-config="desktop.audioBitrateKbps"]').inputValue(), '96');
  await page.locator('[data-config="desktop.audioBitrateKbps"]').fill('64');
  await page.locator('[data-panel="settings"] .save-config').first().click();
  await page.reload(); await page.waitForFunction(() => Boolean(window.nyan));
  assert.equal(await page.locator('[data-config="desktop.networkProfile"]').inputValue(), 'balanced');
  assert.equal(await page.locator('[data-config="desktop.audioBitrateKbps"]').inputValue(), '64');
  report.network.customBitrateSaved = 64;
  const networkConfig = (await call(page, 'state')).config; networkConfig.desktop.networkProfile = 'poor'; networkConfig.desktop.audioBitrateKbps = 48; await call(page, 'config:save', networkConfig);
  report.network.settingsSaved = true;
  await page.locator('[data-view="settings"]').click();
  await page.screenshot({ path: join(reports, 'media-settings.png'), fullPage: true });
  await page.locator('[data-view="hourly"]').click();
  await page.screenshot({ path: join(reports, 'hourly-settings.png'), fullPage: true });
  await page.locator('[data-view="settings"]').click();
  for (const key of fadeFields) await page.locator(`[data-config="${key}"]`).evaluate(element => { element.value = '1.2'; });
  await page.locator('[data-panel="settings"] .save-config').first().click();
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.config.media.duckFadeOutMs === 1200);
  const saved = (await call(page, 'state')).config;
  for (const key of fadeFields) { const [section, name] = key.split('.'); assert.equal(saved[section][name], 1200); }
  for (const key of fadeFields) await page.locator(`[data-config="${key}"]`).evaluate(element => { element.value = '3'; });
  await page.locator('[data-panel="settings"] .save-config').first().click();
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.config.media.duckFadeOutMs === 3000);
  report.fadeSettings = { defaultsSeconds: 3, savedSeconds: 1.2, savedMilliseconds: 1200, passed: true };
  // Use the production settings controls, then reload the renderer and inspect
  // the persisted config; this catches preset/custom wiring and packaged imports.
  const effectsField = path => page.locator(`[data-config="media.${path}"]`);
  assert.equal(await effectsField('titleCallEnabled').isChecked(), true);
  assert.equal(await effectsField('titleCallDucking').inputValue(), '0.8');
  assert.equal(await effectsField('titleCallSpeedRatio').inputValue(), '0.85');
  await effectsField('titleCallSpeedRatio').fill('0.9');
  assert.equal(await effectsField('equalizer.enabled').isChecked(), true);
  assert.equal(await effectsField('compressor.enabled').isChecked(), true);
  assert.equal(await effectsField('equalizer.preset').inputValue(), 'discord1');
  assert.equal(await effectsField('compressor.preset').inputValue(), 'discord1');
  for (const preset of ['discord2', 'discord3']) { await effectsField('equalizer.preset').selectOption(preset); await effectsField('compressor.preset').selectOption(preset); }
  await effectsField('equalizer.preset').selectOption('clarity');
  assert.equal(await effectsField('equalizer.enabled').isChecked(), true);
  assert.equal(await effectsField('equalizer.gains.3').inputValue(), '3');
  await effectsField('compressor.preset').selectOption('level');
  assert.equal(await effectsField('compressor.enabled').isChecked(), true);
  assert.equal(await effectsField('compressor.ratio').inputValue(), '3');
  await effectsField('equalizer.gains.0').fill('-5');
  await effectsField('compressor.ratio').fill('3.5');
  assert.equal(await effectsField('equalizer.preset').inputValue(), 'custom');
  assert.equal(await effectsField('compressor.preset').inputValue(), 'custom');
  await page.locator('[data-panel="settings"] .save-config').first().click();
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.config.media.compressor.ratio === 3.5);
  await page.reload(); await page.waitForFunction(() => document.querySelector('[data-config="media.compressor.ratio"]').value === '3.5');
  assert.equal(await effectsField('titleCallSpeedRatio').inputValue(), '0.9');
  await page.locator('[data-view="settings"]').click();
  await effectsField('titleCallSpeedRatio').fill('0.85');
  await page.locator('[data-panel="settings"] .save-config').first().click();
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.config.media.titleCallSpeedRatio === 0.85);
  await page.locator('[data-view="settings"]').click();
  assert.equal(await effectsField('equalizer.gains.0').inputValue(), '-5');
  const effectSettings = (await call(page, 'state')).config.media;
  const persisted = JSON.parse(readFileSync(join(directory, 'config.json')));
  assert.deepEqual(persisted.media.equalizer, effectSettings.equalizer); assert.deepEqual(persisted.media.compressor, effectSettings.compressor);
  await effectsField('equalizer.enabled').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(reports, 'media-effects-settings.png'), fullPage: true });
  report.mediaEffects = { discordPresetByDefault: 'discord1', discordPresetsSelectable: true, eqPresetApplied: true, compressorPresetApplied: true, customSaved: true, rendererReloadVerified: true, equalizer: effectSettings.equalizer, compressor: effectSettings.compressor };
  await page.locator('[data-view="overview"]').click();
  // Observe actual production renderer PCM, not a mock getDisplayMedia or Audio element.
  await application.evaluate(async ({ BrowserWindow, ipcMain, session, net }, { wav, video, audio, scopeVideo, scopeAudio }) => {
    const ui = BrowserWindow.getAllWindows()[0];
    const probe = globalThis.nyanAudioProbe = { ui, target: ui, active: 'speech', metrics: {}, chunks: {} };
    ui.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      if (!probe.capture) return globalThis.nyanProductionDisplayHandler(request, callback);
      probe.capture = false;
      if (request.frame !== ui.webContents.mainFrame || probe.target.isDestroyed()) return callback({});
      callback({ video: probe.target.webContents.mainFrame, audio: probe.target.webContents.mainFrame, enableLocalEcho: true });
    });
    ipcMain.on('nyan:pcm', (event, id, bytes) => {
      if (event.sender !== ui.webContents || id !== 'audio-probe') return;
      const label = probe.active, buffer = Buffer.from(bytes);
      const metrics = probe.metrics[label] ||= { frames: 0, nonSilentSamples: 0, peak: 0 };
      metrics.frames++;
      if (label === 'hourly' && !metrics.fourthToneAt) {
        let crossings = 0, previous = 0, peak = 0;
        for (let i = 0; i + 3 < buffer.length; i += 4) { const sample = buffer.readInt16LE(i); peak = Math.max(peak, Math.abs(sample)); if (i && (sample >= 0) !== (previous >= 0)) crossings++; previous = sample; }
        const frequency = crossings * 48000 / (2 * (buffer.length / 4));
        if (peak > 500 && frequency >= 800 && frequency <= 950) metrics.fourthToneAt = Date.now();
      }
      for (let i = 0; i + 1 < buffer.length; i += 2) { const v = Math.abs(buffer.readInt16LE(i)); metrics.peak = Math.max(metrics.peak, v); if (v > 100) { metrics.nonSilentSamples++; if(globalThis.nyanAudioHistory?.syncing) metrics.samplesDuringHistory=(metrics.samplesDuringHistory||0)+1; } }
      const expected = label === 'hourly-bgm' || label.includes('audio') || label.startsWith('stream') ? 660 : label.startsWith('video') ? 880 : null;
      if (expected) {
        let crossings = 0, previous = 0, framePeak = 0;
        for (let i = 0; i + 3 < buffer.length; i += 4) { const sample = buffer.readInt16LE(i); framePeak = Math.max(framePeak, Math.abs(sample)); if (i && (sample >= 0) !== (previous >= 0)) crossings++; previous = sample; }
        const frequency = crossings * 48000 / (2 * (buffer.length / 4));
        if (framePeak > 100 && Math.abs(frequency - expected) < 75) metrics.mediaToneSamples = (metrics.mediaToneSamples || 0) + buffer.length / 4;
      }
      if (label !== 'speech' && (probe.chunks[label]?.length || 0) < 4000) (probe.chunks[label] ||= []).push(buffer);
    });
    const mediaSession = session.fromPartition('persist:nyan-playback');
    await mediaSession.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (globalThis.nyanBgmFixture && url.hostname === 'www.youtube.com' && url.pathname === '/results') return new Response('<!doctype html><script>window.ytInitialData={videoRenderer:{videoId:"NyanBgm0001",lengthText:{simpleText:"0:04"},title:{runs:[{text:"PC BGM fixture"}]}}}</script>', { headers: { 'Content-Type': 'text/html' } });
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    });
    await mediaSession.protocol.handle('http', async request => {
      if (new URL(request.url).hostname !== 'media-fixture.test') return net.fetch(request, { bypassCustomProtocolHandlers: true });
      const file = new URL(request.url).pathname;
      if (file === '/video.webm') return new Response(new Uint8Array(video), { headers: { 'Content-Type': 'video/webm' } });
      if (file === '/scope-video.ogg' || file === '/scope-audio.ogg') return new Response(new Uint8Array(file.includes('video') ? scopeVideo : scopeAudio), { headers: { 'Content-Type': 'audio/ogg' } });
      if (file === '/audio.ogg') return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/ogg' } });
      if (file === '/title-unknown' || file === '/title-author') {
        // Metadata resolves early; actual page loading stays slow enough to
        // expose a wrong fallback to Discord sender identity after that result.
        if (file === '/title-unknown' && (request.headers.get('accept') || '').includes('text/html')) await new Promise(resolve => setTimeout(resolve, 5000));
        const author = file === '/title-author' ? '<meta name="author" content="リンク先の投稿者">' : '';
        return new Response(`<!doctype html>${author}<video muted controls src="/video.webm"></video>`, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
      }
      const tag = file.includes('audio') ? 'audio' : 'video', source = file.includes('scope') ? (tag === 'audio' ? '/scope-audio.ogg' : '/scope-video.ogg') : tag === 'audio' ? '/audio.ogg' : '/video.webm';
      const replace = file.includes('replace') ? `<script>document.querySelector('${tag}').addEventListener('ended', () => { const next = document.createElement('video'); next.controls = true; next.autoplay = true; next.src = '/video.webm'; document.querySelector('${tag}').replaceWith(next); });</script>` : '';
      return new Response(`<!doctype html><title>メディア音声試験</title><${tag} muted controls src="${source}"></${tag}>${replace}`, { headers: { 'Content-Type': 'text/html' } });
    });
    ui.webContents.session.setPermissionRequestHandler((web, permission, callback) => callback(web === ui.webContents && ['media', 'display-capture', 'speaker-selection'].includes(permission)));
  }, { wav: [...wav], video: [...readFileSync(join(directory, 'video.webm'))], audio: [...readFileSync(join(directory, 'audio.ogg'))], scopeVideo: [...readFileSync(join(directory, 'scope-video.ogg'))], scopeAudio: [...readFileSync(join(directory, 'scope-audio.ogg'))] });
  await application.evaluate(() => { globalThis.nyanAudioProbe.capture = true; });
  await page.evaluate(() => window.nyanCapture({ type: 'capture:start', id: 'audio-probe' }));
  await page.evaluate(() => { window.__nyanDisplayed = []; new MutationObserver(() => window.__nyanDisplayed.push(document.querySelector('#now-playing').textContent)).observe(document.querySelector('#now-playing'), { childList: true, subtree: true }); });
  const historyConfig=(await call(page,'state')).config; historyConfig.hourly.servers=[{guildId:'11111',channelIds:['22222'],enabled:true,bgm:false}];
  await call(page,'config:save',historyConfig);
  const historyTask=call(page,'hourly:sync'); historyTask.catch(()=>{});
  const jobs = [];
  for (let n = 1; n <= 3; n++) jobs.push(await call(page, 'speech:test', { text: `連続読み上げ${n}`, styleId: 3 }));
  for (const job of jobs) { await waitForJob(page, job.id); report.speech.push({ text: job.payload.text, status: 'completed' }); }
  await page.waitForFunction(() => document.querySelector('#now-playing').textContent.includes('再生中の項目はありません'));
  const displayed = await page.evaluate(() => window.__nyanDisplayed);
  for (const job of jobs) assert.ok(displayed.some(text => text.includes(job.payload.text)), `Now-playing did not show ${job.payload.text}`);
  report.nowPlayingUpdated = true;
  // Exercise the actual IPC/queue/synthesis path, not only the text helper.
  const latinConfig = (await call(page, 'state')).config;
  latinConfig.dictionary.push({ source: 'override', replacement: 'CAT', scope: 'global', regex: false, caseSensitive: false });
  await call(page, 'config:save', latinConfig);
  const latinInput = 'A b n N ka NYAN override https://example.test/ABC';
  const latinExpected = 'エー ビー エヌ エヌ か にゃん CAT URL';
  const latinJob = await call(page, 'speech:test', { text: latinInput, styleId: 3 });
  await waitForJob(page, latinJob.id);
  assert.equal(synthesisTexts.at(-1), latinExpected);
  report.latinReading = { input: latinInput, synthesisText: synthesisTexts.at(-1), singleLetters: true, romaji: true, standaloneN: true, dictionaryPriority: true, urlExcluded: true, passed: true };
  const speechMetrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics.speech);
  assert.ok(speechMetrics?.nonSilentSamples > 1000, `Speech audio missing: ${JSON.stringify(speechMetrics)}`); report.speechAudio = speechMetrics;
  await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  // Validate the full production MediaBrowser with both VIDEO and AUDIO HTML players.
  for (const kind of ['video', 'audio', 'video-replace-full', 'video-replace-direct', 'stream-full', 'stream-direct']) {
    const job = await call(page, 'media:add', { url: `http://media-fixture.test/${kind}`, mode: kind.endsWith('full') || kind === 'audio' ? 'full' : 'direct' });
    await application.evaluate(async ({ BrowserWindow }, kind) => {
      const probe = globalThis.nyanAudioProbe;
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const target = BrowserWindow.getAllWindows().find(w => w !== probe.ui && !w.isDestroyed());
        if (target) { probe.target = probe.ui; probe.active = kind; probe.capture = true; await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true); return; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Playback window did not open');
    }, kind);
    await waitForJob(page, job.id);
    const metrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics[globalThis.nyanAudioProbe.active]);
    assert.ok(metrics?.mediaToneSamples > 4800, `${kind} audio did not reach PC output (announcement excluded): ${JSON.stringify(metrics)}`);
    report.media.push({ kind, status: 'completed', pcPlayback: true, ...metrics });
    await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  }
  const titleIdentityJobs = [];
  for (const kind of ['title-author', 'title-unknown']) {
    const job = await call(page, 'media:add', { url: `http://media-fixture.test/${kind}`, mode: 'direct' });
    await waitForJob(page, job.id);
    const savedJob = (await call(page, 'state')).jobs.find(j => j.id === job.id);
    assert.equal(savedJob.payload.source, '送信者由来の名前', 'The provenance fixture must include a Discord sender');
    titleIdentityJobs.push(savedJob.id);
  }
  const titleJobs = (await call(page, 'state')).jobs.filter(j => j.kind === 'speech' && j.payload.titleCall && j.status === 'completed');
  assert.ok(titleJobs.some(j => j.payload.text === 'メディア音声試験'), 'The playback page title did not reach the production speech path');
  const titleSynthesis = synthesisSettings.filter(query => query.verificationText === 'メディア音声試験');
  assert.ok(titleSynthesis.length > 0 && titleSynthesis.every(query => Math.abs(query.speedScale - 0.85) < 1e-6), 'Title speed did not reach VOICEVOX');
  const authorRead = titleJobs.some(j => j.payload.text === 'リンク先の投稿者');
  const unknownRepeats = titleJobs.filter(j => j.payload.text === 'メディアを取得中です').length;
  assert.equal(authorRead, true, 'Resource author metadata did not reach speech');
  assert.ok(unknownRepeats >= 2, 'Missing resource metadata must keep the preparation announcement repeating');
  assert.ok(!synthesisTexts.includes('送信者由来の名前'), 'Discord sender identity leaked into title speech');
  report.titleCalls = { enabledByDefault: true, defaultMediaRatio: 0.8, speedRatio: 0.85, speedSettingSaved: true, synthesisSpeedVerified: true, resourceAuthorRead: authorRead, discordSenderIgnored: true, unknownMetadataRepeats: unknownRepeats, titleIdentityJobs: titleIdentityJobs.length, completed: titleJobs.length, pageTitleRead: true, speechTexts: titleJobs.map(j => j.payload.text), receiverVerified: false };
  // Hold extraction and title audio independently through the production
  // browser/capture path. Playback must not wait for the spoken title to end.
  report.titleCalls.preparationTimings = [];
  for (const [kind, mode] of [['title-slow-preparation', 'full'], ['title-long-overlap', 'preview'], ['title-direct-overlap', 'direct']]) {
    const before = new Set((await call(page, 'state')).jobs.map(j => j.id));
    const job = await call(page, 'media:add', { url: `http://media-fixture.test/${kind}`, mode });
    const state = await waitForJob(page, job.id, 20000), saved = state.jobs.find(j => j.id === job.id);
    const speech = state.jobs.filter(j => !before.has(j.id) && j.kind === 'speech');
    const title = speech.find(j => j.payload.titleCall), announcement = speech.find(j => !j.payload.titleCall);
    assert.equal(title?.status, 'completed', 'Title speech did not complete');
    if (mode === 'direct') assert.equal(announcement, undefined);
    else { assert.equal(announcement?.status, 'completed'); assert.ok(Date.parse(announcement.finishedAt) <= Date.parse(saved.mediaPreparingAt)); }
    const timing = await application.evaluate((_electron, url) => globalThis.nyanTitleTimings.find(t => t.url === url), saved.payload.url);
    assert.ok(timing?.extractionFinishedAt, 'The held extraction did not finish');
    const preparedAt = Date.parse(saved.mediaPreparingAt), titleStartedAt = Date.parse(title.startedAt), titleFinishedAt = Date.parse(title.finishedAt), mediaStartedAt = Date.parse(saved.mediaStartedAt);
    assert.ok(preparedAt <= timing.extractionStartedAt && timing.extractionStartedAt <= titleStartedAt, 'Media extraction started after title speech');
    if (kind === 'title-slow-preparation') assert.ok(titleFinishedAt < timing.extractionFinishedAt, 'Title did not play during slow extraction');
    else assert.ok(titleStartedAt <= mediaStartedAt && mediaStartedAt < titleFinishedAt, 'Playback waited for long title speech to finish');
    report.titleCalls.preparationTimings.push({ kind, mode, extractionStartMs: timing.extractionStartedAt - preparedAt, extractionEndMs: timing.extractionFinishedAt - preparedAt, titleStartMs: titleStartedAt - preparedAt, titleEndMs: titleFinishedAt - preparedAt, mediaStartMs: mediaStartedAt - preparedAt });
  }
  report.titleCalls.extractionConcurrent = true;
  report.titleCalls.playbackDoesNotWaitForTitle = true;
  await historyTask;
  report.historyConcurrent = await application.evaluate(() => ({...globalThis.nyanHistoryMetrics,...globalThis.nyanAudioHistory.snapshot(),speechSamples:globalThis.nyanAudioProbe.metrics.speech.samplesDuringHistory||0,videoSamples:globalThis.nyanAudioProbe.metrics.video.samplesDuringHistory||0}));
  assert.ok(report.historyConcurrent.messages>0 && report.historyConcurrent.messages<=500,'History exceeded its per-sync budget or recorded no messages');
  assert.ok(report.historyConcurrent.ticks>20 && report.historyConcurrent.maxGapMs<250,'History blocked the audio control event loop');
  assert.ok(report.historyConcurrent.speechSamples>1000 && report.historyConcurrent.videoSamples>1000,'Speech or video audio did not flow during the first history import');
  // Real Chromium tab capture, PC gain and two independent production mixers.
  // Only Discord transport is substituted; this does not measure a receiver.
  const restoreScopeConfig = (await call(page, 'state')).config;
  const scopeConfig = structuredClone(restoreScopeConfig);
  scopeConfig.bot.bindings = [{ guildId:'11111',textChannelIds:['22222'],voiceChannelId:'44444' },{ guildId:'33333',textChannelIds:['55555'],voiceChannelId:'66666' }];
  Object.assign(scopeConfig.media,{output:'both',volume:0.5,ducking:0.35,titleCallEnabled:false,duckFadeInMs:0,duckFadeOutMs:0});
  scopeConfig.media.equalizer.enabled=false;scopeConfig.media.compressor.enabled=false;scopeConfig.speech.output='both';Object.assign(scopeConfig.hourly,{output:'both',servers:[],fadeMs:100});
  await call(page,'config:save',scopeConfig);await call(page,'voice:join','11111');await call(page,'voice:join','33333');
  const scopeA=await call(page,'media:add',{url:'http://media-fixture.test/scope-video',mode:'direct',guildId:'11111'});
  const scopeB=await call(page,'media:add',{url:'http://media-fixture.test/scope-audio',mode:'direct',guildId:'33333'});
  await page.waitForFunction(async ids=>{const s=(await window.nyan.invoke('state')).value;return ids.every(id=>s.jobs.find(j=>j.id===id)?.mediaStartedAt);},[scopeA.id,scopeB.id]);
  const scopeStats=()=>application.evaluate(()=>Object.fromEntries(['11111','33333'].map(id=>{const e=globalThis.nyanScopeVoice.connections.get(id);return[id,{...e.stats,duck:e.mixer.duckGain.to,speaking:e.mixer.speech.length,mediaVolume:e.mixer.mediaVolume,overlay:e.mixer.mediaGain.to}];})));
  let beforeScope;const scopeReadyUntil=Date.now()+6000;do{beforeScope=await scopeStats();if(['11111','33333'].every(id=>beforeScope[id].peaks.some(p=>p>500)))break;await page.waitForTimeout(80);}while(Date.now()<scopeReadyUntil);
  assert.ok(beforeScope['11111'].peaks.some(p=>p>500)&&beforeScope['33333'].peaks.some(p=>p>500),'Both guilds must receive independent media PCM: '+JSON.stringify(beforeScope));
  const scopedSpeech=await call(page,'speech:test',{text:'別サーバー読み上げ',guildId:'33333'});
  await page.waitForFunction(async ids=>{const volumes=window.nyanLocalAudio.snapshot().captureVolumes;return ids.every(id=>Math.abs((volumes.find(c=>c.id===id)?.gain??-1)-0.175)<0.01);},[scopeA.id,scopeB.id]);
  await page.waitForTimeout(150);const duringScope=await scopeStats();
  assert.equal(duringScope['11111'].duck,1);assert.equal(duringScope['11111'].speaking,0);assert.equal(duringScope['33333'].duck,0.35);assert.ok(duringScope['33333'].speaking>0);
  assert.ok(duringScope['11111'].rawPeaks.slice(-5).every(p=>p>2000),'PC attenuation leaked into raw Discord PCM');
  assert.ok(duringScope['11111'].peaks.slice(-5).every(p=>p>1000),'Other-guild speech attenuated Discord media');
  const pcDuring=await page.evaluate(()=>window.nyanLocalAudio.snapshot().captureVolumes);
  await waitForJob(page,scopedSpeech.id);
  await page.waitForFunction(ids=>{const volumes=window.nyanLocalAudio.snapshot().captureVolumes;return ids.every(id=>Math.abs((volumes.find(c=>c.id===id)?.gain??-1)-0.5)<0.01);},[scopeA.id,scopeB.id]);
  const beforeReplacement=await scopeStats();
  const nextScopeA=await call(page,'media:add',{url:'http://media-fixture.test/scope-video-new',mode:'direct',guildId:'11111'});
  await page.waitForFunction(async ids=>{const s=(await window.nyan.invoke('state')).value;return s.jobs.find(j=>j.id===ids[0])?.status==='cancelled'&&s.jobs.find(j=>j.id===ids[1])?.mediaStartedAt&&s.jobs.find(j=>j.id===ids[2])?.status==='running';},[scopeA.id,nextScopeA.id,scopeB.id]);
  const afterReplacement=await scopeStats();assert.equal(afterReplacement['33333'].clears,beforeReplacement['33333'].clears);assert.ok(afterReplacement['33333'].frames>beforeReplacement['33333'].frames);
  const playerVolumes=await application.evaluate(async({BrowserWindow})=>Promise.all(BrowserWindow.getAllWindows().filter(w=>w!==globalThis.nyanAudioProbe.ui).map(w=>w.webContents.executeJavaScript('document.querySelector("video,audio")?.volume'))));
  assert.ok(playerVolumes.length>=2&&playerVolumes.every(v=>v===1),'Capture source must remain independent of PC gain');
  report.guildIsolation={receiverVerified:false,scope:'production-capture-and-mixers',simultaneousGuildMedia:true,discordDuckingIsolated:true,pcDuckingGlobal:true,rawCaptureUnaffected:true,sameGuildReplacementIsolated:true,sourceVolumes:playerVolumes,during: duringScope,pcGains:pcDuring.filter(c=>[scopeA.id,scopeB.id].includes(c.id)).map(c=>c.gain)};
  const scopeHourly=call(page,'hourly:test',{});scopeHourly.catch(()=>{});
  await page.waitForFunction(ids=>{const volumes=window.nyanLocalAudio.snapshot().captureVolumes;return ids.every(id=>Math.abs((volumes.find(c=>c.id===id)?.gain??-1)-0.075)<0.01);},[nextScopeA.id,scopeB.id]);
  await page.waitForTimeout(200);const hourlyScopeStats=await scopeStats();
  assert.ok(Object.values(hourlyScopeStats).every(s=>s.overlay===0.15&&s.duck===1),'Hourly global attenuation must be applied once to every guild');
  await scopeHourly;
  await page.waitForFunction(ids=>{const volumes=window.nyanLocalAudio.snapshot().captureVolumes;return ids.every(id=>Math.abs((volumes.find(c=>c.id===id)?.gain??-1)-0.5)<0.01);},[nextScopeA.id,scopeB.id]);
  report.guildIsolation.hourlyDuckingGlobal=true;report.guildIsolation.hourlyNoDoubleDucking=true;
  for(const id of [nextScopeA.id,scopeB.id])await call(page,'job:action',{id,action:'cancel'});
  await page.waitForFunction(()=>window.nyanLocalAudio.snapshot().captureVolumes.length===0);
  await call(page,'voice:leave','11111');await call(page,'voice:leave','33333');await call(page,'config:save',restoreScopeConfig);
  // Native notification retrieval is verified separately on a real Windows AVD.
  // Here inject that wire format through the actual notification reader, queue, VOICEVOX and PC output.
  await call(page, 'android:start');
  await page.waitForTimeout(200);
  const notificationConfig = (await call(page, 'state')).config;
  notificationConfig.android.notificationOutput = 'both'; notificationConfig.speech.output = 'discord';
  await call(page, 'config:save', notificationConfig);
  await call(page, 'bot:stop');
  await page.locator('[data-view="android"]').click();
  assert.equal(await page.locator('[data-config="android.notificationOutput"]').inputValue(), 'both');
  await page.screenshot({ path: join(reports, 'android-notification-settings.png'), fullPage: true });
  await application.evaluate(() => {
    globalThis.nyanAudioProbe.active = 'android'; globalThis.nyanAudioProbe.target = globalThis.nyanAudioProbe.ui; globalThis.nyanAudioProbe.capture = true;
    globalThis.nyanNotificationRecords.set('0|com.android.shell|2020|probe|2000', 'NotificationRecord(pkg=com.android.shell)\n  flags=AUTO_CANCEL\n  notification=\n    extras={\n        android.title=String (通知試験)\n        android.text=String (Androidの通知を読み上げます)\n    }\n  publicNotification=\n    None\n'.replaceAll('\n', '\r\n'));
  });
  await page.evaluate(() => window.nyanCapture({ type: 'capture:start', id: 'audio-probe' }));
  let notificationJob; const notificationUntil = Date.now() + 15000;
  while (!notificationJob && Date.now() < notificationUntil) { notificationJob = (await call(page, 'state')).jobs.find(j => j.payload.androidNotification); if (!notificationJob) await page.waitForTimeout(100); }
  assert.ok(notificationJob, 'Android notification never reached the production speech queue');
  const notificationState = await waitForJob(page, notificationJob.id);
  assert.equal(synthesisTexts.at(-1), '通知試験。Androidの通知を読み上げます');
  const notificationAudio = await application.evaluate(() => globalThis.nyanAudioProbe.metrics.android);
  assert.ok(notificationAudio?.nonSilentSamples > 1000, 'Android notification produced no PC audio without a Bot VC');
  assert.equal(notificationState.android.notifications.count, 1);
  notificationConfig.android.notificationOutput = 'local'; await call(page, 'config:save', notificationConfig);
  notificationConfig.android.readNotifications = false; await call(page, 'config:save', notificationConfig);
  assert.equal((await call(page, 'state')).android.notifications.enabled, false);
  await call(page, 'android:stop');
  notificationConfig.speech.output = 'both'; await call(page, 'config:save', notificationConfig);
  await page.locator('[data-view="overview"]').click();
  report.androidNotifications = { ...notificationAudio, pcFallbackWithoutBotVC: true, pcContinuesAfterBotStopped: true, outputSavedWhileRunning: true, disabledWhileRunning: true, passed: true };
  await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  // The real hourly search -> muted preparation -> chime -> local capture ->
  // fade/stop path, with only search/model/media contents supplied as fixtures.
  const bgmConfig = (await call(page, 'state')).config; bgmConfig.hourly.output = 'both'; bgmConfig.hourly.servers = [{ guildId: '11111', channelIds: ['22222'], enabled: true, bgm: true }];
  bgmConfig.hourly.generationMode = 'live'; bgmConfig.hourly.bgmFadeInMs = 200; bgmConfig.hourly.bgmFadeOutMs = 200;
  await call(page, 'config:save', bgmConfig);
  await application.evaluate(async () => {
    globalThis.nyanBgmFixture = true; const probe = globalThis.nyanAudioProbe; probe.target = probe.ui; probe.active = 'hourly-bgm'; probe.capture = true;
    await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true);
  });
  await call(page, 'hourly:test', { guildId: '11111' });
  const bgmMetrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics['hourly-bgm']);
  assert.ok(bgmMetrics?.mediaToneSamples > 4800, `Hourly BGM did not reach PC speakers (speech/chime excluded): ${JSON.stringify(bgmMetrics)}`);
  (report.hourly ||= {}).pcBackground = { ...bgmMetrics, fixtureSource: true, passed: true };
  await application.evaluate(() => { globalThis.nyanBgmFixture = false; });
  await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  const interrupted = await call(page, 'media:add', { url: 'http://media-fixture.test/video', mode: 'direct' });
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.media.some(m => m.startedAt));
  const replacement = await call(page, 'media:add', { url: 'http://media-fixture.test/audio', mode: 'full' });
  const replacedState = await waitForJob(page, replacement.id);
  assert.equal(replacedState.jobs.find(j => j.id === interrupted.id).status, 'cancelled');
  report.latestRequest = { previousStatus: 'cancelled', latestStatus: 'completed', passed: true };
  // Confirm captured media passes through the same mixer and Opus resource used for Discord.
  const pcm = Buffer.from(await application.evaluate(() => [...Buffer.concat(globalThis.nyanAudioProbe.chunks.video)]));
  const mixer = new PcmMixer(); mixer.mediaVolume = 1;
  mixer.configureEffects(effectSettings);
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
  const decoded = [], decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  player._preparePacket = packet => decoded.push(Buffer.from(decoder.decode(packet)));
  player.play(createDiscordAudioResource(mixer));
  try {
    await new Promise(resolve => { let position = 0; const timer = setInterval(() => { mixer.addMedia(pcm.subarray(position, position + 3840)); position += 3840; if (position >= pcm.length) { clearInterval(timer); resolve(); } }, 20); });
    await new Promise(r => setTimeout(r, 500));
  }
  finally { player.stop(true); mixer.destroy(); decoder.delete(); }
  const bytes = Buffer.concat(decoded); let peak = 0; for (let i = 0; i + 1 < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + bytes.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes.length, 40);
  writeFileSync(join(reports, 'video-after-discord-encoder.wav'), Buffer.concat([header, bytes]));
  report.discordEncoder = { packets: decoded.length, peak, bytes: bytes.length };
  assert.ok(report.discordEncoder.peak > 100);
  report.mediaEffects.opus = { ...report.discordEncoder, passed: true };
  // Exercise the actual timed AudioContext playback and capture its long 880-Hz fourth beep.
  const hourlyConfig = (await call(page, 'state')).config; hourlyConfig.hourly.output = 'both'; hourlyConfig.hourly.enabled = false; hourlyConfig.hourly.servers=[];
  await call(page, 'config:save', hourlyConfig);
  await application.evaluate(async () => {
    const probe = globalThis.nyanAudioProbe; probe.target = probe.ui; probe.active = 'hourly';
    probe.capture = true; await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true);
  });
  const clockTask = call(page, 'hourly:test', {}); clockTask.catch(() => {}); let targetAt;
  const clockUntil = Date.now() + 20000;
  while (Date.now() < clockUntil) {
    const active = (await call(page, 'state')).hourly.active; if (active) { targetAt = active.fourthAt; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await clockTask;
  const clockMetrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics.hourly);
  assert.ok(targetAt && clockMetrics?.fourthToneAt && clockMetrics.nonSilentSamples > 4800, 'The real timed chime did not produce the fourth tone');
  report.hourly = { ...report.hourly, ...clockMetrics, targetAt, measuredCaptureDelayMs: clockMetrics.fourthToneAt - targetAt };
  assert.ok(Math.abs(report.hourly.measuredCaptureDelayMs) < 750, 'The fourth tone was not aligned with the scheduled PC hour');
  const clockPcm = Buffer.from(await application.evaluate(() => [...Buffer.concat(globalThis.nyanAudioProbe.chunks.hourly.slice(-250))]));
  report.hourly.discordEncoder = await encodedAudio(clockPcm); assert.ok(report.hourly.discordEncoder.nonSilentSamples > 4800);
  await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  // Actual Opus receiver -> IPC -> local worklet -> captured PC audio, with a
  // simulated Discord receiver (no Bot credential or real VC is used here).
  const monitorConfig = (await call(page, 'state')).config;
  monitorConfig.bot.bindings.push({ guildId: '99998', voiceChannelId: '33333', textChannelIds: [] });
  monitorConfig.desktop.voiceMonitorGuildId = '99998'; monitorConfig.desktop.voiceMonitorVolume = 0.65;
  const availableSpeakers = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default').map(d => ({ deviceId: d.deviceId, label: d.label })));
  monitorConfig.desktop.outputDevice = availableSpeakers[0]?.deviceId || '';
  await call(page, 'config:save', monitorConfig); await call(page, 'voice:join', '99998');
  await application.evaluate(async () => {
    const probe = globalThis.nyanAudioProbe; probe.target = probe.ui; probe.active = 'voice-monitor'; probe.capture = true;
    await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true);
    globalThis.nyanMonitorFixture.speaking.emit('start', '99999'); globalThis.nyanMonitorFixture.speaking.emit('start', '44444');
  });
  if (availableSpeakers.length) await page.waitForFunction(id => window.nyanLocalAudio.snapshot().monitorSink === id, availableSpeakers[0].deviceId);
  report.speakerSelection = { availableDevices: availableSpeakers.length, actualSinkVerified: Boolean(availableSpeakers.length) };
  const monitorEncoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO); monitorEncoder.encoderCTL(4006, 0); monitorEncoder.encoderCTL(4002, 48000);
  const monitorPcm = wav.subarray(44), monitorPackets = [];
  try { for (let i = 0; i < 100; i++) { const offset = i * 3840 % (Math.floor(monitorPcm.length / 3840) * 3840); monitorPackets.push([...monitorEncoder.encode(monitorPcm.subarray(offset, offset + 3840), 960)]); } } finally { monitorEncoder.delete(); }
  const voiceResult = await application.evaluate(async (_electron, packets) => {
    const fixture = globalThis.nyanMonitorFixture;
    for (const packet of packets) { fixture.streams.get('44444').write(Buffer.from(packet)); await new Promise(resolve => setTimeout(resolve, 20)); }
    await new Promise(resolve => setTimeout(resolve, 650));
    return { selfExcluded: !fixture.streams.has('99999'), receivedUsers: fixture.streams.size, metrics: globalThis.nyanAudioProbe.metrics['voice-monitor'] };
  }, monitorPackets);
  assert.equal(voiceResult.selfExcluded, true); assert.ok(voiceResult.metrics.nonSilentSamples > 1000);
  const longOpusPacket = Buffer.concat([Buffer.from([(monitorPackets[0][0] & 252) | 3, 6]), ...Array(6).fill(Buffer.from(monitorPackets[0]).subarray(1))]);
  report.network.electronLifecycle = await application.evaluate((_electron, bytes) => {
    const fixture = globalThis.nyanMonitorFixture; let recycled = 0;
    for (let round = 0; round < 16; round++) {
      for (let id = 0; id < 31; id++) {
        const key = String(55000 + id); fixture.speaking.emit('start', key); fixture.streams.get(key).write(Buffer.from(bytes)); fixture.streams.get(key).write(Buffer.from(bytes));
      }
      if (!fixture.monitor.frame().some(byte => byte)) throw new Error('Concurrent Opus PCM is silent');
      for (let id = 0; id < 31; id++) {
        const key = String(55000 + id), retired = fixture.streams.get(key); fixture.monitor.users.get(key).ended = true;
        fixture.speaking.emit('start', key); retired.emit('error', new Error('retired subscription'));
        fixture.streams.get(key).write(Buffer.from(bytes)); fixture.monitor.remove(key); recycled += 2;
      }
    }
    return { passed: true, recycled, survivors: fixture.monitor.users.has('44444') };
  }, [...longOpusPacket]);
  assert.equal(report.network.electronLifecycle.passed, true); assert.equal(report.network.electronLifecycle.recycled, 992);
  await page.locator('[data-view="settings"]').click(); await page.screenshot({ path: join(reports, 'voice-monitor-settings.png'), fullPage: true });
  await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  const unavailableConfig = (await call(page, 'state')).config; unavailableConfig.desktop.outputDevice = 'unavailable-speaker-verification'; await call(page, 'config:save', unavailableConfig);
  const deviceFallbackUntil = Date.now() + 5000;
  while (Date.now() < deviceFallbackUntil) {
    const current = await call(page, 'state');
    if (current.logs.some(log => log.text.includes('指定のスピーカーが利用できない')) && await page.evaluate(() => window.nyanLocalAudio.snapshot().monitorSink === '')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const speakerState = await call(page, 'state'); assert.equal(speakerState.config.desktop.outputDevice, 'unavailable-speaker-verification');
  assert.ok(speakerState.logs.some(log => log.text.includes('指定のスピーカーが利用できない')));
  report.voiceMonitor = { ...voiceResult, deviceConfigSaved: true, unavailableDeviceFallback: true, passed: true };
  await call(page, 'voice:leave', '99998');
  const cleanConfig = (await call(page, 'state')).config; cleanConfig.desktop.voiceMonitorGuildId = ''; cleanConfig.desktop.outputDevice = ''; cleanConfig.bot.bindings = []; await call(page, 'config:save', cleanConfig);
  if (monitor) {
    monitor.kill(); await once(monitor, 'close'); monitor = null;
    const output = Buffer.concat(monitorChunks); let outputPeak = 0;
    for (let i = 0; i + 1 < output.length; i += 2) outputPeak = Math.max(outputPeak, Math.abs(output.readInt16LE(i)));
    report.pcOutput = { bytes: output.length, peak: outputPeak, virtualOutputDevice: true };
    assert.ok(outputPeak > 100, 'PC output device received no audible samples');
  }
  report.localFallback = { speech: true, media: true, hourly: true, botInVC: false, passed: true };
  report.passed = true;
  report.liveMedia = [];
  // Public sites can require login, consent or block hosted CI. Record failures explicitly.
  const verifiedServices = new Set();
  for (const url of JSON.parse(process.env.NYAN_LIVE_MEDIA_URLS || '[]')) {
    const service = liveService(url);
    if (process.env.NYAN_REQUIRE_LIVE_SERVICES && verifiedServices.has(service)) continue;
    const outcome = { url, service, verifiedAudio: false };
    let job;
    try {
      job = await call(page, 'media:add', { url, mode: 'direct' });
      await application.evaluate(async ({ BrowserWindow }, label) => {
        const probe = globalThis.nyanAudioProbe; probe.active = label;
        const until = Date.now() + 180000;
        while (Date.now() < until) {
          const target = BrowserWindow.getAllWindows().find(w => w !== probe.ui && !w.isDestroyed());
          if (target) { probe.target = target; probe.capture = true; await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true); return; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Playback window did not open');
      }, url);
      const began = Date.now(), until = began + 55000; let adSamples = 0;
      while (Date.now() < until) {
        const metrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics[globalThis.nyanAudioProbe.active]);
        const adPlaying = await application.evaluate(async () => {
          const target = globalThis.nyanAudioProbe.target; if (target.isDestroyed()) return false;
          return target.webContents.executeJavaScript(`(() => Boolean(document.querySelector('.ad-showing,.ad-interrupting')) || (location.hostname.endsWith('nicovideo.jp') && ([...document.querySelectorAll('video')].some(v => !v.paused && !v.ended && v.duration > 0 && v.duration <= 30) || /[0-9]+\\s*秒後にスキップできます|(?:^|\\n)(?:スキップ|Skip ad)(?:\\n|$)/.test(document.body?.innerText || ''))))()`, true);
        });
        if (adPlaying) adSamples = metrics?.nonSilentSamples || 0;
        const state = await call(page, 'state'); const current = state.jobs.find(j => j.id === job.id);
        if (current.status === 'failed') throw new Error(current.error);
        const playback = state.media.find(m => m.scope === mediaScope(job.payload));
        if (playback?.loginRequired && playback.ready === 0 && Date.now() - began > 5000) throw new Error(playback.blockedReason || 'Site requires login before playback');
        if (!adPlaying && playback?.startedAt && playback.ready >= 2 && playback.currentTime > 2 && metrics?.nonSilentSamples - adSamples > 4800) { Object.assign(outcome, metrics, { verifiedAudio: true }); break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      outcome.playback = (await call(page, 'state')).media;
      outcome.page = await application.evaluate(async () => {
        const target = globalThis.nyanAudioProbe.target;
        if (target.isDestroyed()) return {};
        const diagnostics = await target.webContents.executeJavaScript(`(() => ({
          text: document.body.innerText.slice(0, 2500),
          playability: (() => { const s = window.ytInitialPlayerResponse?.playabilityStatus || document.querySelector('#movie_player')?.getPlayerResponse?.()?.playabilityStatus; return s ? { status: s.status, reason: s.reason } : null; })(),
          media: [...document.querySelectorAll('video,audio')].map(v => ({ ready: v.readyState, paused: v.paused, ended: v.ended, muted: v.muted, volume: v.volume, currentTime: v.currentTime, audioBytes: v.webkitAudioDecodedByteCount, error: v.error?.message })),
          mp4: document.createElement('video').canPlayType('video/mp4; codecs=\"avc1.640028, mp4a.40.2\"')
        }))()`, true);
        return { url: target.webContents.getURL(), title: target.webContents.getTitle(), diagnostics };
      });
      if (outcome.verifiedAudio) {
        const pcm = Buffer.from(await application.evaluate(() => [...Buffer.concat((globalThis.nyanAudioProbe.chunks[globalThis.nyanAudioProbe.active] || []).slice(-50))]));
        outcome.discordEncoder = await encodedAudio(pcm);
        assert.ok(outcome.discordEncoder.nonSilentSamples > 4800, 'Captured main-content audio did not pass through the Discord Opus encoder');
        verifiedServices.add(service);
      }
      if (!outcome.verifiedAudio) outcome.error = 'No audible media samples within 55 seconds; site playback remains unverified';
    } catch (error) { outcome.verifiedAudio = false; outcome.error = error.message; }
    finally {
      if (job) await call(page, 'job:action', { id: job.id, action: 'cancel' }).catch(() => {});
      await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
      report.liveMedia.push(outcome); console.log('LIVE_MEDIA', JSON.stringify(outcome));
    }
  }
  report.requiredLiveServices = (process.env.NYAN_REQUIRE_LIVE_SERVICES || '').split(',').filter(Boolean);
  if ((process.env.NYAN_REQUIRE_LIVE_AUDIO && report.liveMedia.some(m => !m.verifiedAudio)) || report.requiredLiveServices.some(service => !verifiedServices.has(service))) {
    report.passed = false; process.exitCode = 1;
  }
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  writeFileSync(join(reports, 'audio-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  monitor?.kill(); await application?.close(); engine.close(); rmSync(directory, { recursive: true, force: true });
}
