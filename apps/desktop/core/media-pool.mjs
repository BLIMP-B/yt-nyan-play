import { JobRunner } from './queue.mjs';
export function mediaScope(payload) { return payload.master ? 'master' : payload.guildId || 'local'; }
export class MediaPool {
  constructor(store, browserFactory, beforePlay) { this.store = store; this.browserFactory = browserFactory; this.beforePlay = beforePlay; this.lanes = new Map(); this.masterActive = false; this.paused = false; this.pausedScopes = new Set(); this.duckDepth = new Map(); this.overlayGains = new Map(); }
  masterPending() { return this.masterActive || this.store.jobs.some(j => j.kind === 'media' && j.status === 'waiting' && mediaScope(j.payload) === 'master'); }
  lane(scope) {
    if (this.lanes.has(scope)) return this.lanes.get(scope);
    const browser = this.browserFactory(scope);
    browser.setOverlayGain?.(this.overlayValue(scope), 0);
    const runner = new JobRunner(this.store, 'media', async (job, signal) => {
      const master = scope === 'master'; if (master) { this.masterActive = true; for (const [key, lane] of this.lanes) if (key !== 'master') lane.browser.setPaused(true); }
      try { if (this.beforePlay) await this.beforePlay(job, signal); signal.throwIfAborted(); await browser.play(job, signal); }
      finally { if (master) this.masterActive = false; for (const [key, lane] of this.lanes) { lane.browser.setPaused(this.paused || this.pausedScopes.has(key) || key !== 'master' && this.masterPending()); queueMicrotask(() => lane.runner.drain()); } }
    }, job => mediaScope(job.payload) === scope && (scope === 'master' || !this.masterPending()));
    runner.paused = this.paused || this.pausedScopes.has(scope); const lane = { browser, runner }; this.lanes.set(scope, lane); return lane;
  }
  enqueue(payload, { interrupt = false } = {}) {
    const job = this.store.enqueue('media', payload), scope = mediaScope(payload), lane = this.lane(scope);
    if (interrupt) {
      for (const old of this.store.jobs) if (old !== job && old.kind === 'media' && old.status === 'waiting' && mediaScope(old.payload) === scope) old.status = 'cancelled';
      lane.runner.skip();
      if (this.paused) { this.paused = false; for (const key of this.lanes.keys()) if (key !== scope) this.pausedScopes.add(key); }
      this.pausedScopes.delete(scope); lane.runner.paused = false;
      lane.browser.setPaused(scope !== 'master' && this.masterPending()); this.store.saveState();
    }
    void lane.runner.drain(); return job;
  }
  drain() { if (this.store.jobs.some(j => j.kind === 'media' && j.status === 'waiting' && j.payload.master)) void this.lane('master').runner.drain(); for (const j of this.store.jobs) if (j.kind === 'media' && j.status === 'waiting') void this.lane(mediaScope(j.payload)).runner.drain(); }
  forJob(job) { return this.lane(mediaScope(job.payload)).runner; }
  pause(value, scope) { if (scope) { if (value) this.pausedScopes.add(scope); else this.pausedScopes.delete(scope); } else this.paused = value; for (const [key, lane] of this.lanes) if (!scope || scope === key) { lane.runner.pause(this.paused || this.pausedScopes.has(key)); lane.browser.setPaused(this.paused || this.pausedScopes.has(key) || key !== 'master' && this.masterPending()); } this.store.emit('change'); }
  skip(scope) { if (scope) this.lanes.get(scope)?.runner.skip(); else if (this.masterActive) this.lanes.get('master')?.runner.skip(); else for (const lane of this.lanes.values()) lane.runner.skip(); }
  clear(scope) { const scopes = scope ? [scope] : [...new Set(this.store.jobs.filter(j => j.kind === 'media').map(j => mediaScope(j.payload)))]; for (const key of scopes) { const lane = this.lane(key); for (const job of this.store.jobs) if (job.kind === 'media' && job.status === 'waiting' && mediaScope(job.payload) === key) job.status = 'cancelled'; lane.runner.skip(); } this.store.saveState(); for (const [key, lane] of this.lanes) lane.browser.setPaused(this.paused || this.pausedScopes.has(key) || key !== 'master' && this.masterPending()); this.drain(); }
  setDucked(value, guildId) { for (const [key, lane] of this.lanes) if (!guildId || key === 'master' || key === guildId || key === 'local') { const depth = Math.max(0, (this.duckDepth.get(key) || 0) + (value ? 1 : -1)); this.duckDepth.set(key, depth); lane.browser.setDucked(depth > 0); } }
  overlayValue(scope) { return Math.min(1, this.overlayGains.get('*') ?? 1, this.overlayGains.get(scope) ?? 1, ...(['master', 'local'].includes(scope) ? this.overlayGains.values() : [])); }
  fadeOverlay(value, ms, scope = '*') { if (value === 1) this.overlayGains.delete(scope); else this.overlayGains.set(scope, value); for (const [key, lane] of this.lanes) lane.browser.setOverlayGain?.(this.overlayValue(key), ms); }
  show() { for (const lane of this.lanes.values()) lane.browser.show(); }
  get status() { return [...this.lanes].filter(([, l]) => l.runner.active).map(([scope, lane]) => ({ scope, ...lane.browser.status })); }
  close() { for (const lane of this.lanes.values()) { lane.runner.pause(true); lane.runner.skip(); lane.browser.close(); } }
}
