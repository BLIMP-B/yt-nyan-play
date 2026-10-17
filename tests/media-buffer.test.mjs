import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaBufferState, mediaStreamBuffer } from '../apps/desktop/core/media-buffer.mjs';

const player = () => {
  const media = { currentTime: 0, duration: Infinity, readyState: 4, paused: true, ended: false, ahead: 0 };
  media.buffered = { length: 1, start: () => media.currentTime, end: () => media.currentTime + media.ahead };
  return media;
};
test('poor links prime four seconds before playing and refill after an underrun', () => {
  assert.deepEqual(mediaStreamBuffer(), { startupSeconds: 4, burstSeconds: 6 });
  assert.equal(mediaStreamBuffer('balanced').startupSeconds, 2); assert.equal(mediaStreamBuffer('fast').startupSeconds, 1);
  const p = player(); p.ahead = .5;
  assert.equal(mediaBufferState(p, 4, 60).buffering, true);
  p.ahead = 4; assert.equal(mediaBufferState(p, 4, 60).buffering, false);
  p.paused = false; p.readyState = 1; p.ahead = 0;
  assert.equal(mediaBufferState(p, 4, 60).bufferUnderruns, 1);
  p.paused = true; p.readyState = 4; p.ahead = 1;
  assert.equal(mediaBufferState(p, 4, 60).buffering, true);
  p.ahead = 4; assert.equal(mediaBufferState(p, 4, 60).buffering, false);
});
test('short clips, an offset near EOF, unknown durations and completed streams cannot wait forever', () => {
  for (const [duration, time, expected, finished] of [[2, 0, null, false], [60, 59, null, false], [Infinity, 0, 2, false], [Infinity, 0, null, true]]) {
    const p = player(); Object.assign(p, { duration, currentTime: time, ahead: duration === 60 ? 1 : 2 });
    assert.equal(mediaBufferState(p, 4, expected, finished).buffering, false);
  }
  const p = player(); p.readyState = 0;
  assert.equal(mediaBufferState(p, 4, 2, true).buffering, true);
  p.ended = true; assert.equal(mediaBufferState(p, 4, 2, true).buffering, false);
});
test('third-party players keep their adaptive buffering, and normal quiet PCM is never treated as an underrun', () => {
  const p = player(); p.ahead = 4;
  assert.equal(mediaBufferState(p, 0).buffering, false); assert.equal(p.__nyanBuffer, undefined);
  mediaBufferState(p, 4, 60); p.paused = false; p.readyState = 4; p.ahead = .2;
  const state = mediaBufferState(p, 4, 60); assert.equal(state.buffering, false); assert.equal(state.bufferUnderruns, 0);
});
test('finite browser playback primes once, excludes live and already-started media, and cannot deadlock a provider that stops loading when paused', () => {
  const p = player(); p.duration = 60; p.ahead = .5;
  assert.equal(mediaBufferState(p, 4, null, false, { bestEffort: true, now: 0 }).buffering, true);
  assert.equal(mediaBufferState(p, 4, null, false, { bestEffort: true, now: 8000 }).buffering, false);
  p.readyState = 1; p.paused = false; p.ahead = 0;
  assert.equal(mediaBufferState(p, 4, null, false, { bestEffort: true, now: 9000 }).buffering, false);
  const live = player(); live.ahead = .5;
  assert.equal(mediaBufferState(live, 4, null, false, { bestEffort: true }).buffering, false);
  const started = player(); started.duration = 60; started.ahead = .5;
  assert.equal(mediaBufferState(started, 4, null, false, { bestEffort: true, observed: true }).buffering, false);
});
