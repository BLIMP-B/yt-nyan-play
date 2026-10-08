import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeConfig } from './config.mjs';

export function writeAtomic(path, data) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export class Store extends EventEmitter {
  constructor(directory) {
    super(); this.directory = directory; mkdirSync(directory, { recursive: true });
    this.config = normalizeConfig(this.read('config.json', {}));
    const saved = this.read('state.json', { jobs: [], seen: [] });
    this.jobs = Array.isArray(saved.jobs) ? saved.jobs.slice(-2000) : [];
    this.seen = Array.isArray(saved.seen) ? saved.seen.slice(-10000) : [];
    this.logs = [];
    for (const job of this.jobs) if (job.status === 'running') { job.status = 'interrupted'; job.error = 'アプリ終了中に中断しました。履歴から再試行できます。'; }
    this.saveState();
  }
  read(name, fallback) {
    const path = join(this.directory, name);
    if (!existsSync(path)) return fallback;
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { copyFileSync(path, `${path}.invalid-${Date.now()}`); throw new Error(`${name}を読み込めません。元ファイルは保全しました。`); }
  }
  updateConfig(patch) { this.config = normalizeConfig(patch); writeAtomic(join(this.directory, 'config.json'), this.config); this.emit('change'); return this.config; }
  saveState() { writeAtomic(join(this.directory, 'state.json'), { jobs: this.jobs, seen: this.seen }); this.emit('change'); }
  remember(id) {
    if (!id) return false;
    if (this.seen.includes(id)) return true;
    this.seen.push(id); this.seen = this.seen.slice(-10000); this.saveState(); return false;
  }
  log(level, text) {
    const clean = String(text).replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/g, '[Webhook]')
      .replace(/(?:Bot\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '[Token]').slice(0, 1000);
    this.logs.unshift({ time: new Date().toISOString(), level, text: clean }); this.logs = this.logs.slice(0, 500);
    this.emit('change');
  }
  enqueue(kind, payload) {
    const pending = this.jobs.filter(j => ['waiting', 'running'].includes(j.status)).length;
    if (pending >= (kind === 'speech' && payload.priority === 100 ? 1100 : 1000)) throw new Error('待機キューが上限です。不要な項目を削除してください');
    const job = { id: crypto.randomUUID(), kind, payload, status: 'waiting', createdAt: new Date().toISOString() };
    this.jobs.push(job); this.jobs = this.jobs.filter(j => ['waiting', 'running', 'interrupted'].includes(j.status)).concat(this.jobs.filter(j => !['waiting', 'running', 'interrupted'].includes(j.status)).slice(-1000));
    this.saveState(); return job;
  }
  changeJob(id, patch) { const job = this.jobs.find(j => j.id === id); if (!job) throw new Error('項目が見つかりません'); Object.assign(job, patch); this.saveState(); return job; }
  exportConfig() { return structuredClone(this.config); }
}
