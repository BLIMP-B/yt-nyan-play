import { JobRunner } from './queue.mjs';

export const speechScope = payload => payload.master ? 'master' : payload.guildId || 'local';
export class SpeechPool {
  constructor(store, execute) { this.store = store; this.execute = execute; this.lanes = new Map(); this.paused = false; this.pausedScopes = new Set(); this.halted = false; this.discordStopped = false; this.reservations = new Map(); }
  output(payload) { return payload.system && payload.output || this.store.config?.speech?.output || 'discord'; }
  lane(scope) {
    if (!this.lanes.has(scope)) {
      const runner = new JobRunner(this.store, 'speech', this.execute, j => speechScope(j.payload) === scope && (!this.discordStopped || this.output(j.payload) !== 'discord') && ![...this.reservations.values()].some(scopes => !scopes || scopes.has(scope)));
      runner.paused = this.paused || this.pausedScopes.has(scope); runner.halted = this.halted; this.lanes.set(scope, runner);
    }
    return this.lanes.get(scope);
  }
  enqueue(payload, { interrupt = false, signal } = {}) {
    signal?.throwIfAborted();
    const job = this.store.enqueue('speech', payload), runner = this.lane(speechScope(payload));
    if (interrupt) runner.skip();
    void runner.drain(); return job;
  }
  async speak(payload, { interrupt = false, signal } = {}) {
    if (this.halted || this.discordStopped && this.output(payload) === 'discord') throw new DOMException('Cancelled', 'AbortError');
    signal?.throwIfAborted();
    const job = this.store.enqueue('speech', payload), runner = this.lane(speechScope(payload));
    await new Promise((resolve, reject) => {
      const check = () => {
        if (['waiting', 'running'].includes(job.status)) return;
        cleanup();
        if (job.status === 'completed') resolve();
        else reject(job.status === 'cancelled' ? new DOMException('Cancelled', 'AbortError') : new Error(job.error || '読み上げを完了できませんでした'));
      };
      const abort = () => { if (['waiting', 'running'].includes(job.status)) runner.cancel(job.id); };
      const cleanup = () => { this.store.removeListener('change', check); signal?.removeEventListener('abort', abort); };
      this.store.on('change', check); signal?.addEventListener('abort', abort, { once: true });
      if (interrupt) runner.skip();
      void runner.drain();
    });
  }
  drain() { for (const job of this.store.jobs) if (job.kind === 'speech' && job.status === 'waiting') void this.lane(speechScope(job.payload)).drain(); }
  pauseGuild(scope, value) { if (value) this.pausedScopes.add(scope); else this.pausedScopes.delete(scope); this.lane(scope).pause(this.paused || value); }
  pause(value) { this.paused = value; for (const [scope, lane] of this.lanes) lane.pause(value || this.pausedScopes.has(scope)); }
  stopDiscord(value) {
    this.discordStopped = value;
    if (value) {
      for (const lane of this.lanes.values()) if (lane.active && this.output(lane.active.job.payload) === 'discord') lane.skip();
      for (const job of this.store.jobs) if (job.kind === 'speech' && job.status === 'waiting' && job.payload.priority > 0 && this.output(job.payload) === 'discord') this.cancel(job.id);
    }
    this.drain();
  }
  halt(value) {
    this.halted = value;
    for (const runner of this.lanes.values()) { runner.halted = value; if (value) runner.skip(); else void runner.drain(); }
    if (value) { for (const job of this.store.jobs) if (job.kind === 'speech' && job.status === 'waiting' && job.payload.priority > 0) job.status = 'cancelled'; this.store.saveState(); }
  }
  skip(scope) { if (scope) this.lanes.get(scope)?.skip(); else for (const lane of this.lanes.values()) lane.skip(); }
  reserve(scopes = null) {
    const token = Symbol('hourly'); const selected = scopes ? new Set(scopes) : null; this.reservations.set(token, selected);
    for (const [scope, lane] of this.lanes) if (!selected || selected.has(scope)) lane.skip();
    let released = false; return () => { if (released) return; released = true; this.reservations.delete(token); this.drain(); };
  }
  clear(scope) { for (const job of this.store.jobs) if (job.kind === 'speech' && job.status === 'waiting' && (!scope || speechScope(job.payload) === scope)) job.status = 'cancelled'; this.skip(scope); this.store.saveState(); }
  forJob(job) { return this.lane(speechScope(job.payload)); }
  retry(id) { const job = this.store.jobs.find(j => j.id === id && j.kind === 'speech'); if (!job) throw new Error('項目が見つかりません'); return this.forJob(job).retry(id); }
  cancel(id) { const job = this.store.jobs.find(j => j.id === id && j.kind === 'speech'); if (!job) throw new Error('項目が見つかりません'); return this.forJob(job).cancel(id); }
  get activeJobs() { return [...this.lanes.values()].flatMap(l => l.active ? [l.active.job] : []); }
}
