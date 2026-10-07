import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { PermissionFlagsBits } from 'discord.js';
import { SmallWordModel } from '../core/hourly-language.mjs';

const PAGE_SIZE = 50, SYNC_BUDGET_MS = 15000;
function cancellable(task, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
export class HourlyHistory {
  constructor(directory, getClient, getConfig, changed = () => {}) {
    this.getClient = getClient; this.getConfig = getConfig; this.changed = changed; this.syncing = null; this.progress = ''; this.errors = [];
    this.file = join(directory, 'hourly-history.sqlite'); this.requests = new Map(); this.sequence = 0; this.messages = 0; this.rotation = 0; this.used = 0;
    void this.request('status').catch(error => { if (!this.closed) { this.errors = [error.message]; this.changed(); } });
  }
  request(type, data = {}, signal) {
    signal?.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('履歴処理は終了しました'));
    if (this.requests.size >= 128) return Promise.reject(new Error('履歴処理が混み合っています。次の差分取得で再試行してください'));
    if (!this.worker) {
      const worker = this.worker = new Worker(new URL('./hourly-history-worker.mjs', import.meta.url), { workerData: { file: this.file }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
      worker.on('message', reply => {
        if (this.worker !== worker) return;
        this.messages = reply.messages;
        const pending = this.requests.get(reply.id); if (pending) { this.requests.delete(reply.id); pending.cleanup(); reply.error ? pending.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name })) : pending.resolve(reply.value); }
        if (!this.requests.size) worker.unref(); this.changed();
      });
      const failed = error => { if (this.worker === worker) this.worker = null; for (const p of this.requests.values()) { p.cleanup(); p.reject(error); } this.requests.clear(); };
      worker.on('error', failed); worker.on('exit', code => { if (this.worker === worker) failed(new Error(`履歴ワーカーが終了しました（${code}）`)); });
    }
    const worker = this.worker, id = ++this.sequence; worker.ref();
    return new Promise((resolve, reject) => {
      const abort = () => { this.requests.delete(id); worker.postMessage({ cancel: id }); signal.removeEventListener('abort', abort); reject(signal.reason); };
      this.requests.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) }); signal?.addEventListener('abort', abort, { once: true });
      try { worker.postMessage({ id, type, data }); }
      catch (error) { this.requests.delete(id); signal?.removeEventListener('abort', abort); reject(error); }
    });
  }
  selected(message) { return this.getConfig().hourly.servers.some(s => s.enabled && s.guildId === message.guildId && s.channelIds.includes(message.channelId)); }
  row(message) { return { id: message.id, guildId: message.guildId, channelId: message.channelId, created: message.createdTimestamp ?? Number((BigInt(message.id) >> 22n) + 1420070400000n), content: String(message.content || '').slice(0, 2000) }; }
  async record(message) { if (this.selected(message)) await this.request('record', { rows: [this.row(message)] }); }
  async deleted(ids) { await this.request('delete', { ids: Array.isArray(ids) ? ids : [ids] }); }
  tokens(text, signal) { return this.request('tokens', { text }, signal); }
  async sync(signal) {
    if (this.syncing) return this.syncing;
    const task = this.performSync(signal); this.syncing = task;
    try { return await task; } finally { this.syncing = null; this.changed(); }
  }
  async performSync(signal) {
    const client = this.getClient(); if (!client?.isReady()) throw new Error('履歴を取得するにはDiscord Botへ接続してください');
    const config = this.getConfig().hourly, budget = AbortSignal.timeout(SYNC_BUDGET_MS), combined = signal ? AbortSignal.any([signal, budget]) : budget;
    const tasks = [...new Map(config.servers.filter(s => s.enabled).flatMap(s => s.channelIds.map(id => [id, { id, guildId: s.guildId, phase: 'head' }]))).values()];
    let fetched = 0, index = this.rotation % (tasks.length || 1), limited = false; this.errors = [];
    try {
      while (tasks.some(t => !t.done)) {
        combined.throwIfAborted(); if (this.getClient() !== client) throw new Error('Discord接続が終了しました');
        if (fetched >= config.historySyncMessages) { limited = true; break; }
        const task = tasks[index]; index = (index + 1) % tasks.length; this.rotation = index; if (task.done) continue;
        try {
          if (!task.channel) {
            task.channel = await cancellable(client.channels.fetch(task.id), combined);
            if (task.channel?.guildId !== task.guildId || !task.channel.messages || !task.channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) throw new Error('閲覧・メッセージ履歴の権限がありません');
            task.cursor = await this.request('cursor', { channel: task.id }, combined);
            if (task.cursor.scan?.backfill) task.phase = 'backfill';
          }
          const cursor = task.cursor, limit = Math.min(PAGE_SIZE, config.historySyncMessages - fetched);
          if (task.phase === 'backfill' && cursor.complete) { task.done = true; continue; }
          const before = task.phase === 'head' ? cursor.scan?.before || '' : cursor.oldest;
          const batch = await cancellable(task.channel.messages.fetch({ limit, ...(before ? { before } : {}), cache: false }), combined);
          combined.throwIfAborted(); const items = [...batch.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1); fetched += items.length;
          if (items.length && items.at(-1).id === before) throw new Error('履歴取得のページが進みません');
          let accepted = items;
          if (task.phase === 'head') {
            const stop = cursor.scan?.stop || cursor.newest, newest = cursor.scan?.newest || items[0]?.id || cursor.newest;
            accepted = stop ? items.filter(m => BigInt(m.id) > BigInt(stop)) : items;
            const reached = !stop || accepted.length < items.length || items.length < limit;
            if (!cursor.newest && items.length) cursor.oldest = items.at(-1).id;
            cursor.scan = reached ? null : { before: items.at(-1).id, stop, newest };
            if (reached) { cursor.newest = newest; task.phase = 'backfill'; if (items.length < limit && !stop) cursor.complete = 1; cursor.scan = cursor.complete ? null : { backfill: true }; }
          } else { cursor.scan = null; if (items.length) cursor.oldest = items.at(-1).id; if (items.length < limit) cursor.complete = 1; }
          // Refresh the fetched head too: older caches contain only words.
          // The same 50-message page budget hydrates phrases/sentences on sync.
          const result = await this.request('page', { rows: items.filter(m => this.selected(m)).map(m => this.row(m)), cursor, channel: task.id }, combined);
          this.progress = `${task.channel.name}: ${result.channelMessages}件 · 今回${fetched}/${config.historySyncMessages}件`; this.changed();
          await wait(config.historyPageDelayMs, undefined, { signal: combined });
        } catch (error) { combined.throwIfAborted(); this.errors.push(`${task.id}: ${error.message}`); task.done = true; }
      }
    } catch (error) { signal?.throwIfAborted(); if (!budget.aborted) throw error; limited = true; }
    this.progress = limited ? `今回${fetched}件を取得して待機中。残りは次の取得で続けます（自動取得は5分ごと）` : `今回${fetched}件を取得しました`; this.changed();
  }
  async model(server, cutoff, signal) {
    if (!server.channelIds.length) throw new Error('文章生成に使うチャンネルを選択してください');
    const client = this.getClient(); if (!client?.isReady()) throw new Error('Discord Botへ接続してください');
    for (const id of server.channelIds) {
      signal?.throwIfAborted(); const channel = await cancellable(client.channels.fetch(id), signal);
      if (channel?.guildId !== server.guildId || !channel.permissionsFor(client.user)?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) throw new Error('資料チャンネルの現在の履歴閲覧権限を確認してください');
    }
    const result = await this.request('model', { guild: server.guildId, channels: server.channelIds, cutoff, limit: this.getConfig().hourly.historyCorpusMessages }, signal);
    this.used = result.used; const model = new SmallWordModel(); model.weights = new Map(result.weights); model.materials = new Map(result.materials); model.wordSources = new Map(result.wordSources); return model;
  }
  snapshot() { return { syncing: Boolean(this.syncing), progress: this.progress, errors: this.errors, messages: this.messages, pending: this.requests.size, used: this.used }; }
  async clear() { if (this.syncing) throw new Error('履歴取得を中止してから削除してください'); await this.request('clear'); this.used = 0; this.progress = '取得履歴を削除しました'; this.changed(); }
  async close() { this.closed = true; for (const p of this.requests.values()) { p.cleanup(); p.reject(new DOMException('Closed', 'AbortError')); } this.requests.clear(); const worker = this.worker; this.worker = null; await worker?.terminate(); }
}
