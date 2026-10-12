import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDiagnostics } from '../apps/desktop/runtime/audio-diagnostics.mjs';

test('long-call diagnosis separates dispatch gaps, bursts and source starvation and ignores reconnection time', () => {
  const stats = new AudioDiagnostics();
  stats.dispatch(0); stats.dispatch(20); stats.dispatch(140); stats.dispatch(141); stats.dispatch(160);
  stats.starvation('media'); stats.starvation('background');
  stats.resetClock(); stats.dispatch(100000); stats.dispatch(100020);
  const report = stats.snapshot();
  assert.equal(report.packets, 7); assert.equal(report.gapEvents, 1); assert.equal(report.burstEvents, 1); assert.equal(report.maxGapMs, 120);
  assert.equal(report.mediaStarvations, 1); assert.equal(report.backgroundStarvations, 1);
  assert.deepEqual(report.events.map(e => e.kind), ['send-gap', 'send-burst', 'media-buffer-empty', 'background-buffer-empty']);
  for (let i = 0; i < 100; i++) stats.starvation('media');
  assert.equal(stats.snapshot().events.length, 30);
  report.events[0].kind = 'changed'; assert.equal(stats.snapshot().events[0].kind, 'media-buffer-empty');
});
