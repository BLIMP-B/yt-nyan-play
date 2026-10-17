import { performance } from 'node:perf_hooks';

// Keep raw Opus until its send time. Encrypting several queued packets before
// dispatch would reuse the connection's current RTP sequence/timestamp.
export class VoicePacer {
  constructor(connection, { sent = () => {}, overflow = () => {}, clock = () => performance.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
    Object.assign(this, { connection, sent, overflow, clock, schedule, cancel });
    this.prepare = connection.prepareAudioPacket.bind(connection); this.dispatch = connection.dispatchAudio.bind(connection);
    this.queue = []; this.queued = 0; this.dispatched = 0; this.dropped = 0; this.maximumQueued = 0; this.last = -Infinity; this.credit = 1.5; this.creditAt = clock();
    connection.prepareAudioPacket = packet => { this.pending = Buffer.from(packet); };
    connection.dispatchAudio = () => {
      if (!this.pending || this.closed) return false;
      this.queue.push({ packet: this.pending, sequence: ++this.queued }); this.pending = null;
      if (this.queue.length > 50) { this.queue.shift(); this.dropped++; this.overflow(); }
      this.maximumQueued = Math.max(this.maximumQueued, this.queue.length); this.arm(); return true;
    };
  }
  creditWait(now) { return Math.max(0, (1 - Math.min(1.5, this.credit + (now - this.creditAt) / 18.5)) * 18.5); }
  arm() {
    if (this.timer || !this.queue.length || this.closed) return;
    // Bounded catch-up is at most 1 packet / 14 ms. Never replay missed ticks
    // as the library's 1-ms bursts. 14 ms can recover a 15.625-ms Windows
    // timer tick; an 18-ms floor drifts toward 31.25 ms and starves receivers.
    // Credits limit sustained catch-up to one frame / 18.5 ms and leave
    // headroom inside the two-packet 80-kbps link model.
    const interval = this.queue.length > 2 ? 14 : 20;
    const now = this.clock(), delay = Math.max(0, this.last + interval - now, this.creditWait(now));
    this.timer = this.schedule(() => { this.timer = null; this.tick(); }, Math.ceil(delay)); this.timer?.unref?.();
  }
  tick() {
    if (!this.queue.length || this.closed) return;
    const now = this.clock();
    if (now - this.last < 14 || this.creditWait(now) > .001) { this.arm(); return; }
    const next = this.queue.shift();
    this.prepare(next.packet);
    if (this.dispatch()) {
      this.last = this.clock();
      this.credit = Math.min(1.5, this.credit + (this.last - this.creditAt) / 18.5) - 1; this.creditAt = this.last;
      this.sent();
    }
    this.dispatched = next.sequence; this.arm();
  }
  clear() { if (this.timer) this.cancel(this.timer); this.timer = null; this.queue = []; this.pending = null; this.dispatched = this.queued; }
  close() { this.closed = true; this.clear(); this.connection.prepareAudioPacket = this.prepare; this.connection.dispatchAudio = this.dispatch; }
  async drain(signal) {
    signal?.throwIfAborted();
    const target = this.queued + (this.pending ? 1 : 0), until = this.clock() + 2000;
    while (!this.closed && this.dispatched < target) {
      signal?.throwIfAborted();
      if (this.clock() > until) throw new Error('Discordの送信バッファを排出できません');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    signal?.throwIfAborted();
  }
  snapshot() { return { queuedFrames: this.queue.length, maximumQueuedFrames: this.maximumQueued, overflowDrops: this.dropped, minimumSpacingMs: 14, catchUpFrameMs: 18.5, burstFrames: 1.5, maximumQueuedMs: 1000 }; }
}
