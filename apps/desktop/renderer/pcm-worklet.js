class NyanPcmProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.bytes = new Uint8Array(3840); this.view = new DataView(this.bytes.buffer); this.position = 0; }
  process(inputs, outputs = []) {
    const input = inputs[0], left = input?.[0], right = input?.[1] || left;
    // This node is also the PC playback path. Reporting PCM alone leaves the
    // connected speaker output silent, even though Discord receives samples.
    for (const [channel, output] of (outputs[0] || []).entries()) {
      const samples = input?.[channel] || left;
      if (samples) output.set(samples); else output.fill(0);
    }
    for (let i = 0; i < (left?.length || 128); i++) {
      this.view.setInt16(this.position * 4, Math.max(-32768, Math.min(32767, Math.round((left?.[i] || 0) * 32767))), true);
      this.view.setInt16(this.position * 4 + 2, Math.max(-32768, Math.min(32767, Math.round((right?.[i] || 0) * 32767))), true);
      if (++this.position === 960) {
        this.port.postMessage(this.bytes, [this.bytes.buffer]);
        this.bytes = new Uint8Array(3840); this.view = new DataView(this.bytes.buffer); this.position = 0;
      }
    }
    return true;
  }
}
registerProcessor('nyan-pcm', NyanPcmProcessor);
