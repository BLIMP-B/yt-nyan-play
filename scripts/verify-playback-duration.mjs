import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { _electron } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

const root = resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'nyan-long-playback-')), reports = resolve('dist/playback-duration-verification'); mkdirSync(reports, { recursive: true });
const duration = 62, startSeconds = 7;
for (const [name, length] of [['whole', duration], ['truncated', 32]]) execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=660:duration=${length}`, '-c:a', 'libopus', join(directory, name + '.ogg')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=blue:size=160x90:rate=10:duration=${duration}`, '-f', 'lavfi', '-i', `sine=frequency=660:duration=${duration}`, '-c:v', 'libvpx', '-c:a', 'libopus', '-shortest', join(directory, 'whole.webm')]);
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-ar', '48000', '-ac', '2', join(directory, 'speech.wav')]);
const wav = readFileSync(join(directory, 'speech.wav'));
const engine = createServer((req,res) => { if (req.url.startsWith('/audio_query')) res.end('{}'); else if (req.url.startsWith('/synthesis')) res.end(wav); else res.writeHead(404).end(); });
engine.listen(0,'127.0.0.1'); await once(engine,'listening');
writeFileSync(join(directory,'config.json'), JSON.stringify(normalizeConfig({ desktop: { closeToTray: false, notifications: false }, speech: { output: 'local', engineUrl: `http://127.0.0.1:${engine.address().port}`, bouyomiPreprocess: false }, media: { output: 'local', showWindow: false, allowedHosts: ['duration-fixture.test'] } })));
writeFileSync(join(directory,'package.json'), JSON.stringify({ name: 'nyan-duration-verification', type: 'module', main: 'bootstrap.mjs', version: JSON.parse(readFileSync(join(root,'package.json'))).version }));
writeFileSync(join(directory,'bootstrap.mjs'), `
import { MediaStreamResolver } from ${JSON.stringify(pathToFileURL(join(root,'apps/desktop/runtime/media-streams.mjs')).href)};
import { MediaBrowser } from ${JSON.stringify(pathToFileURL(join(root,'apps/desktop/runtime/media-browser.mjs')).href)};
globalThis.nyanLongProbe = { browsers: new Map(), metrics: {}, window: null };
MediaStreamResolver.prototype.resolve = async function(url) { return { url: new URL(url).pathname.includes('truncated') ? ${JSON.stringify(join(directory,'truncated.ogg'))} : ${JSON.stringify(join(directory,'whole.ogg'))}, headers: {}, duration: ${duration}, audioOnly: true, service: 'fixture' }; };
const play = MediaBrowser.prototype.play;
MediaBrowser.prototype.play = function(job,...args) { globalThis.nyanLongProbe.browsers.set(job.id,this); return play.call(this,job,...args); };
await import(${JSON.stringify(pathToFileURL(join(root,'apps/desktop/main.mjs')).href)});
`);
const report = { passed: false, platform: process.platform, duration, startSeconds, fixtures: [], actualYouTube: false }; let application;
try {
  const env = { ...process.env, NYAN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [directory, ...(process.platform === 'linux' ? ['--no-sandbox','--disable-gpu'] : [])], env });
  const page = await application.firstWindow(); await page.waitForFunction(() => Boolean(window.nyan));
  const call = async (action, data) => { const r = await page.evaluate(async ({action,data}) => window.nyan.invoke(action,data),{action,data}); assert.equal(r.ok,true,r.error); return r.value; };
  await application.evaluate(async ({BrowserWindow,ipcMain,session,net}, video) => {
    const probe = globalThis.nyanLongProbe; probe.ui = BrowserWindow.getAllWindows()[0];

    probe.ui.webContents.session.setPermissionRequestHandler((web,p,callback) => callback(web === probe.ui.webContents && ['media','display-capture'].includes(p)));
    ipcMain.on('nyan:pcm',(event,id,bytes) => {
      if(event.sender !== probe.ui.webContents || !probe.metrics[id]) return;
      const m = probe.metrics[id], pcm = Buffer.from(bytes); m.frames++;
      for(let i=0;i+1<pcm.length;i+=2) if(Math.abs(pcm.readInt16LE(i))>100) { m.audibleSamples++; if(Date.now()-m.began>46000) m.samplesAfter46Seconds++; }
    });
    await session.fromPartition('persist:nyan-playback').protocol.handle('http',request => {
      if(new URL(request.url).hostname !== 'duration-fixture.test') return net.fetch(request,{bypassCustomProtocolHandlers:true});
      if(new URL(request.url).pathname === '/whole.webm') {
        const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(video.length-1,Number(range[2])) : video.length-1;
        return new Response(new Uint8Array(video.slice(start,end+1)), { status:range?206:200, headers:{'Content-Type':'video/webm','Accept-Ranges':'bytes','Content-Length':String(end-start+1),...(range?{'Content-Range':`bytes ${start}-${end}/${video.length}`}:{})} });
      }
      return new Response('<!doctype html><title>長時間再生試験</title><video controls src="/whole.webm"></video>',{headers:{'Content-Type':'text/html'}});
    });
  }, [...readFileSync(join(directory,'whole.webm'))]);
  let index = 0;
  for(const kind of ['whole','truncated']) for(const mode of ['preview','full','direct']) {
    const began = Date.now(), guildId = String(10000+index++);
    const job = await call('media:add',{url:`http://duration-fixture.test/${kind}`, mode, startSeconds, guildId});
    report.fixtures.push({id:job.id,guildId,kind,mode,began,status:'waiting',maximumTime:0,windowIds:[]});
    await application.evaluate((_electron,{id,began}) => { globalThis.nyanLongProbe.metrics[id]={began,frames:0,audibleSamples:0,samplesAfter46Seconds:0}; },{id:job.id,began});
  }
  const deadline = Date.now()+85000;
  while(Date.now()<deadline) {
    const state = await call('state');
    for(const fixture of report.fixtures) {
      const job = state.jobs.find(j=>j.id===fixture.id); fixture.status=job.status;
      const media = state.media.find(m=>m.scope===fixture.guildId); fixture.maximumTime=Math.max(fixture.maximumTime,media?.currentTime||0);
      if(media?.delivery==='browser') { fixture.browserStartTime ??= media.currentTime; fixture.browserTime=media.currentTime; }
      if(!['waiting','running'].includes(job.status)) { fixture.elapsedMs ||= Date.now()-fixture.began; assert.equal(job.status,'completed',job.error); continue; }
      const windowId = await application.evaluate(async (_electron,{id,previous}) => {
        const probe = globalThis.nyanLongProbe, target = probe.browsers.get(id)?.window;
        if(!target || target.isDestroyed() || target.id===previous || !target.webContents.getURL()) return previous;
        return target.id;
      },{id:fixture.id,previous:fixture.windowIds.at(-1)||0});
      if(windowId && windowId!==fixture.windowIds.at(-1)) fixture.windowIds.push(windowId);
    }
    if(report.fixtures.every(f=>f.status==='completed')) break;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  const state = await call('state');
  report.continuations = state.logs.filter(l=>l.text.includes('途中で終了しました')).map(l=>l.text);
  for(const fixture of report.fixtures) {
    assert.equal(fixture.status,'completed',`${fixture.kind}/${fixture.mode} never finished`);
    fixture.audio = await application.evaluate((_electron,id)=>globalThis.nyanLongProbe.metrics[id],fixture.id);
    assert.ok(fixture.audio.audibleSamples>1000);
    if(fixture.mode==='preview') assert.ok(fixture.elapsedMs<54000, 'Preview exceeded its original 45 second budget');
    else { assert.ok(fixture.elapsedMs>50000,'Full playback was capped early'); assert.ok(fixture.audio.samplesAfter46Seconds>1000,'No audible samples after the 45 second boundary'); assert.ok(fixture.maximumTime>50); }
    assert.equal(fixture.windowIds.length,fixture.kind==='truncated'?2:1,'Unexpected replay or missing continuation');
    console.log('PLAYBACK_DURATION_VERIFIED',JSON.stringify(fixture));
  }
  assert.equal(report.continuations.length,3);
  report.passed = true;
} catch(error) { report.error=error.stack; process.exitCode=1; console.error(error); }
finally {
  writeFileSync(join(reports,'duration-report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({passed:report.passed,platform:report.platform,error:report.error}));
  await application?.close(); engine.close(); rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
