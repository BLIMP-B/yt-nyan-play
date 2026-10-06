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
import OpusScript from 'opusscript';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { mediaScope } from '../apps/desktop/core/media-pool.mjs';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'damare-audio-'));
const reports = resolve(process.env.NYAN_AUDIO_REPORT_DIR || join(root, 'dist/audio-verification')); mkdirSync(reports, { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.7', '-ar', '48000', '-ac', '2', join(directory, 'speech.wav')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:v', 'libvpx', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-shortest', join(directory, 'video.webm')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', join(directory, 'audio.ogg')]);
const wav = readFileSync(join(directory, 'speech.wav'));
const engine = createServer((req, res) => { if (req.url.startsWith('/audio_query')) res.end('{}'); else if (req.url.startsWith('/synthesis')) { res.setHeader('Content-Type', 'audio/wav'); res.end(wav); } else { res.statusCode = 404; res.end(); } });
engine.listen(0, '127.0.0.1'); await once(engine, 'listening');
const config = normalizeConfig({ desktop: { closeToTray: false, notifications: false }, speech: { output: 'local', engineUrl: `http://127.0.0.1:${engine.address().port}`, bouyomiPreprocess: false }, media: { output: 'local', allowedHosts: [...normalizeConfig().media.allowedHosts, 'media-fixture.test'] } });
writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'nyan-audio-verification', type: 'module', main: 'audio-bootstrap.mjs', version: JSON.parse(readFileSync(join(root, 'package.json'))).version }));
writeFileSync(join(directory, 'audio-bootstrap.mjs'), `
import { MediaStreamResolver } from ${JSON.stringify(pathToFileURL(join(root, 'apps/desktop/runtime/media-streams.mjs')).href)};
const original = MediaStreamResolver.prototype.resolve;
MediaStreamResolver.prototype.resolve = function(url, signal) {
  if (url.startsWith('http://media-fixture.test/stream')) return Promise.resolve({ url: ${JSON.stringify(join(directory, 'audio.ogg'))}, audioOnly: true, service: 'fixture', headers: {} });
  return original.call(this, url, signal);
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
const report = { platform: process.platform, version: JSON.parse(readFileSync(join(root, 'package.json'))).version, fixtureEngine: true, discordLogin: false, speech: [], media: [] };
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
  await page.screenshot({ path: join(reports, 'media-settings.png'), fullPage: true });
  await page.locator('[data-view="hourly"]').click();
  await page.screenshot({ path: join(reports, 'hourly-settings.png'), fullPage: true });
  await page.locator('[data-view="settings"]').click();
  for (const key of fadeFields) await page.locator(`[data-config="${key}"]`).evaluate(element => { element.value = '1.2'; });
  await page.locator('[data-panel="settings"] .save-config').click();
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.config.media.duckFadeOutMs === 1200);
  const saved = (await call(page, 'state')).config;
  for (const key of fadeFields) { const [section, name] = key.split('.'); assert.equal(saved[section][name], 1200); }
  for (const key of fadeFields) await page.locator(`[data-config="${key}"]`).evaluate(element => { element.value = '3'; });
  await page.locator('[data-panel="settings"] .save-config').click();
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.config.media.duckFadeOutMs === 3000);
  report.fadeSettings = { defaultsSeconds: 3, savedSeconds: 1.2, savedMilliseconds: 1200, passed: true };
  await page.locator('[data-view="overview"]').click();
  // Observe actual production renderer PCM, not a mock getDisplayMedia or Audio element.
  await application.evaluate(async ({ BrowserWindow, ipcMain, session, net }, { wav, video, audio }) => {
    const ui = BrowserWindow.getAllWindows()[0];
    const probe = globalThis.nyanAudioProbe = { ui, target: ui, active: 'speech', metrics: {}, chunks: {} };
    ui.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      if (request.frame !== ui.webContents.mainFrame || probe.target.isDestroyed()) return callback({});
      callback({ video: probe.target.webContents.mainFrame, audio: probe.target.webContents.mainFrame, enableLocalEcho: true });
    });
    ipcMain.on('nyan:pcm', (event, id, bytes) => {
      if (event.sender !== ui.webContents || id !== 'audio-probe') return;
      const label = probe.active, buffer = Buffer.from(bytes);
      const metrics = probe.metrics[label] ||= { frames: 0, nonSilentSamples: 0, peak: 0 };
      metrics.frames++;
      if (label === 'hourly' && !metrics.thirdToneAt) {
        let crossings = 0, previous = 0, peak = 0;
        for (let i = 0; i + 3 < buffer.length; i += 4) { const sample = buffer.readInt16LE(i); peak = Math.max(peak, Math.abs(sample)); if (i && (sample >= 0) !== (previous >= 0)) crossings++; previous = sample; }
        const frequency = crossings * 48000 / (2 * (buffer.length / 4));
        if (peak > 500 && frequency >= 800 && frequency <= 950) metrics.thirdToneAt = Date.now();
      }
      for (let i = 0; i + 1 < buffer.length; i += 2) { const v = Math.abs(buffer.readInt16LE(i)); metrics.peak = Math.max(metrics.peak, v); if (v > 100) metrics.nonSilentSamples++; }
      if (label !== 'speech' && (probe.chunks[label]?.length || 0) < 4000) (probe.chunks[label] ||= []).push(buffer);
    });
    const mediaSession = session.fromPartition('persist:nyan-playback');
    await mediaSession.protocol.handle('http', request => {
      if (new URL(request.url).hostname !== 'media-fixture.test') return net.fetch(request, { bypassCustomProtocolHandlers: true });
      const file = new URL(request.url).pathname;
      if (file === '/video.webm') return new Response(new Uint8Array(video), { headers: { 'Content-Type': 'video/webm' } });
      if (file === '/audio.ogg') return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/ogg' } });
      const tag = file.includes('audio') ? 'audio' : 'video', source = tag === 'audio' ? '/audio.ogg' : '/video.webm';
      const replace = file.includes('replace') ? `<script>document.querySelector('${tag}').addEventListener('ended', () => { const next = document.createElement('video'); next.controls = true; next.autoplay = true; next.src = '/video.webm'; document.querySelector('${tag}').replaceWith(next); });</script>` : '';
      return new Response(`<!doctype html><title>メディア音声試験</title><${tag} muted controls src="${source}"></${tag}>${replace}`, { headers: { 'Content-Type': 'text/html' } });
    });
    ui.webContents.session.setPermissionRequestHandler((web, permission, callback) => callback(web === ui.webContents && ['media', 'display-capture'].includes(permission)));
  }, { wav: [...wav], video: [...readFileSync(join(directory, 'video.webm'))], audio: [...readFileSync(join(directory, 'audio.ogg'))] });
  await page.evaluate(() => window.nyanCapture({ type: 'capture:start', id: 'audio-probe' }));
  await page.evaluate(() => { window.__nyanDisplayed = []; new MutationObserver(() => window.__nyanDisplayed.push(document.querySelector('#now-playing').textContent)).observe(document.querySelector('#now-playing'), { childList: true, subtree: true }); });
  const jobs = [];
  for (let n = 1; n <= 3; n++) jobs.push(await call(page, 'speech:test', { text: `連続読み上げ${n}`, styleId: 3 }));
  for (const job of jobs) { await waitForJob(page, job.id); report.speech.push({ text: job.payload.text, status: 'completed' }); }
  await page.waitForFunction(() => document.querySelector('#now-playing').textContent.includes('再生中の項目はありません'));
  const displayed = await page.evaluate(() => window.__nyanDisplayed);
  for (const job of jobs) assert.ok(displayed.some(text => text.includes(job.payload.text)), `Now-playing did not show ${job.payload.text}`);
  report.nowPlayingUpdated = true;
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
        if (target) { probe.target = target; probe.active = kind; await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true); return; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Playback window did not open');
    }, kind);
    await waitForJob(page, job.id);
    const metrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics[globalThis.nyanAudioProbe.active]);
    assert.ok(metrics?.nonSilentSamples > 1000, `${kind} audio missing: ${JSON.stringify(metrics)}`);
    report.media.push({ kind, status: 'completed', ...metrics });
    await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  }
  const interrupted = await call(page, 'media:add', { url: 'http://media-fixture.test/video', mode: 'direct' });
  await page.waitForFunction(async () => (await window.nyan.invoke('state')).value.media.some(m => m.startedAt));
  const replacement = await call(page, 'media:add', { url: 'http://media-fixture.test/audio', mode: 'full' });
  const replacedState = await waitForJob(page, replacement.id);
  assert.equal(replacedState.jobs.find(j => j.id === interrupted.id).status, 'cancelled');
  report.latestRequest = { previousStatus: 'cancelled', latestStatus: 'completed', passed: true };
  // Confirm captured media passes through the same mixer and Opus resource used for Discord.
  const pcm = Buffer.from(await application.evaluate(() => [...Buffer.concat(globalThis.nyanAudioProbe.chunks.video)]));
  const mixer = new PcmMixer(); mixer.mediaVolume = 1;
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
  // Exercise the actual timed AudioContext playback and capture its long 880-Hz third beep.
  const hourlyConfig = (await call(page, 'state')).config; hourlyConfig.hourly.output = 'local'; hourlyConfig.hourly.enabled = false;
  await call(page, 'config:save', hourlyConfig);
  await application.evaluate(async () => {
    const probe = globalThis.nyanAudioProbe; probe.target = probe.ui; probe.active = 'hourly';
    await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true);
  });
  const clockTask = call(page, 'hourly:test', {}); clockTask.catch(() => {}); let targetAt;
  const clockUntil = Date.now() + 20000;
  while (Date.now() < clockUntil) {
    const active = (await call(page, 'state')).hourly.active; if (active) { targetAt = active.thirdAt; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await clockTask;
  const clockMetrics = await application.evaluate(() => globalThis.nyanAudioProbe.metrics.hourly);
  assert.ok(targetAt && clockMetrics?.thirdToneAt && clockMetrics.nonSilentSamples > 4800, 'The real timed chime did not produce the third tone');
  report.hourly = { ...clockMetrics, targetAt, measuredCaptureDelayMs: clockMetrics.thirdToneAt - targetAt };
  assert.ok(Math.abs(report.hourly.measuredCaptureDelayMs) < 750, 'The third tone was not aligned with the scheduled PC hour');
  const clockPcm = Buffer.from(await application.evaluate(() => [...Buffer.concat(globalThis.nyanAudioProbe.chunks.hourly.slice(-250))]));
  report.hourly.discordEncoder = await encodedAudio(clockPcm); assert.ok(report.hourly.discordEncoder.nonSilentSamples > 4800);
  await page.evaluate(() => window.nyanCapture({ type: 'capture:stop', id: 'audio-probe' }));
  if (monitor) {
    monitor.kill(); await once(monitor, 'close'); monitor = null;
    const output = Buffer.concat(monitorChunks); let outputPeak = 0;
    for (let i = 0; i + 1 < output.length; i += 2) outputPeak = Math.max(outputPeak, Math.abs(output.readInt16LE(i)));
    report.pcOutput = { bytes: output.length, peak: outputPeak, virtualOutputDevice: true };
    assert.ok(outputPeak > 100, 'PC output device received no audible samples');
  }
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
          if (target) { probe.target = target; await probe.ui.webContents.executeJavaScript(`window.nyanCapture({type:'capture:start',id:'audio-probe'})`, true); return; }
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
