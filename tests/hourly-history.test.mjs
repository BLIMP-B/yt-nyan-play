import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HourlyHistory } from '../apps/desktop/runtime/hourly-history.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { generateSlm } from '../apps/desktop/core/hourly-language.mjs';

function fixture(t, { limit = 100, length = 350 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nyan-history-limits-'));
  const config = normalizeConfig({ hourly: { historySyncMessages: limit, historyPageDelayMs: 200, historyCorpusMessages: 100, servers: [{ guildId: '11111', channelIds: ['22222'], enabled: true, bgm: false }] } });
  const messages = Array.from({ length }, (_, i) => ({ id: String(10000 + i), guildId: '11111', channelId: '22222', createdTimestamp: i + 1, content: i < 100 ? '猫 時計' : '月 料理' }));
  const calls = [], histories = []; let hook;
  const channel = { guildId: '11111', name: '資料', permissionsFor: () => ({ has: () => true }), messages: { fetch: async options => {
    calls.push(options); hook?.(); return new Map(messages.filter(m => !options.before || BigInt(m.id) < BigInt(options.before)).reverse().slice(0, options.limit).map(m => [m.id, m]));
  } } };
  const client = { isReady: () => true, user: {}, channels: { fetch: async () => channel } };
  const open = () => { const h = new HourlyHistory(directory, () => client, () => config); histories.push(h); return h; };
  t.after(async () => { await Promise.all(histories.map(h => h.close())); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { directory, config, messages, calls, open, hook: value => { hook = value; } };
}
test('a limited first import can generate immediately, uses only recent samples, and resumes across restart', async t => {
  const f = fixture(t), h = f.open(); await h.sync();
  assert.equal(h.snapshot().messages, 100); assert.equal(f.calls.reduce((n,c)=>n+c.limit,0), 100); assert.match(h.snapshot().progress, /残り/);
  const model = await h.model(f.config.hourly.servers[0], 1000); assert.deepEqual(model.vocabulary('名詞').map(n=>n.word).sort(), ['料理','月']);
  await h.close(); const restored = f.open(); await restored.sync(); assert.equal(restored.snapshot().messages, 150);
  await restored.model(f.config.hourly.servers[0], 1000); assert.equal(restored.snapshot().used, 100);
});
test('the minimum 50-message budget still advances older history rather than repeatedly fetching the same head', async t => {
  const f = fixture(t, { limit: 50 }), h = f.open(); await h.sync(); assert.equal(h.snapshot().messages, 50);
  await h.close(); const restored = f.open(); await restored.sync(); assert.equal(restored.snapshot().messages, 100); assert.equal(f.calls[1].before, '10300');
});
test('incremental gaps larger than the budget persist their stop and scan position without skipping messages', async t => {
  const f = fixture(t, { length: 90 }), h = f.open(); await h.sync(); assert.equal(h.snapshot().messages, 90);
  for (let i=90;i<320;i++) f.messages.push({ ...f.messages[0], id:String(10000+i),createdTimestamp:i+1 });
  await h.sync(); assert.equal(h.snapshot().messages, 190); await h.close();
  for (let i=320;i<330;i++) f.messages.push({ ...f.messages[0], id:String(10000+i),createdTimestamp:i+1 });
  const restored = f.open(); await restored.sync(); await restored.sync(); await restored.sync(); assert.equal(restored.snapshot().messages, 330);
  const cursor = await restored.request('cursor',{channel:'22222'}); assert.equal(cursor.newest,'10329'); assert.equal(cursor.scan,null);
});
test('cancellation keeps only committed pages and resumes safely; edited messages and bulk deletions remain supported', async t => {
  const f = fixture(t), h = f.open(), controller = new AbortController(); f.hook(() => { if(f.calls.length===2) controller.abort(); });
  await assert.rejects(h.sync(controller.signal),{name:'AbortError'}); assert.equal(h.snapshot().messages,50);
  f.hook(null); await h.sync(); assert.equal(h.snapshot().messages,150);
  await h.record({...f.messages.at(-1),content:'森 太陽'}); await h.deleted([f.messages.at(-2).id,f.messages.at(-3).id]); assert.equal(h.snapshot().messages,148);
  const tokens = await h.tokens('森は太陽を眺める。'); assert.ok(tokens.some(t=>t.word==='森'));
});
test('old SQLite history and cursors migrate without losing cached words; long posts have bounded analysis', async t => {
  const f = fixture(t), db = new DatabaseSync(join(f.directory,'hourly-history.sqlite'));
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,guild TEXT,channel TEXT,created INTEGER,tokens TEXT); CREATE TABLE cursors(channel TEXT PRIMARY KEY,oldest TEXT,newest TEXT,complete INTEGER DEFAULT 0);');
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('10000','11111','22222',1,JSON.stringify([{word:'猫',pos:'名詞'},{word:'時計',pos:'名詞'}]));
  db.prepare('INSERT INTO cursors VALUES(?,?,?,?)').run('22222','10000','10000',1); db.close();
  const h=f.open(), model=await h.model(f.config.hourly.servers[0],1); assert.equal(model.vocabulary('名詞').length,2); assert.equal(h.snapshot().messages,1);
  await h.record({...f.messages.at(-1),content:'猫 時計 '.repeat(2000)+'後端'});
  const read = new DatabaseSync(join(f.directory,'hourly-history.sqlite')); const row=read.prepare('SELECT tokens FROM messages WHERE id=?').get(f.messages.at(-1).id); read.close();
  const tokens=JSON.parse(row.tokens); assert.ok(tokens.length<=256); assert.ok(!tokens.some(t=>t.word==='後端'));
  await h.clear(); assert.equal(h.snapshot().messages,0);
});
test('old configurations gain safe limits and invalid history settings are rejected', () => {
  const c=normalizeConfig({hourly:{enabled:true}}); assert.equal(c.hourly.historySyncMessages,500); assert.equal(c.hourly.historyPageDelayMs,500); assert.equal(c.hourly.historyCorpusMessages,2000);
  for(const [key,value] of [['historySyncMessages',49],['historyPageDelayMs',0],['historyCorpusMessages',10001]]) assert.throws(()=>normalizeConfig({hourly:{[key]:value}}),/設定/);
});
test('SLM sentence validation uses the asynchronous history worker with cancellation propagated', async t => {
  const f=fixture(t,{length:50}),h=f.open(),controller=new AbortController(); await h.sync();
  const model=await h.model(f.config.hourly.servers[0],1000); let analyzed=false;
  const result=await generateSlm(model,{...f.config.hourly,sentenceStyle:'brief'},controller.signal,async()=>new Response(JSON.stringify({response:JSON.stringify({subject:'猫',object:'時計',verb:'眺める',adjective:''})})),(text,signal)=>{assert.equal(signal,controller.signal);analyzed=true;return h.tokens(text,signal);});
  assert.equal(analyzed,true); assert.deepEqual(result.nouns.sort(),['時計','猫']);
});
