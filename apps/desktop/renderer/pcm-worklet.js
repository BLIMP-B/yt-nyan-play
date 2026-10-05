class NyanPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]; if (!input?.[0]) return true;
    const left = input[0]; const right = input[1] || left; const bytes = new Uint8Array(left.length * 4); const data = new DataView(bytes.buffer);
    for (let i = 0; i < left.length; i++) {
      data.setInt16(i * 4, Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), true);
      data.setInt16(i * 4 + 2, Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), true);
    }
    this.port.postMessage(bytes, [bytes.buffer]); return true;
  }
}
registerProcessor('nyan-pcm', NyanPcmProcessor);
