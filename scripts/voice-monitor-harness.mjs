import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { VoiceMonitorBuffer } from '../apps/desktop/core/voice-monitor-buffer.mjs';

// Execute the production worklet without substituting its DSP or buffer.
export function monitorProcessor(bufferMs = 360, legacy = false) {
  let Processor; const reports = [];
  const path = legacy ? '../tests/fixtures/voice-monitor-v0.5.23-worklet.js' : '../apps/desktop/renderer/voice-monitor-worklet.js';
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*;\n/, '');
  runInNewContext(source, { AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => reports.push(message) }; } }, registerProcessor: (_, cls) => { Processor = cls; }, Uint8Array, DataView, Float32Array, VoiceMonitorBuffer });
  const processor = new Processor({ processorOptions: { bufferMs } }); processor.reports = reports; return processor;
}
export function monitorBlock(processor, count = 128) {
  const output = [new Float32Array(count), new Float32Array(count)]; processor.process([], [output]); return output;
}
export function monitorFrame(processor) {
  const bytes = Buffer.alloc(3840); let offset = 0;
  while (offset < 960) {
    const count = Math.min(128, 960 - offset), output = monitorBlock(processor, count);
    for (let i = 0; i < count; i++) for (let ch = 0; ch < 2; ch++) bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(output[ch][i] * 32768))), (offset + i) * 4 + ch * 2);
    offset += count;
  }
  return bytes;
}
