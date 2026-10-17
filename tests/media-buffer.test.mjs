import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaBufferState, mediaStreamBuffer } from '../apps/desktop/core/media-buffer.mjs';
const player = () => {
  const media = { currentTime: 0, duration: 60, readyState: 4, paused: true, ended: false, ahead: 0 };
  media.buffered = { length: 1, start: () => media.currentTime, end: () => media.currentTime + media.ahead };
  return media;
};
test('network profiles allocate a bounded source cache and browser startup primes only once', () => {
  assert.deepEqual(mediaStreamBuffer(), { startupSeconds: 4, burstSeconds: 6 });
  assert.equal(mediaStreamBuffer('balanced').startupSeconds, 2); assert.equal(mediaStreamBuffer('fast').startupSeconds, 1);
  const p = player(); p.ahead = .5; assert.equal(mediaBufferState(p, 4).buffering, true);
  p.ahead = 4; assert.equal(mediaBufferState(p, 4).buffering, false);
  p.paused = false; p.readyState = 1; p.ahead = 0;
  assert.equal(mediaBufferState(p, 4).buffering, false, 'The provider owns subsequent rebuffering');
});
test('short finite clips and a position near EOF use the remaining length', () => {
  for (const [duration, time, ahead] of [[2, 0, 2], [60, 59, 1]]) {
    const p = player(); Object.assign(p, { duration, currentTime: time, ahead }); assert.equal(mediaBufferState(p, 4).buffering, false);
  }
});
test('live streams, already-started media and quiet PCM are never gated by volume or a late duration update', () => {
  const live = player(); live.duration = Infinity; live.ahead = .5;
  assert.equal(mediaBufferState(live, 4).buffering, false); assert.equal(live.__nyanBuffer, undefined);
  const started = player(); started.ahead = .5; started.volume = .00001;
  assert.equal(mediaBufferState(started, 4, { observed: true }).buffering, false);
  assert.equal(mediaBufferState(started, 0).buffering, false);
});
test('a provider that stops fetching while paused cannot deadlock the startup gate', () => {
  const p = player(); p.ahead = .5;
  assert.equal(mediaBufferState(p, 4, { now: 0 }).buffering, true);
  assert.equal(mediaBufferState(p, 4, { now: 8000 }).buffering, false);
});
