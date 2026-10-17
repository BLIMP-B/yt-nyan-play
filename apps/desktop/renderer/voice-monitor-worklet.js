import { VoiceMonitorBuffer } from '../core/voice-monitor-buffer.mjs';

class NyanVoiceMonitorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.users = new Map(); this.clock = 0; this.nextReport = 48000; this.retired = [];
    this.bufferMs = options?.processorOptions?.bufferMs || 360; this.totals = { underruns: 0, discardedSamples: 0 };
    this.port.onmessage = ({ data }) => {
      if (!data || typeof data.userId !== 'string' || typeof data.streamId !== 'string') return;
      let user = this.users.get(data.userId);
      if (data.type === 'idle') { if (user?.streamId === data.streamId) user.idle = true; return; }
      if (data.type === 'end') { if (user?.streamId === data.streamId) user.ended = true; return; }
      if (data.type !== 'pcm' || !(data.bytes instanceof Uint8Array) || !data.bytes.length || data.bytes.length > 32768 || data.bytes.length % 4) return;
      if (!user) { if (this.users.size >= 32) return; user = new VoiceMonitorBuffer(this.bufferMs); this.users.set(data.userId, user); }
      user.streamId = data.streamId; user.push(data.bytes, this.clock);
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0]; if (!output?.length) return true;
    for (const channel of output) channel.fill(0);
    for (const [id, user] of this.users) {
      user.mix(output, this.clock);
      if (user.drained || this.clock - user.lastAt > 3 * 48000) {
        this.retired.push(user.snapshot()); if (this.retired.length > 8) this.retired.shift();
        this.totals.underruns += user.underruns; this.totals.discardedSamples += user.discarded; this.users.delete(id);
      }
    }
    for (const channel of output) for (let i = 0; i < channel.length; i++) channel[i] = Math.max(-1, Math.min(1, channel[i]));
    this.clock += output[0].length;
    if (this.clock >= this.nextReport) {
      this.nextReport = this.clock + 48000;
      const users = [...this.users.values()].map(user => user.snapshot());
      this.port.postMessage({ users, retired: this.retired, underruns: this.totals.underruns + users.reduce((n, u) => n + u.underruns, 0), discardedSamples: this.totals.discardedSamples + users.reduce((n, u) => n + u.discardedSamples, 0) });
    }
    return true;
  }
}
registerProcessor('nyan-voice-monitor', NyanVoiceMonitorProcessor);
