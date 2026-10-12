import { performance } from 'node:perf_hooks';

// Counts sender timing, not audible dropouts at the Discord receiver. Keep a
// bounded, content-free record so a long real call can be correlated with audio.
export class AudioDiagnostics {
  constructor() { this.startedAt = new Date().toISOString(); this.started = performance.now(); this.packets = 0; this.gapEvents = 0; this.burstEvents = 0; this.maxGapMs = 0; this.mediaStarvations = 0; this.backgroundStarvations = 0; this.events = []; }
  event(kind, value) { this.events.push({ at: new Date().toISOString(), kind, value }); if (this.events.length > 30) this.events.shift(); }
  dispatch(now = performance.now()) {
    if (this.previous !== undefined) {
      const gap = now - this.previous; this.maxGapMs = Math.max(this.maxGapMs, gap);
      if (gap > 60) { this.gapEvents++; this.event('send-gap', Math.round(gap)); }
      else if (gap < 5) { this.burstEvents++; this.event('send-burst', Math.round(gap)); }
    }
    this.previous = now; this.packets++;
  }
  resetClock() { this.previous = undefined; }
  starvation(lane) { if (lane === 'background') this.backgroundStarvations++; else this.mediaStarvations++; this.event(`${lane}-buffer-empty`, 0); }
  snapshot(now = performance.now()) { return { startedAt: this.startedAt, durationSeconds: Math.max(0, Math.round((now - this.started) / 1000)), packets: this.packets, gapEvents: this.gapEvents, burstEvents: this.burstEvents, maxGapMs: Math.round(this.maxGapMs * 10) / 10, mediaStarvations: this.mediaStarvations, backgroundStarvations: this.backgroundStarvations, events: this.events.map(event => ({ ...event })) }; }
}
