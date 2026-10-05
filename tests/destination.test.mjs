import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDestination } from '../apps/desktop/core/destination.mjs';
import { browserUserAgent } from '../apps/desktop/core/browser-user-agent.mjs';
const bindings = [{ guildId: '11111' }, { guildId: '22222' }];
test('Japanese desktop product names do not leak into HTTP playback headers', () => {
  const ua = browserUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 にゃんとーく〜Damare〜/0.4.2 Chrome/148.0.0.0 Electron/44.5.1 Safari/537.36');
  assert.doesNotThrow(() => new Headers({ 'User-Agent': ua }));
  assert.equal(ua, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36');
});
test('desktop speech and media inherit the only connected guild, with a single configured guild fallback', () => {
  for (const output of ['discord', 'both']) {
    assert.equal(resolveDestination({}, output, bindings, [{ guildId: '22222', status: 'ready' }]).guildId, '22222');
    assert.equal(resolveDestination({}, output, bindings.slice(0, 1), []).guildId, '11111');
    assert.equal(resolveDestination({ guildId: '11111' }, output, bindings, [{ guildId: '22222', status: 'ready' }]).guildId, '11111');
  }
});
test('ambiguous and disconnected master destinations fail before adding jobs; local output needs no guild', () => {
  assert.throws(() => resolveDestination({}, 'discord', bindings, []), /送信先/);
  assert.throws(() => resolveDestination({}, 'discord', bindings, bindings.map(b => ({ ...b, status: 'ready' }))), /複数/);
  assert.throws(() => resolveDestination({ master: true }, 'discord', bindings, []), /VC/);
  assert.equal(resolveDestination({}, 'local', [], []).guildId, '');
  assert.equal(resolveDestination({ master: true }, 'both', [], [{ guildId: '11111', status: 'ready' }]).master, true);
});
