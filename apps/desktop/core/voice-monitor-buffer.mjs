const RATE = 48000, CAPACITY = RATE;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

// Browser-safe PCM jitter buffer. All positions are stereo sample frames.
export class VoiceMonitorBuffer {
  constructor(bufferMs = 360) {
    this.target = clamp(Number(bufferMs) || 360, 80, 600) * 48;
    this.data = new Float32Array(CAPACITY * 2); this.read = 0; this.available = 0; this.phase = 0; this.ratio = 1;
    this.primed = false; this.lastAt = 0; this.ended = false; this.level = this.target;
    this.underruns = 0; this.discarded = 0; this.corrected = 0; this.fade = 0; this.last = [0, 0]; this.release = 0; this.idle = false; this.starts = [];
  }
  push(bytes, at) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 32768 || bytes.length % 4) return;
    const count = bytes.length / 4, overflow = Math.max(0, this.available + count - CAPACITY);
    if (overflow) { this.read = (this.read + overflow) % CAPACITY; this.available -= overflow; this.discarded += overflow; this.phase = 0; this.fade = 240; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) {
      const index = (this.read + this.available + i) % CAPACITY;
      this.data[index * 2] = view.getInt16(i * 4, true) / 32768;
      this.data[index * 2 + 1] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    this.available += count; this.lastAt = at; this.ended = false; this.idle = false;
  }
  mix(output, at) {
    const count = output[0].length;
    // Only receiver-idle or end can release a short utterance. A device may
    // render ahead of wall time, so its clock cannot establish receiver idle.
    if (!this.primed && this.available && (this.available >= this.target || this.ended || this.idle)) {
      this.starts.push({ atMs: Math.round(at / 48), bufferedMs: this.available / 48, reason: this.available >= this.target ? 'buffer' : this.ended ? 'end' : 'idle' }); if (this.starts.length > 4) this.starts.shift();
      this.primed = true; this.level = this.available; this.phase = 0; this.ratio = 1; this.fade = 240; this.release = 0;
    }
    this.level += (this.available - this.level) * Math.min(1, count / RATE);
    const error = this.level - this.target;
    const requested = 1 + (Math.abs(error) < 960 ? 0 : clamp((error - Math.sign(error) * 960) / 96000, -.005, .005));
    this.ratio += clamp(requested - this.ratio, -count / RATE * .0025, count / RATE * .0025);
    if (Math.abs(this.ratio - 1) > .000001) this.corrected++;
    for (let i = 0; i < count; i++) {
      if (this.primed && !this.available) {
        if (!this.ended) this.underruns++;
        this.primed = false; this.release = 240;
      }
      if (!this.primed) {
        if (this.release) { const gain = --this.release / 240; for (let ch = 0; ch < output.length; ch++) output[ch][i] += this.last[ch] * gain; }
        continue;
      }
      const next = this.available > 1 ? (this.read + 1) % CAPACITY : this.read;
      const gain = this.fade ? 1 - --this.fade / 240 : 1;
      for (let ch = 0; ch < output.length; ch++) {
        const a = this.data[this.read * 2 + ch], b = this.data[next * 2 + ch];
        const value = (a + (b - a) * this.phase) * gain; output[ch][i] += value; this.last[ch] = value;
      }
      const step = this.phase + (this.ended ? 1 : this.ratio), consume = Math.min(this.available, Math.floor(step));
      this.phase = step - Math.floor(step); this.read = (this.read + consume) % CAPACITY; this.available -= consume;
    }
  }
  get drained() { return this.ended && !this.available && !this.release; }
  snapshot() { return { bufferedMs: Math.round(this.available / 48), targetMs: this.target / 48, ratio: Math.round(this.ratio * 1000000) / 1000000, underruns: this.underruns, discardedSamples: this.discarded, correctedBlocks: this.corrected, starts: this.starts }; }
}
