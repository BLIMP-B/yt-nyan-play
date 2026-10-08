import { EQ_FREQUENCIES } from '../core/media-effects-settings.mjs';

const RATE = 48000;
const dbGain = db => 10 ** (db / 20);
class PeakFilter {
  constructor(frequency, gain) {
    const a = 10 ** (gain / 40), w = 2 * Math.PI * frequency / RATE, alpha = Math.sin(w) / (2 * 0.7), c = Math.cos(w), a0 = 1 + alpha / a;
    this.b0 = (1 + alpha * a) / a0; this.b1 = -2 * c / a0; this.b2 = (1 - alpha * a) / a0;
    this.a1 = -2 * c / a0; this.a2 = (1 - alpha / a) / a0; this.reset();
  }
  reset() { this.z1 = [0, 0]; this.z2 = [0, 0]; }
  sample(x, channel) {
    const y = this.b0 * x + this.z1[channel];
    this.z1[channel] = this.b1 * x - this.a1 * y + this.z2[channel]; this.z2[channel] = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Stateful stereo processing at the consumer's 20-ms clock. Each source and each
// guild has its own filter/envelope state. Speech and time tones bypass this path.
export class MediaEffects {
  configure(equalizer, compressor) {
    const key = JSON.stringify([equalizer, compressor]);
    if (this.key === key) return;
    this.key = key; this.active = equalizer.enabled || compressor.enabled;
    this.preamp = equalizer.enabled ? dbGain(equalizer.preampDb) : 1;
    this.filters = equalizer.enabled ? EQ_FREQUENCIES.flatMap((f, i) => equalizer.gains[i] ? [new PeakFilter(f, equalizer.gains[i])] : []) : [];
    this.compressor = compressor.enabled ? { ...compressor } : null;
    this.attack = Math.exp(-1 / (RATE * compressor.attackMs / 1000)); this.release = Math.exp(-1 / (RATE * compressor.releaseMs / 1000));
    this.makeup = compressor.enabled ? dbGain(compressor.makeupDb) : 1; this.reset();
  }
  reset() { this.envelope = 0; for (const filter of this.filters || []) filter.reset(); }
  process(pcm) {
    if (!this.active) return null; // Preserve the original PCM exactly when bypassed.
    const out = new Float32Array(pcm.length / 2);
    for (let i = 0; i < out.length; i += 2) {
      let left = pcm.readInt16LE(i * 2) / 32768 * this.preamp, right = pcm.readInt16LE(i * 2 + 2) / 32768 * this.preamp;
      for (const filter of this.filters) { left = filter.sample(left, 0); right = filter.sample(right, 1); }
      let gain = this.makeup;
      if (this.compressor) {
        const peak = Math.max(Math.abs(left), Math.abs(right)), smoothing = peak > this.envelope ? this.attack : this.release;
        this.envelope = smoothing * this.envelope + (1 - smoothing) * peak;
        const { thresholdDb, kneeDb, ratio } = this.compressor, over = 20 * Math.log10(Math.max(1e-12, this.envelope)) - thresholdDb;
        const reduction = kneeDb > 0 && Math.abs(over) < kneeDb / 2 ? (1 - 1 / ratio) * (over + kneeDb / 2) ** 2 / (2 * kneeDb) : Math.max(0, over) * (1 - 1 / ratio);
        gain *= dbGain(-reduction);
      }
      // Gentle protection for EQ boosts/makeup; does not lift quiet input or silence.
      const protect = x => Math.abs(x) <= .98 ? x : Math.sign(x) * (.98 + .02 * (1 - Math.exp(-((Math.abs(x) - .98) / .02))));
      out[i] = protect(left * gain) * 32768; out[i + 1] = protect(right * gain) * 32768;
    }
    return out;
  }
}
