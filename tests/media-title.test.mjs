import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { parseMediaCommand } from '../apps/desktop/core/protocol.mjs';
import { metadataFromHtml, titleChoice } from '../apps/desktop/core/media-title.mjs';
import { fetchTitleMetadata } from '../apps/desktop/runtime/media-title-metadata.mjs';
import { MediaTitleCalls } from '../apps/desktop/core/media-title-calls.mjs';
import { PcmMixer } from '../apps/desktop/runtime/voice-output.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const job = (payload = {}) => ({ id: 'media-id', payload: { url: 'https://www.youtube.com/watch?v=abcdefghijk', mode: 'full', ...payload } });

test('caption text excludes URLs and controls while keeping extension, schema and free text titles', () => {
  const c = normalizeConfig();
  const p = parseMediaCommand('この曲です\nhttps://youtu.be/abcdefghijk?t=60無限\nmode=full startSeconds=60', c);
  assert.equal(p.title, 'この曲です'); assert.equal(p.startSeconds, 60); assert.equal(p.mode, 'full');
  assert.equal(parseMediaCommand('https://youtu.be/abcdefghijk再生\n**【ねこの曲】**', c).title, 'ねこの曲');
  assert.equal(parseMediaCommand('NYANPLAY/1 '+JSON.stringify({version:1,type:'play',mediaUrl:p.url,title:'固定形式の題名',mode:'direct'}),c).title, '固定形式の題名');
  assert.equal(titleChoice({...p,title:'youtu.be'},{title:'サイトの題名'}).text,'サイトの題名');
  assert.equal(titleChoice({...p,title:'明示した本文'},{title:'サイトの題名'}).source,'message');
  assert.equal(titleChoice({url:'https://x.com/user/status/123',source:'Discord利用者'},{body:'投稿の本文',author:'投稿者'}).source,'body');
  assert.equal(titleChoice({url:p.url},{author:'投稿者'}).text,'投稿者');
  assert.equal(titleChoice({url:p.url,source:'Discord利用者'}).text,'Discord利用者');
  assert.equal(titleChoice({url:p.url}).text,'メディアを取得中です');
  assert.equal(titleChoice({url:p.url},{title:'YouTube'}).source,'pending');
});
test('title speed and overlap settings have defaults and reject out-of-range overrides', () => {
  const c=normalizeConfig();assert.equal(c.media.titleCallSpeedRatio,.85);assert.equal(c.media.titleCallDucking,.8);
  assert.equal(normalizeConfig({...c,media:{...c.media,titleCallSpeedRatio:.9}}).media.titleCallSpeedRatio,.9);
  for(const titleCallSpeedRatio of [0,1.51,'1',NaN]) assert.throws(()=>normalizeConfig({media:{titleCallSpeedRatio}}));
  assert.throws(()=>normalizeConfig({media:{titleCallDucking:1.1}}));
});
test('HTML metadata accepts attribute order, entities, visible article text and author', () => {
  const data = metadataFromHtml('<meta content="曲 &amp; 猫" property="og:title"><meta name="author" content="作者"><main><script>secret</script><nav>menu</nav><p>本文 &quot;中身&quot;</p></main>');
  assert.deepEqual(data,{title:'曲 & 猫',body:'本文 "中身"',author:'作者'});
});
test('bounded metadata requests use YouTube oEmbed and reject redirected internal addresses', async () => {
  const c=normalizeConfig(), signal=new AbortController().signal, urls=[];
  const data=await fetchTitleMetadata(job().payload.url,c.media.allowedHosts,async (url,options)=>{urls.push(url);assert.equal(options.redirect,'manual');return new Response(JSON.stringify({title:'動画タイトル',author_name:'作者'}),{headers:{'content-type':'application/json'}});},signal);
  assert.equal(data.title,'動画タイトル');assert.equal(urls.length,1);assert.match(urls[0],/\/oembed\?/);
  await assert.rejects(fetchTitleMetadata('https://x.com/user/status/1',c.media.allowedHosts,async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),signal));
});
test('metadata starts with the announcement and supplied title speech does not hold playback', async () => {
  const config=normalizeConfig(), announcement=deferred(), title=deferred(), end=deferred(), events=[];
  const calls=new MediaTitleCalls(()=>config,{metadata:async()=>{events.push('metadata');return {title:'取得したタイトル'};},speak:async p=>{events.push(p.text);return p.titleCall?title.promise:announcement.promise;}});
  const task=calls.play(job(),new AbortController().signal,async()=>{events.push('play');return end.promise;});await tick();
  assert.ok(events.includes('metadata'));assert.equal(events.includes('play'),false);announcement.resolve();await tick();
  assert.ok(events.includes('取得したタイトル'));assert.ok(events.includes('play'));
  calls.started('media-id');end.resolve();let finished=false;task.then(()=>{finished=true;});await tick();assert.equal(finished,false);
  title.resolve();await task;assert.equal(calls.active.size,0);
});
test('unknown media repeats only until actual playback starts and finishes the current unit', async () => {
  const config=normalizeConfig(), end=deferred(), units=[];
  const calls=new MediaTitleCalls(()=>config,{metadata:async()=>({}),speak:async p=>{if(!p.titleCall)return;const unit=deferred();units.push({text:p.text,...unit});return unit.promise;}});
  const task=calls.play(job(),new AbortController().signal,()=>end.promise);await tick();assert.equal(units[0].text,'メディアを取得中です');
  units[0].resolve();await delay(120);assert.equal(units.length,2);calls.started('media-id');end.resolve();
  let finished=false;task.then(()=>{finished=true;});await tick();assert.equal(finished,false);units[1].resolve();await task;assert.equal(units.length,2);
});
test('direct skips the service announcement; stop cancels title speech; speech failure cannot cancel media', async () => {
  const config=normalizeConfig(), control=new AbortController(), end=deferred(), spoken=[];
  const calls=new MediaTitleCalls(()=>config,{metadata:async()=>({}),speak:(p,{signal})=>{spoken.push(p);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const task=calls.play(job({mode:'direct',title:'直接のタイトル'}),control.signal,()=>new Promise((resolve,reject)=>control.signal.addEventListener('abort',()=>reject(control.signal.reason),{once:true})));await tick();
  assert.equal(spoken.length,1);assert.equal(spoken[0].titleCall,true);control.abort();await assert.rejects(task);assert.equal(calls.active.size,0);
  const errors=[];const failed=new MediaTitleCalls(()=>config,{metadata:async()=>({}),speak:async()=>{throw new Error('TTS failure');},log:(l,t)=>errors.push(t)});
  // Only title failure is non-fatal; the legacy service announcement remains required.
  const healthy=failed.play(job({mode:'direct',title:'タイトル'}),new AbortController().signal,()=>end.promise);await tick();end.resolve();await healthy;assert.equal(errors.length,1);
});
test('fast playback never waits for metadata or starts a late title; browser metadata can wake preparation', async () => {
  const config=normalizeConfig(), lookup=deferred(), end=deferred(), spoken=[];
  const calls=new MediaTitleCalls(()=>config,{metadata:()=>lookup.promise,speak:async p=>spoken.push(p.text)});
  const task=calls.play(job({mode:'direct'}),new AbortController().signal,()=>end.promise);await tick();assert.equal(spoken.length,0);
  calls.started('media-id');end.resolve();await task;lookup.resolve({title:'遅れて取得したタイトル'});await tick();assert.equal(spoken.length,0);
  const later=deferred(), slowEnd=deferred(); const second=new MediaTitleCalls(()=>config,{metadata:()=>later.promise,speak:async p=>spoken.push(p.text)});
  const slow=second.play(job({mode:'direct'}),new AbortController().signal,()=>slowEnd.promise);await tick();second.update('media-id',{title:'再生ページのタイトル'});await tick();assert.equal(spoken.at(-1),'再生ページのタイトル');
  second.started('media-id');slowEnd.resolve();await slow;later.resolve({title:'取得した別の値'});
});
test('Discord title overlap uses its own factor and the same restoration fade as ordinary speech', async t => {
  const m=new PcmMixer();t.after(()=>m.destroy());m.mediaVolume=1;m.ducking=.2;m.titleCallDucking=.8;m.duckFadeInMs=100;
  const pcm=Buffer.alloc(3840*25);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(10000,i);m.addMedia(pcm);
  const done=m.addSpeech(Buffer.alloc(3840),1,undefined,0,true);
  assert.equal(m.takeFrame(1000).readInt16LE(0),8000);await done;
  assert.equal(m.takeFrame(1020).readInt16LE(0),8000);
  assert.equal(m.takeFrame(1070).readInt16LE(0),9000);
  assert.equal(m.takeFrame(1120).readInt16LE(0),10000);
  const regular=m.addSpeech(Buffer.alloc(3840),1);assert.equal(m.takeFrame(1140).readInt16LE(0),2000);await regular;
});

test('a slow metadata request cannot leave the whole preparation gap silent', async () => {
  const config=normalizeConfig(), metadata=deferred(), end=deferred(), unit=deferred(), spoken=[];
  const calls=new MediaTitleCalls(()=>config,{metadata:()=>metadata.promise,speak:async p=>{spoken.push(p.text);return unit.promise;}});
  const task=calls.play(job({mode:'direct'}),new AbortController().signal,()=>end.promise);
  await delay(850);assert.deepEqual(spoken,['メディアを取得中です']);
  calls.started('media-id');end.resolve();unit.resolve();await task;metadata.resolve({title:'遅着'});await tick();assert.equal(spoken.length,1);
});
