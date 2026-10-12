import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmClockBuffer } from '../apps/desktop/core/pcm-clock-buffer.mjs';

function signal(samples, start = 0) {
  const bytes = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(10000 * Math.sin((start + i) * Math.PI / 60));
    bytes.writeInt16LE(value, i * 4); bytes.writeInt16LE(-value, i * 4 + 2);
  }
  return bytes;
}
test('independent capture clocks up to 0.25% fast/slow do not periodically refill or discard frames over three simulated minutes', () => {
  for (const bufferMs of [80, 240]) for (const rate of [.9975, 1.0025]) {
    const buffer = new PcmClockBuffer(); let cursor = bufferMs * 48, produced = cursor, last = 0;
    buffer.push(signal(cursor));
    for (let tick = 0; tick < 9000; tick++) {
      // Start with exactly the initial buffer; then deliver a separately clocked
      // producer, varying its delivery by one render quantum.
      if (tick) {
        produced += 960 * rate;
        const end = Math.floor(produced / 128) * 128, n = end - cursor;
        buffer.push(signal(n, cursor)); cursor = end;
      }
      const pcm = buffer.frame(bufferMs); assert.ok(pcm, `${bufferMs}/${rate}: silence at tick ${tick}`);
      for (let i = 0; i < 960; i++) {
        const a = pcm.readInt16LE(i * 4); assert.ok(Math.abs(pcm.readInt16LE(i * 4 + 2) + a) <= 1);
        assert.ok(Math.abs(a - last) < 600, 'discontinuous phase caused a click'); last = a;
      }
    }
    const stats = buffer.snapshot(); assert.equal(stats.underruns, 0); assert.equal(stats.discardedSamples, 0); assert.ok(stats.correctedFrames > 1000);
    assert.ok(stats.bufferedMs > 20 && stats.bufferedMs < 400, JSON.stringify(stats));
  }
});
test('partial PCM waits for priming, real outages are diagnosed, and clearing cannot replay old media', () => {
  const buffer = new PcmClockBuffer(); const pcm = signal(3840); buffer.push(pcm.subarray(0, 513));
  assert.equal(buffer.frame(80), null); buffer.push(pcm.subarray(513)); assert.deepEqual(buffer.frame(80), pcm.subarray(0, 3840));
  while (buffer.frame(80)) {}
  assert.equal(buffer.snapshot().underruns, 1);
  buffer.clear(); buffer.push(Buffer.alloc(3840 * 4)); assert.ok(buffer.frame(80).every(b => b === 0));
});
