import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyOpusFidelity } from '../scripts/opus-fidelity-probe.mjs';
test('Discord stereo and quiet audio preserve their waveform through the independent FFmpeg decoder at 48/96/128 kbps', async () => {
  const report = await verifyOpusFidelity();
  assert.equal(report.passed, true, JSON.stringify(report));
});
