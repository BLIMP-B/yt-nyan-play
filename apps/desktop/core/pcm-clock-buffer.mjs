const FRAME_SAMPLES = 960, BYTES_PER_SAMPLE = 4, MAX_BYTES = 192000;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

// Browser capture and Discord have independent clocks. Slowly adjust the
// sampling ratio instead of periodically dropping an entire 20-ms frame or
// draining the buffer and muting while it fills again.
export class PcmClockBuffer {
  constructor() { this.clear(); this.underruns = 0; this.discardedSamples = 0; this.correctedFrames = 0; }
  clear() { this.bytes = Buffer.alloc(0); this.primed = false; this.phase = 0; this.ratio = 1; this.level = null; this.finished = false; }
  finish() { this.finished = true; }
  push(chunk) {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > MAX_BYTES) {
      const discard = Math.ceil((this.bytes.length - MAX_BYTES) / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
      this.bytes = this.bytes.subarray(discard); this.discardedSamples += discard / BYTES_PER_SAMPLE;
    }
  }
  frame(bufferMs, underrun) {
    const target = Math.max(4 * FRAME_SAMPLES, bufferMs * 48);
    const available = Math.floor(this.bytes.length / BYTES_PER_SAMPLE);
    if (this.finished && !available) { this.bytes = Buffer.alloc(0); return null; }
    if (!this.primed) {
      if (available < target && !this.finished) return null;
      this.primed = true; this.level = target;
    }
    this.level += (available - this.level) * .02;
    const error = this.level - target;
    // A one-frame deadband ignores normal delivery jitter. Correction stays
    // below 0.5% and changes at most 0.005% in each output frame.
    const requested = 1 + (Math.abs(error) <= FRAME_SAMPLES ? 0 : clamp((error - Math.sign(error) * FRAME_SAMPLES) / 96000, -.005, .005));
    this.ratio += clamp(requested - this.ratio, -.00005, .00005);
    const end = this.phase + FRAME_SAMPLES * this.ratio, consume = Math.floor(end);
    if (available < Math.max(consume, Math.floor(this.phase + (FRAME_SAMPLES - 1) * this.ratio) + 1)) {
      if (this.finished) { const tail = Buffer.alloc(FRAME_SAMPLES * BYTES_PER_SAMPLE); this.bytes.copy(tail, 0, 0, Math.min(tail.length, available * BYTES_PER_SAMPLE)); this.bytes = Buffer.alloc(0); return tail; }
      this.primed = false; this.phase = 0; this.ratio = 1; this.level = null;
      this.underruns++; underrun?.(); return null;
    }
    if (this.ratio === 1 && this.phase === 0) {
      const output = this.bytes.subarray(0, FRAME_SAMPLES * BYTES_PER_SAMPLE);
      this.bytes = this.bytes.subarray(FRAME_SAMPLES * BYTES_PER_SAMPLE); return output;
    }
    const output = Buffer.alloc(FRAME_SAMPLES * BYTES_PER_SAMPLE);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const position = this.phase + i * this.ratio, a = Math.floor(position), b = Math.min(a + 1, available - 1), fraction = position - a;
      for (let ch = 0; ch < 2; ch++) {
        const x = this.bytes.readInt16LE(a * 4 + ch * 2), y = this.bytes.readInt16LE(b * 4 + ch * 2);
        output.writeInt16LE(Math.round(x + (y - x) * fraction), i * 4 + ch * 2);
      }
    }
    this.phase = end - consume; this.bytes = this.bytes.subarray(consume * BYTES_PER_SAMPLE);
    if (Math.abs(this.ratio - 1) > .000001) this.correctedFrames++;
    return output;
  }
  snapshot() { return { bufferedMs: Math.round(this.bytes.length / 192), ratio: Math.round(this.ratio * 1000000) / 1000000, underruns: this.underruns, discardedSamples: this.discardedSamples, correctedFrames: this.correctedFrames }; }
}
