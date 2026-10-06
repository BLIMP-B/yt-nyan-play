import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaPolicy, streamContinuation } from '../apps/desktop/core/media-policy.mjs';

test('only 再生 has a duration cap, including legacy stored 無限 requests', () => {
  assert.deepEqual(mediaPolicy({ mode: 'preview' }), { mode: 'preview', limitSeconds: 45 });
  for (const mode of ['full','direct']) assert.deepEqual(mediaPolicy({ mode }), { mode, limitSeconds: null });
  assert.equal(mediaPolicy({ loop: true }).limitSeconds, null);
  assert.throws(() => mediaPolicy({ mode: 'unknown' }), /方式/);
});
test('a short audio EOF cannot complete a longer original video, and continuation preserves offset and mode', () => {
  for (const mode of ['full','direct']) {
    const payload = { mode, startSeconds: 15, guildId: '11111', url: 'https://youtu.be/h9c0gegwcM0' };
    const next = streamContinuation(payload, { currentTime: 30 }, { finished: true, error: null, expectedSeconds: 180 });
    assert.equal(next.startSeconds, 45); assert.equal(next.mode, mode); assert.equal(next.guildId, payload.guildId);
    assert.equal(streamContinuation(payload, { currentTime: 180 }, { finished: true, error: null, expectedSeconds: 180 }), null);
  }
});
test('preview continuation keeps its original 45-second budget instead of starting another 45 seconds', () => {
  const next = streamContinuation({ mode: 'preview', startSeconds: 15 }, { currentTime: 30 }, { finished: true, error: 'unexpected EOF', expectedSeconds: 45 });
  assert.equal(next.startSeconds, 45); assert.equal(mediaPolicy(next).limitSeconds, 15);
  assert.equal(streamContinuation(next, { currentTime: 15 }, { finished: true, expectedSeconds: 15 }), null);
  assert.equal(streamContinuation({ mode: 'full' }, { currentTime: 4 }, { finished: true, error: null, expectedSeconds: null }), null);
});
