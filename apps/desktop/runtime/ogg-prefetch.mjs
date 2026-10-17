import { Transform } from 'node:stream';

// Count decoded samples in our own FFmpeg Ogg output. Browser TimeRanges for a
// non-seekable stream may stay empty until EOF and cannot gate startup safely.
export class OggPrefetch extends Transform {
  constructor({ startupSeconds = 0, maxAheadSeconds = 0 } = {}) {
    super({ readableHighWaterMark: 256 * 1024, writableHighWaterMark: 64 * 1024 });
    Object.assign(this, { startupSeconds, maxAheadSeconds, position: 0, seconds: 0, prefetchedSeconds: 0, holding: true, target: startupSeconds, held: [], heldBytes: 0, carry: Buffer.alloc(0), refills: 0 });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
  }
  _transform(chunk, _encoding, callback) {
    this.pending = { bytes: this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk, offset: 0, callback }; this.carry = Buffer.alloc(0); this.pump();
  }
  pump() {
    const pending = this.pending; if (!pending || this.destroyed) return;
    try {
      while (pending.bytes.length - pending.offset >= 27) {
        const { bytes, offset } = pending;
        if (bytes.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('音声ストリームの形式を確認できません');
        const segments = bytes[offset + 26], header = 27 + segments;
        if (bytes.length - offset < header) break;
        let size = header; for (let i = 0; i < segments; i++) size += bytes[offset + 27 + i];
        if (bytes.length - offset < size) break;
        const granule = bytes.readBigInt64LE(offset + 6), seconds = granule >= 0 ? Number(granule) / 48000 : this.seconds;
        if (this.settled && this.maxAheadSeconds > 0 && seconds > this.position + this.maxAheadSeconds) return;
        const page = bytes.subarray(offset, offset + size); pending.offset += size; this.seconds = Math.max(this.seconds, seconds);
        if (this.holding) {
          this.held.push(page); this.heldBytes += page.length;
          if (this.heldBytes > 2 * 1024 * 1024) throw new Error('音声の先読みサイズを超過しました');
          if (this.seconds >= this.target) this.releaseHeld();
        } else this.push(page);
      }
      this.carry = pending.bytes.subarray(pending.offset); this.pending = null; pending.callback();
    } catch (error) { this.pending = null; pending.callback(error); }
  }
  releaseHeld() {
    for (const page of this.held) this.push(page);
    this.held = []; this.heldBytes = 0; this.holding = false;
    if (!this.settled) { this.settled = true; this.prefetchedSeconds = this.seconds; this.resolveReady(); }
  }
  setPosition(seconds) { if (!Number.isFinite(seconds)) return; this.position = Math.max(0, seconds); this.pump(); }
  refill() {
    if (this.holding || this.writableFinished || this.destroyed || !(this.startupSeconds > 0)) return false;
    this.holding = true; this.target = this.seconds + this.startupSeconds; this.refills++; return true;
  }
  _flush(callback) {
    if (this.carry.length) { callback(new Error('音声ストリームが途中で切れています')); return; }
    if (this.holding) this.releaseHeld(); callback();
  }
  _destroy(error, callback) {
    if (!this.settled) this.rejectReady(error || new DOMException('Cancelled', 'AbortError'));
    const pending = this.pending; this.pending = null; this.held = []; this.carry = Buffer.alloc(0);
    pending?.callback(error || new DOMException('Cancelled', 'AbortError')); callback(error);
  }
}
