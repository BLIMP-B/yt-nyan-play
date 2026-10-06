import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
import {sites,html} from '../tests/fixtures/extension/sites.mjs';
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'..');
const output=resolve(process.env.NYAN_EXTENSION_REPORT_DIR||join(root,'dist/extension-verification'));mkdirSync(output,{recursive:true});
const profile=mkdtempSync(join(tmpdir(),'nyan-extension-')),media=join(profile,'fixture.mp4');
execFileSync(require('ffmpeg-static'),['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','45','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-y',media]);
const video=readFileSync(media),report={version:'0.2.1',mode:'real Chrome extension with controlled site-DOM fixtures',platform:process.platform,sites:[],checks:[],passed:false};
let context;const received=[];
const webhook=i=>'https://discord.com/api/webhooks/'+String(i).padStart(20,'0')+'/fixture_token_'+i;
try {
  const extension=join(root,'extension');
  context=await chromium.launchPersistentContext(profile,{executablePath:process.env.NYAN_CHROME_PATH||undefined,channel:'chromium',headless:true,viewport:{width:1100,height:780},locale:'ja-JP',args:['--no-sandbox','--disable-dev-shm-usage',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],ignoreDefaultArgs:['--disable-extensions']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  await worker.evaluate(async destinations=>{await chrome.storage.sync.set({destinations,history:[]});},[{label:'表示テスト用サーバー',webhookUrl:webhook(0)},{label:'再送テスト用サーバー',webhookUrl:webhook(1)}]);
  let currentSite=sites[0],settings={},rejectSecond=false;
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.hostname==='discord.com') {received.push({url:route.request().url(),body:route.request().postDataJSON()});await route.fulfill({status:rejectSecond&&u.pathname.includes('00000000000000000001')?500:204,body:''});return;}
    if(u.pathname==='/nyan-fixture.mp4'){await route.fulfill({status:200,headers:{'Content-Type':'video/mp4','Accept-Ranges':'bytes'},body:video});return;}
    if(route.request().resourceType()==='document'){await route.fulfill({status:200,contentType:'text/html',body:html(currentSite,settings)});return;}
    await route.abort();
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);
  const trigger=()=>page.getByRole('button',{name:/のメディアをDiscordで再生/});
  const open=async(index=0)=>{await trigger().nth(index).click();await page.getByRole('dialog').waitFor();};
  for(const site of sites){
    currentSite=site;settings={theme:['youtube','x','tiktok','mastodon'].includes(site.id)?'dark':'light'};
    await page.goto(site.url);await trigger().first().waitFor();assert.equal(await trigger().count(),1,site.id+' duplicate buttons');
    await page.screenshot({path:join(output,site.id+'-button.png')});
    await open();assert.match(await page.locator('#preview').textContent(),new RegExp((site.post||site.url).split('?')[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    assert.equal(received.length,0,'Detection must not send any message');
    await page.locator('#fixture-media').evaluate(v=>{v.currentTime=12;});await page.getByRole('button',{name:'現在位置',exact:true}).click();assert.match(await page.locator('#preview').textContent(),site.id==='niconico'?/from=12/:/t=12/);
    await page.getByRole('button',{name:'最初から',exact:true}).click();assert.doesNotMatch(await page.locator('#preview').textContent(),/[?&](?:t|from)=/);
    await page.getByRole('checkbox').first().check();await page.screenshot({path:join(output,site.id+'-dialog.png')});
    assert.equal(await page.getByRole('button',{name:'送信',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'閉じる',exact:true}).click();
    report.sites.push({id:site.id,name:site.name,fixture:true,theme:settings.theme,button:true,dialog:true,postUrl:true,currentPosition:true,resetPosition:true});
  }
  report.checks.push('All nine site adapters: button, dialog, correct post URL, selected timestamp, clean start, no automatic send');
  currentSite=sites.find(x=>x.id==='x');settings={multiple:true};await page.goto(currentSite.url);await assertCount(trigger,2);await open(1);assert.equal(await page.locator('#media-candidate option').count(),2);await page.getByRole('button',{name:'無限',exact:true}).click();assert.match(await page.locator('#preview').textContent(),/x\.com.*無限/);assert.doesNotMatch(await page.locator('#preview').textContent(),/youtu\.be/);
  await page.getByRole('button',{name:'直接',exact:true}).click();assert.match(await page.locator('#preview').textContent(),/直接/);await page.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.locator('#second-media').evaluate(v=>v.remove());await assertCount(trigger,1);report.checks.push('Multiple media selection, SNS URL retained for full playback, direct mode, removed media cleanup');
  // Post DOM reused during SPA navigation must update the permalink without a reload.
  await page.locator('article a').evaluate(a=>a.href='https://x.com/nyan_fixture/status/1000000000000000002');await page.waitForTimeout(300);await open();assert.match(await page.locator('#preview').textContent(),/1000000000000000002/);await page.getByRole('button',{name:'閉じる',exact:true}).click();report.checks.push('Reused SPA post permalink updates');
  // Partial failures must stay open and retry only the failed destination.
  await open();await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check();rejectSecond=true;
  await page.getByRole('button',{name:'送信',exact:true}).click();await page.getByRole('button',{name:'失敗した宛先に再送',exact:true}).waitFor();assert.equal(received.length,2);rejectSecond=false;
  await page.getByRole('button',{name:'失敗した宛先に再送',exact:true}).click();await page.getByRole('button',{name:'送信完了',exact:true}).waitFor();assert.equal(received.length,3);assert.equal(received.filter(r=>r.url===webhook(0)).length,1);assert.deepEqual(received[0].body.allowed_mentions,{parse:[]});
  const history=await worker.evaluate(async()=>await chrome.storage.sync.get('history'));assert.equal(history.history.length,2);assert.ok(history.history.every(h=>h.webhookUrls.every(x=>!x.includes('fixture_token'))));report.checks.push('Real MV3 service worker, intercepted webhook POST, per-destination errors, retry only failures, masked successful history');
  await page.getByRole('button',{name:'閉じる',exact:true}).click();
  settings={noMedia:true};await page.goto(currentSite.url);await page.waitForTimeout(600);assert.equal(await trigger().count(),0);report.checks.push('No buttons on image/text-only posts');
  await page.locator('article').evaluate(a=>a.insertAdjacentHTML('beforeend','<video id="late-video" controls style="width:100%;height:250px"></video>'));await page.waitForTimeout(300);assert.equal(await trigger().count(),0);await page.locator('#late-video').evaluate(v=>v.src='/nyan-fixture.mp4');await trigger().first().waitFor();report.checks.push('Lazy source assignment is detected; empty video elements are ignored');
  settings={};currentSite=sites.find(x=>x.id==='instagram');await page.setViewportSize({width:390,height:844});settings={mobile:true};await page.goto(currentSite.url);await open();const bounds=await page.getByRole('dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390);await page.getByRole('checkbox').first().check();await page.screenshot({path:join(output,'instagram-mobile.png')});report.checks.push('390px mobile layout remains within viewport');
  report.passed=true;console.log('EXTENSION_VERIFIED '+JSON.stringify(report));
} finally {writeFileSync(join(output,'fixture-report.json'),JSON.stringify(report,null,2));if(context)await context.close();rmSync(profile,{recursive:true,force:true});}
async function assertCount(get,count){for(let n=0;n<40;n++){if(await get().count()===count)return;await new Promise(r=>setTimeout(r,100));}assert.equal(await get().count(),count);}
