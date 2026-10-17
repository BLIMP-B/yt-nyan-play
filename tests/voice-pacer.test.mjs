import test from 'node:test'; import assert from 'node:assert/strict';
import { VoicePacer } from '../apps/desktop/runtime/voice-pacer.mjs';
function fixture() {
  let now=0, id=0, prepared, sequence=65533, timestamp=4294964416; const timers=new Map(), packets=[];
  const connection={prepareAudioPacket(packet){prepared={value:packet[0],sequence,timestamp};},dispatchAudio(){packets.push({...prepared,at:now});sequence=(sequence+1)%65536;timestamp=(timestamp+960)>>>0;return true;}};
  const pacer=new VoicePacer(connection,{clock:()=>now,schedule:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},cancel:id=>timers.delete(id)});
  const advance=target=>{while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>target)break;timers.delete(next[0]);now=next[1].at;next[1].fn();}now=target;};
  const enqueue=value=>{connection.prepareAudioPacket(Buffer.from([value]));connection.dispatchAudio();};
  return {pacer,packets,advance,enqueue,timers};
}
test('late library catch-up never emits clustered or duplicated RTP packets and preserves content order',()=>{
  const f=fixture(); f.enqueue(0); f.advance(0);
  f.advance(100); for(let i=1;i<=6;i++)f.enqueue(i); f.advance(500);
  assert.deepEqual(f.packets.map(p=>p.value),[0,1,2,3,4,5,6]);
  for(let i=1;i<f.packets.length;i++){assert.ok(f.packets[i].at-f.packets[i-1].at>=18);assert.equal(f.packets[i].sequence,(f.packets[i-1].sequence+1)%65536);assert.equal(f.packets[i].timestamp,(f.packets[i-1].timestamp+960)>>>0);}
  assert.equal(f.pacer.snapshot().overflowDrops,0); f.pacer.close();
});
test('interrupt and reconnect clear old encoded content and close cancels delayed sends',()=>{
  const f=fixture(); f.enqueue(1);f.enqueue(2);f.pacer.clear();f.advance(100);assert.equal(f.packets.length,0);
  f.enqueue(3);f.advance(100);assert.equal(f.packets[0].value,3);
  f.enqueue(4);f.pacer.close();f.advance(1000);assert.equal(f.packets.length,1);assert.equal(f.timers.size,0);
});
test('severe overload remains bounded and normal timer jitter cannot cause unbounded latency',()=>{
  const f=fixture();for(let i=0;i<100;i++)f.enqueue(i);assert.equal(f.pacer.queue.length,50);assert.equal(f.pacer.snapshot().overflowDrops,50);f.pacer.clear();
  for(let i=0;i<3000;i++){f.advance(i*20);f.enqueue(i%256);f.advance(i*20+1);}
  f.advance(61000);assert.ok(f.pacer.maximumQueued<=50);assert.equal(f.pacer.queue.length,0);f.pacer.close();
});
test('cancelling drain stops waiting for queued packets promptly',async()=>{
  const f=fixture(),controller=new AbortController();f.enqueue(1);const draining=f.pacer.drain(controller.signal);controller.abort();
  await assert.rejects(draining,{name:'AbortError'});f.pacer.close();
});
