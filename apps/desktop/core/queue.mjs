import { EventEmitter } from 'node:events';

export class JobRunner extends EventEmitter {
  constructor(store, kind, execute) { super(); this.store = store; this.kind = kind; this.execute = execute; this.paused = false; this.pausedGuilds = new Set(); this.active = null; }
  async drain() {
    if (this.active || this.paused) return;
    const job = this.store.jobs.find(j => j.kind === this.kind && j.status === 'waiting' && !this.pausedGuilds.has(j.payload.guildId));
    if (!job) return;
    const controller = new AbortController(); this.active = { job, controller };
    this.store.changeJob(job.id, { status: 'running', startedAt: new Date().toISOString(), error: '' });
    try {
      await this.execute(job, controller.signal);
      this.store.changeJob(job.id, { status: controller.signal.aborted ? 'cancelled' : 'completed', finishedAt: new Date().toISOString() });
    } catch (error) {
      this.store.changeJob(job.id, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? '' : String(error.message).slice(0, 500), finishedAt: new Date().toISOString() });
      if (!controller.signal.aborted) this.store.log('error', `${this.kind}: ${error.message}`);
    } finally {
      this.active = null; this.emit('idle'); queueMicrotask(() => this.drain());
    }
  }
  skip(guildId) { if (!guildId || this.active?.job.payload.guildId === guildId) this.active?.controller.abort(); }
  pauseGuild(guildId, value) { if (value) this.pausedGuilds.add(guildId); else { this.pausedGuilds.delete(guildId); void this.drain(); } this.store.emit('change'); }
  pause(value = true) { this.paused = value; if (!value) void this.drain(); this.store.emit('change'); }
  retry(id) { const job = this.store.jobs.find(j => j.id === id); if (!job || job.kind !== this.kind || !['failed', 'interrupted', 'cancelled', 'completed'].includes(job.status)) throw new Error('この項目は再試行できません'); this.store.changeJob(id, { status: 'waiting', error: '' }); void this.drain(); }
  cancel(id) { const job = this.store.jobs.find(j => j.id === id && j.kind === this.kind); if (!job || !['waiting', 'running'].includes(job.status)) throw new Error('この項目は取消できません'); if (this.active?.job.id === id) this.skip(); else this.store.changeJob(id, { status: 'cancelled', finishedAt: new Date().toISOString() }); }
  clear(guildId) { for (const job of this.store.jobs) if (job.kind === this.kind && job.status === 'waiting' && (!guildId || job.payload.guildId === guildId)) job.status = 'cancelled'; this.skip(guildId); this.store.saveState(); }
}
