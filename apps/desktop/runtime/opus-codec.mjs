import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const factory = require('opusscript/build/opusscript_native_wasm.js');
const MAX_SAMPLES = 5760; // Opus permits packets containing up to 120 ms.
const MAX_PACKET = 3828;
let current;

// The upstream JS wrapper treats byte pointers as HEAPU16 indices and allocates
// too little scratch space for its C++ byte-to-short conversion. Use the same
// libopus WASM with correctly addressed, bounded scratch buffers instead.
export default class OpusCodec {
  static Application = { VOIP: 2048, AUDIO: 2049, RESTRICTED_LOWDELAY: 2051 };
  constructor(rate = 48000, channels = 2, application = OpusCodec.Application.AUDIO) {
    if (rate !== 48000 || ![1, 2].includes(channels)) throw new RangeError('Unsupported Opus format');
    if (!current || current.poisoned) current = { module: factory(), poisoned: false };
    this.state = current; this.channels = channels; this.closed = false; this.pointers = [];
    const m = this.state.module;
    try {
      this.handler = new m.OpusScriptHandler(rate, channels, application);
      const allocate = size => { const pointer = m._malloc(size); if (!pointer) throw new Error('Opus allocation failed'); this.pointers.push(pointer); return pointer; };
      // _encode reads four scratch bytes per input PCM byte, including padding.
      this.inputPcm = allocate(MAX_SAMPLES * channels * 2 * 4);
      this.inputPacket = allocate(MAX_PACKET); this.outputPacket = allocate(MAX_PACKET);
      // _decode writes each PCM byte into one Uint16 slot.
      this.outputPcm = allocate(MAX_SAMPLES * channels * 2 * 2);
    } catch (error) { this.poison(error); this.delete(); throw error; }
  }
  poison(error) { if (error instanceof WebAssembly.RuntimeError) this.state.poisoned = true; }
  run(operation) {
    if (this.closed || this.state.poisoned) throw new Error('Opus codec is closed');
    try { return operation(this.state.module); } catch (error) { this.poison(error); throw error; }
  }
  encode(buffer, frameSize) {
    if (!Buffer.isBuffer(buffer) || ![120, 240, 480, 960, 1920, 2880].includes(frameSize) || buffer.length !== frameSize * this.channels * 2) throw new RangeError('Invalid Opus PCM frame');
    return this.run(m => {
      const offset = this.inputPcm / 2;
      m.HEAPU16.fill(0, offset, offset + buffer.length * 2);
      m.HEAPU16.set(buffer, offset);
      const length = this.handler._encode(this.inputPcm, buffer.length, this.outputPacket, frameSize);
      if (length < 0 || length > MAX_PACKET) throw new Error(`Opus encode failed: ${length}`);
      return Buffer.from(m.HEAPU8.subarray(this.outputPacket, this.outputPacket + length));
    });
  }
  decode(packet) {
    if (!(packet instanceof Uint8Array) || !packet.length || packet.length > MAX_PACKET) throw new RangeError('Invalid Opus packet');
    return this.run(m => {
      m.HEAPU8.set(packet, this.inputPacket);
      const samples = this.handler._decode(this.inputPacket, packet.length, this.outputPcm);
      if (samples < 0 || samples > MAX_SAMPLES) throw new Error(`Opus decode failed: ${samples}`);
      const offset = this.outputPcm / 2;
      return Buffer.from(m.HEAPU16.subarray(offset, offset + samples * this.channels * 2));
    });
  }
  encoderCTL(request, value) {
    return this.run(() => { const result = this.handler._encoder_ctl(request, value); if (result < 0) throw new Error(`Opus control failed: ${result}`); });
  }
  delete() {
    if (this.closed) return;
    this.closed = true;
    // A trapped WASM heap must never be reused or freed through invalid pointers.
    if (!this.state.poisoned) {
      try { if (this.handler) this.state.module.OpusScriptHandler.destroy_handler(this.handler); }
      catch (error) { this.poison(error); }
      if (!this.state.poisoned) for (const pointer of this.pointers) this.state.module._free(pointer);
    }
    this.handler = null; this.pointers = [];
  }
}
