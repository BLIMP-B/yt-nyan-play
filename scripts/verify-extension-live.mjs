import {chromium} from 'playwright-core';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'..'),out=join(root,'dist/extension-live'),profile=mkdtempSync(join(tmpdir(),'nyan-public-'));
mkdirSync(out,{recursive:true});
// Public samples only. No credentials, cookie imports, posting, or auth bypass.
const samples=[
  {id:'youtube',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'},
  {id:'niconico',url:'https://www.nicovideo.jp/watch/sm9'},
  {id:'x',url:'https://x.com/NASA/status/1225357420224032768'},
  {id:'instagram',url:'https://www.instagram.com/nasa/'},
  {id:'tiktok',url:'https://www.tiktok.com/@scout2015/video/6718335390845095173'},
  {id:'facebook',url:'https://www.facebook.com/NASA/videos'},
  {id:'threads',url:'https://www.threads.com/@nasa'},
  {id:'bluesky',url:'https://bsky.app/profile/bsky.app/post/3lg5g64vvos23'},
  {id:'mastodon',url:'https://mastodon.social/@Gargron'}
];
const e=join(root,'extension');let context;const report={version:JSON.parse(readFileSync(join(e,'manifest.json'))).version,mode:'actual public pages, fresh unauthenticated Chrome profile',sites:[]};
try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1280,height:900},locale:'ja-JP',args:['--no-sandbox',`--disable-extensions-except=${e}`,`--load-extension=${e}`],ignoreDefaultArgs:['--disable-extensions']});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  await worker.evaluate(()=>chrome.storage.sync.set({destinations:[{label:'表示確認用（送信はしません）',webhookUrl:'https://discord.com/api/webhooks/'+'00000000000000000000'+'/fixture_token'}]}));
  for(const sample of samples){
    const result={id:sample.id,url:sample.url,button:false,dialog:false,status:'unverified'};const page=await context.newPage();
    try{
      const response=await page.goto(sample.url,{waitUntil:'domcontentloaded',timeout:45000});result.http=response?.status();
      if (sample.id === 'tiktok') {
        const link = page.locator('a[href*="/video/"]').first();
        try { await link.waitFor({timeout:10000}); const url=await link.getAttribute('href'); if(url) await page.goto(new URL(url,page.url()).href,{waitUntil:'domcontentloaded',timeout:45000}); } catch {}
      }
      if (sample.id === 'mastodon') {
        const post = await page.evaluate(async()=>{
          try { const account=await (await fetch('/api/v1/accounts/lookup?acct=Gargron',{signal:AbortSignal.timeout(15000)})).json();
            const posts=await (await fetch('/api/v1/accounts/'+account.id+'/statuses?only_media=true&limit=40',{signal:AbortSignal.timeout(15000)})).json();
            return posts.find(p=>p.media_attachments?.some(m=>['video','gifv','audio'].includes(m.type)))?.url || null;
          } catch { return null; }
        });
        if(post)await page.goto(post,{waitUntil:'domcontentloaded',timeout:45000});
      }
      try { await page.locator('video,audio').first().waitFor({timeout:10000}); await page.locator('video,audio').first().scrollIntoViewIfNeeded({timeout:5000}); } catch {}
      const trigger=page.getByRole('button',{name:/のメディアをDiscordで再生/});
      try{await trigger.first().waitFor({state:'visible',timeout:25000});}catch{}
      result.finalUrl=page.url();result.title=await page.title();result.mediaCount=await page.locator('video,audio').count();
      result.mediaDiagnostics=await page.locator('video,audio').evaluateAll(elements=>elements.slice(0,5).map(m=>{
        const ancestors=[];for(let a=m.parentElement,n=0;a&&n<32;a=a.parentElement,n++){
          ancestors.push({tag:a.tagName,role:a.getAttribute('role'),testid:a.getAttribute('data-testid'),class:a.className,links:[...a.querySelectorAll('a[href]')].map(x=>x.href).filter(x=>/\/(status|post|videos|reel|watch)\b/.test(x)).slice(0,12)});
        }
        return{readyState:m.readyState,sourceScheme:(m.currentSrc||m.getAttribute('src')||'').split(':')[0],rect:m.getBoundingClientRect().toJSON(),ancestors};
      }));
      result.button=await trigger.count()>0&&await trigger.first().isVisible();
      await page.screenshot({path:join(out,sample.id+'-page.png')});
      if(result.button){
        await trigger.first().click({timeout:5000});await page.locator('#nyan-play-share-modal').getByRole('dialog').waitFor({timeout:5000});result.dialog=true;result.preview=await page.locator('#preview').textContent();await page.screenshot({path:join(out,sample.id+'-dialog.png')});result.status='display-verified';
      }else{
        const text=(await page.locator('body').innerText()).slice(0,3000);
        result.status=/ログインして bot|Instagramにログイン|captcha|verify you|not a robot|ログインして続きを|アクセスを確認/i.test(text)||/\/accounts\/login|\/login\b/.test(page.url())?'login-or-access-check':result.http>=400?'http-blocked':result.mediaCount?'media-found-display-unverified':'no-playable-media';
        result.reason=text.slice(0,600);
      }
    }catch(error){result.status='error';result.error=error.message.slice(0,350);try{await page.screenshot({path:join(out,sample.id+'-error.png')});}catch{}}
    finally{report.sites.push(result);console.log('PUBLIC_SITE '+JSON.stringify(result));await page.close();}
  }
}finally{writeFileSync(join(out,'public-report.json'),JSON.stringify(report,null,2));if(context)await context.close();rmSync(profile,{recursive:true,force:true});}
