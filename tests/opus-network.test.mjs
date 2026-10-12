import test from 'node:test';
import assert from 'node:assert/strict';
import Opus from '../apps/desktop/runtime/opus-codec.mjs';
import { verifyAudioNetwork } from '../scripts/audio-network-probe.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

test('120-ms Opus packets survive concurrent receive/recycle; weak-link defaults reduce jitter and bandwidth overruns', async () => {
  const report = await verifyAudioNetwork();
  assert.ok(report.passed && report.retiredErrorsIsolated);
  assert.equal(report.recycledDecoders, 1280);
});
test('invalid packets/frames and repeated close cannot corrupt another active codec', () => {
  const encoder = new Opus(), decoder = new Opus();
  try {
    assert.throws(() => decoder.decode(Buffer.alloc(4000)), /packet/);
    assert.throws(() => encoder.encode(Buffer.alloc(3), 960), /frame/);
    assert.throws(() => decoder.decode(Buffer.from([255, 255, 255])), /decode/);
    assert.equal(decoder.decode(encoder.encode(Buffer.alloc(3840), 960)).length, 3840);
    decoder.delete(); decoder.delete(); assert.throws(() => decoder.decode(Buffer.from([0])), /closed/);
    assert.ok(encoder.encode(Buffer.alloc(3840), 960).length);
  } finally { encoder.delete(); decoder.delete(); }
});
test('old settings gain the weak-link profile and unsupported profile input is rejected', () => {
  assert.equal(normalizeConfig({ desktop: { theme: 'dark' } }).desktop.networkProfile, 'poor');
  assert.equal(normalizeConfig({ desktop: { audioBitrateKbps: 67 } }).desktop.audioBitrateKbps, 67);
  for (const value of [0, 15, 385, 48.5, '48']) assert.throws(() => normalizeConfig({ desktop: { audioBitrateKbps: value } }), /ビットレート/);
  assert.equal(normalizeConfig({ desktop: { networkProfile: 'balanced' } }).desktop.networkProfile, 'balanced');
  assert.throws(() => normalizeConfig({ desktop: { networkProfile: '__proto__' } }), /通信環境/);
});
