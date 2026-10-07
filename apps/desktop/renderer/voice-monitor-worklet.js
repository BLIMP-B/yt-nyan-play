class NyanVoiceMonitorProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.offset = 0; this.samples = 0; this.primed = false;
    this.port.onmessage = event => {
      const bytes = event.data;
      if (!(bytes instanceof Uint8Array) || bytes.length > 32768 || bytes.length % 4) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), samples = new Float32Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      this.queue.push(samples); this.samples += samples.length;
      // Bound latency even after the renderer resumes from a CPU stall.
      while (this.samples > 48000 && this.queue.length > 1) { this.samples -= this.queue.shift().length - this.offset; this.offset = 0; }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0]; if (!output?.length) return true;
    if (!this.primed && this.samples >= 7680) this.primed = true;
    for (let i = 0; i < output[0].length; i++) {
      if (!this.primed || !this.queue.length) { this.primed = false; break; }
      const frame = this.queue[0]; output[0][i] = frame[this.offset++];
      const right = frame[this.offset++]; if (output[1]) output[1][i] = right;
      this.samples -= 2;
      if (this.offset >= frame.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('nyan-voice-monitor', NyanVoiceMonitorProcessor);
