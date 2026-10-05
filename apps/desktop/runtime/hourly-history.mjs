import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { lexicalTokens, tokenizer, trainRows } from '../core/hourly-language.mjs';
export class HourlyHistory {
  constructor(directory, getClient, getConfig, changed = () => {}) {
    this.getClient = getClient; this.getConfig = getConfig; this.changed = changed; this.syncing = null; this.progress = ''; this.errors = [];
    this.db = new DatabaseSync(join(directory, 'hourly-history.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, guild TEXT, channel TEXT, created INTEGER, tokens TEXT); CREATE INDEX IF NOT EXISTS corpus ON messages(guild,channel,created); CREATE TABLE IF NOT EXISTS cursors(channel TEXT PRIMARY KEY, oldest TEXT, newest TEXT, complete INTEGER DEFAULT 0);');
    this.put = this.db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?)'); this.remove = this.db.prepare('DELETE FROM messages WHERE id=?');
  }
  selected(message) { return this.getConfig().hourly.servers.some(s => s.enabled && s.guildId === message.guildId && s.channelIds.includes(message.channelId)); }
  async record(message, analyzer) {
    if (!this.selected(message)) return;
    analyzer ||= await tokenizer();
    this.put.run(message.id, message.guildId, message.channelId, message.createdTimestamp ?? Number((BigInt(message.id) >> 22n) + 1420070400000n), JSON.stringify(lexicalTokens(message.content || '', analyzer)));
  }
  deleted(id) { this.remove.run(id); }
  async sync(signal) {
    if (this.syncing) return this.syncing;
    const task = this.performSync(signal); this.syncing = task;
    try { return await task; } finally { this.syncing = null; this.changed(); }
  }
  async performSync(signal) {
    const client = this.getClient(); if (!client?.isReady()) throw new Error('履歴を取得するにはDiscord Botへ接続してください');
    const analyzer = await tokenizer(); this.errors = [];
    for (const server of this.getConfig().hourly.servers.filter(s => s.enabled)) for (const id of server.channelIds) {
      signal?.throwIfAborted();
      try {
        const channel = await client.channels.fetch(id); signal?.throwIfAborted();
        if (channel?.guildId !== server.guildId || !channel.messages || !channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) throw new Error('閲覧・メッセージ履歴の権限がありません');
        let cursor = this.db.prepare('SELECT * FROM cursors WHERE channel=?').get(id) || { oldest: '', newest: '', complete: 0 };
        // Page backwards from the current head. Stop at the persisted head on later syncs;
        // interrupted initial backfills continue from their oldest saved page.
        let before = '', reached = false;
        const fetchPages = async stopId => {
          while (!reached) {
            signal?.throwIfAborted(); if (this.getClient() !== client) throw new Error('Discord接続が終了しました');
            const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
            signal?.throwIfAborted(); const items = [...batch.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
            for (const message of items) { if (stopId && BigInt(message.id) <= BigInt(stopId)) { reached = true; break; } await this.record(message, analyzer); }
            if (items.length) { cursor.newest = !cursor.newest || BigInt(items[0].id) > BigInt(cursor.newest) ? items[0].id : cursor.newest; cursor.oldest = !cursor.oldest || BigInt(items.at(-1).id) < BigInt(cursor.oldest) ? items.at(-1).id : cursor.oldest; }
            this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)').run(id, cursor.oldest, cursor.newest, cursor.complete);
            this.progress = `${channel.name}: ${this.db.prepare('SELECT count(*) AS n FROM messages WHERE channel=?').get(id).n}件`; this.changed();
            if (items.length < 100) { reached = true; if (!stopId) cursor.complete = 1; }
            const next = items.at(-1)?.id; if (next === before) throw new Error('履歴取得のページが進みません'); before = next;
          }
        };
        await fetchPages(cursor.newest);
        if (!cursor.complete) { before = cursor.oldest; reached = false; await fetchPages(''); }
        this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)').run(id, cursor.oldest, cursor.newest, cursor.complete);
      } catch (error) { signal?.throwIfAborted(); this.errors.push(`${id}: ${error.message}`); }
    }
    this.progress = '履歴の取得が完了しました'; this.changed();
  }
  async model(server, cutoff, signal) {
    const slots = server.channelIds.map(() => '?').join(',');
    if (!slots) throw new Error('文章生成に使うチャンネルを選択してください');
    const client = this.getClient(); if (!client?.isReady()) throw new Error('Discord Botへ接続してください');
    for (const id of server.channelIds) {
      signal?.throwIfAborted(); const channel = await client.channels.fetch(id);
      if (channel?.guildId !== server.guildId || !channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) throw new Error('資料チャンネルの現在の履歴閲覧権限を確認してください');
    }
    const incomplete = server.channelIds.some(id => !this.db.prepare('SELECT complete FROM cursors WHERE channel=?').get(id)?.complete);
    if (incomplete) throw new Error('初回の全履歴取得が完了していません');
    return trainRows(this.db.prepare(`SELECT tokens FROM messages WHERE guild=? AND channel IN (${slots}) AND created<=? ORDER BY created,id`).iterate(server.guildId, ...server.channelIds, cutoff), signal);
  }
  snapshot() { return { syncing: Boolean(this.syncing), progress: this.progress, errors: this.errors, messages: this.db.prepare('SELECT count(*) AS n FROM messages').get().n }; }
  clear() { if (this.syncing) throw new Error('履歴取得を中止してから削除してください'); this.db.exec('DELETE FROM messages; DELETE FROM cursors; VACUUM;'); this.changed(); }
  close() { this.db.close(); }
}
