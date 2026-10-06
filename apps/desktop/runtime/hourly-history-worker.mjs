import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { lexicalTokens, tokenizer, SmallWordModel } from '../core/hourly-language.mjs';

const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, guild TEXT, channel TEXT, created INTEGER, tokens TEXT); CREATE INDEX IF NOT EXISTS corpus ON messages(guild,channel,created); CREATE TABLE IF NOT EXISTS cursors(channel TEXT PRIMARY KEY, oldest TEXT, newest TEXT, complete INTEGER DEFAULT 0);');
if (!db.prepare('PRAGMA table_info(cursors)').all().some(c => c.name === 'scan')) db.exec("ALTER TABLE cursors ADD COLUMN scan TEXT DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS recent_corpus ON messages(guild,created DESC,id DESC);');
const put = db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?)'), exists = db.prepare('SELECT 1 FROM messages WHERE id=?'), remove = db.prepare('DELETE FROM messages WHERE id=?');
const putCursor = db.prepare('INSERT OR REPLACE INTO cursors(channel,oldest,newest,complete,scan) VALUES(?,?,?,?,?)');
let messages = db.prepare('SELECT count(*) AS n FROM messages').get().n, chain = Promise.resolve();
const cancelled = new Set(), known = new Set();
const check = id => { if (cancelled.has(id)) throw new DOMException('Cancelled', 'AbortError'); };
async function tokens(text, id) {
  const analyzer = await tokenizer(); check(id); const result = [], clean = String(text).slice(0, 2000);
  // Bound kuromoji's lattice for long messages as well as total retained vocabulary.
  for (let offset = 0; offset < clean.length && result.length < 256; offset += 256) { check(id); result.push(...lexicalTokens(clean.slice(offset, offset + 256), analyzer)); await yieldTurn(); }
  return result.slice(0, 256);
}
async function record(rows, cursor, channel, id) {
  const prepared = [];
  for (const row of rows) { check(id); prepared.push({ ...row, tokens: JSON.stringify(await tokens(row.content, id)) }); }
  check(id); let added = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of prepared) { if (!exists.get(row.id)) added++; put.run(row.id, row.guildId, row.channelId, row.created, row.tokens); }
    if (cursor) putCursor.run(channel, cursor.oldest, cursor.newest, cursor.complete, cursor.scan ? JSON.stringify(cursor.scan) : '');
    db.exec('COMMIT'); messages += added;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return channel ? { channelMessages: db.prepare('SELECT count(*) AS n FROM messages WHERE channel=?').get(channel).n } : null;
}
async function handle(type, data, id) {
  check(id);
  if (type === 'status') return null;
  if (type === 'tokens') return tokens(data.text, id);
  if (type === 'cursor') { const row = db.prepare('SELECT * FROM cursors WHERE channel=?').get(data.channel); return row ? { ...row, scan: row.scan ? JSON.parse(row.scan) : null } : { oldest: '', newest: '', complete: 0, scan: null }; }
  if (type === 'record' || type === 'page') return record(data.rows, data.cursor, data.channel, id);
  if (type === 'delete') { for (const key of data.ids) messages -= remove.run(key).changes; return null; }
  if (type === 'clear') { db.exec('DELETE FROM messages; DELETE FROM cursors; VACUUM;'); messages = 0; return null; }
  if (type === 'model') {
    const slots = data.channels.map(() => '?').join(',');
    const rows = db.prepare(`SELECT tokens FROM messages WHERE guild=? AND channel IN (${slots}) AND created<=? ORDER BY created DESC,id DESC LIMIT ?`).all(data.guild, ...data.channels, data.cutoff, data.limit);
    if (!rows.length) throw new Error('資料の履歴がまだありません。履歴を取得してから文章生成を試してください');
    const model = new SmallWordModel();
    for (let n = 0; n < rows.length; n++) {
      check(id);
      for (const token of JSON.parse(rows[n].tokens)) if (model.weights.size < 10000 || model.weights.has(`${token.pos}:${token.word}`)) model.train([token]);
      if (n % 25 === 0) await yieldTurn();
    }
    return { weights: [...model.weights], used: rows.length };
  }
  throw new Error('Unknown history operation');
}
parentPort.on('message', message => {
  if (message.cancel) { if (known.has(message.cancel)) cancelled.add(message.cancel); return; }
  const { id, type, data } = message;
  known.add(id);
  chain = chain.then(async () => {
    try { const value = await handle(type, data, id); parentPort.postMessage({ id, value, messages }); }
    catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message }, messages }); }
    finally { cancelled.delete(id); known.delete(id); }
  });
});
