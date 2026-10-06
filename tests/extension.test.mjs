import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function adapters() {
  const context=vm.createContext({URL,location:{href:'https://x.com/home'},document:{querySelector:()=>null}});
  return vm.runInContext(readFileSync(new URL('../extension/media-adapters.js',import.meta.url),'utf8')+';NyanMedia',context);
}
test('Extension adapters retain SNS permalinks and use service-specific seek links',()=>{
  const a=adapters();
  for(const [url,id] of [['https://www.youtube.com/watch?v=abC123&t=99','youtube'],['https://www.nicovideo.jp/watch/sm9?from=99','niconico'],['https://x.com/person/status/123','x'],['https://www.instagram.com/reel/aBc/','instagram'],['https://www.tiktok.com/@person/video/123','tiktok'],['https://www.facebook.com/person/videos/123/','facebook'],['https://www.threads.com/@person/post/aBc','threads'],['https://bsky.app/profile/person.test/post/abC','bluesky'],['https://mastodon.social/@person/123','mastodon']]){
    const service=a.serviceFor(url);assert.equal(service.id,id);
    const clean=a.canonicalPost(url,service);assert.ok(clean);const c={url:clean,service:id,title:'見たい動画',media:{currentTime:12.9}};
    assert.doesNotMatch(a.sendUrl(c,{time:'start'}),/[?&](t|from)=/);
    assert.match(a.sendUrl(c,{time:'current'}),id==='niconico'?/from=12/:/t=12/);
    if(id!=='youtube')assert.doesNotMatch(a.content(c,{mode:'infinite'}),/youtu\.be/);
    assert.match(a.content(c,{mode:'direct'}),/直接\n/);
  }
  assert.equal(a.canonicalPost('https://evil.test/person/status/123',a.serviceFor('https://x.com/')) ,null);
  assert.equal(a.canonicalPost('https://x.com/person',a.serviceFor('https://x.com/')),null);
  assert.equal(a.mediaSource({currentSrc:'javascript:alert(1)',getAttribute:()=>null,querySelectorAll:()=>[],readyState:0}),null);
});
function worker(fetch) {
  let listener;
  const noop=()=>{};
  const context=vm.createContext({URL,AbortSignal,fetch,importScripts:noop,chrome:{runtime:{onInstalled:{addListener:noop},onStartup:{addListener:noop},onMessage:{addListener:l=>listener=l},openOptionsPage:noop},permissions:{onAdded:{addListener:noop},onRemoved:{addListener:noop}},action:{onClicked:{addListener:noop}}}});
  vm.runInContext(readFileSync(new URL('../extension/service-worker.js',import.meta.url),'utf8'),context);
  return msg=>new Promise(resolve=>listener(msg,{},resolve));
}
const hook=i=>'https://discord.com/api/webhooks/'+String(i).padStart(20,'0')+'/fixture_token_'+i;
test('Webhook results reflect every destination and never accept arbitrary URLs',async()=>{
  const calls=[],w=worker(async(url,opts)=>{calls.push({url,opts});return {ok:url===hook(0),status:500};});
  let r=await w({type:'SEND_TO_DISCORD_WEBHOOKS',webhookUrls:[hook(0),hook(1),hook(0)],content:'テスト'});
  assert.equal(r.ok,false);assert.deepEqual(Array.from(r.results,x=>x.ok),[true,false]);assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[0].opts.body).allowed_mentions,{parse:[]});
  r=await w({type:'SEND_TO_DISCORD_WEBHOOKS',webhookUrls:['https://example.test/'],content:'テスト'});assert.equal(r.ok,false);assert.equal(calls.length,2);
  r=await w({type:'SEND_TO_DISCORD_WEBHOOKS',webhookUrls:[hook(0)],content:'a'.repeat(2001)});assert.equal(r.ok,false);assert.equal(calls.length,2);
});
