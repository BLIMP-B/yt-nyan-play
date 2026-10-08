class NyanPcmProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.bytes = new Uint8Array(3840); this.view = new DataView(this.bytes.buffer); this.position = 0; }
  process(inputs) {
    const input = inputs[0], left = input?.[0], right = input?.[1] || left;
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
