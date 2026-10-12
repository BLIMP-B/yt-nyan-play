import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioBridge } from '../apps/desktop/runtime/audio-bridge.mjs';
function setup() {
  const sent = [], ui = { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args), executeJavaScript: async () => {} } };
  return { bridge: new AudioBridge(() => ui), sent, ui };
}
test('timeout cancels local playback and removes the completion handler so following speech can finish', async () => {
  const { bridge, sent } = setup();
  await assert.rejects(bridge.command('play', { id: 'stalled' }, undefined, 10), /タイムアウト/);
  assert.deepEqual(sent.at(-1), ['nyan:audio', { type: 'cancel', id: 'stalled' }]);
  const next = bridge.command('play', { id: 'next' }); bridge.result({ id: 'next' }); await next;
  assert.equal(bridge.pending.size, 0); bridge.result({ id: 'stalled' });
});
test('cancelling a capture request releases its tracks; renderer shutdown settles every waiter', async () => {
  const { bridge, sent, ui } = setup(); const controller = new AbortController();
  const capture = bridge.command('capture:start', { id: 'capture' }, controller.signal); controller.abort();
  await assert.rejects(capture, { name: 'AbortError' });
  assert.deepEqual(sent.at(-1), ['nyan:audio', { type: 'capture:stop', id: 'capture' }]);
  const playing = bridge.command('play', { id: 'playing' }); ui.webContents.send = () => { throw new Error('Renderer gone'); }; bridge.close();
  await assert.rejects(playing, /終了/); assert.equal(bridge.pending.size, 0);
});
