import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mediaScript } from '../apps/desktop/core/media-script.mjs';
function state(src, rect = { width: 800, height: 600 }) {
  let clicks = 0;
  const frame = { src, getBoundingClientRect: () => rect };
  const button = { matches: () => true, getAttribute: () => 'Play', click: () => clicks++ };
  const window = { location: { hostname: 'soundcloud.com' } };
  const document = { querySelectorAll: selector => selector === 'iframe' ? [frame] : [], querySelector: selector => selector === '.soundTitle__playButton' ? button : null };
  return { result: vm.runInNewContext(mediaScript({ mode: 'full' }), { window, document, URL, URLSearchParams }), clicks: () => clicks, window };
}
test('an active official SoundCloud login frame waits for sign-in instead of repeatedly pressing play', () => {
  const s = state('https://secure.soundcloud.com/web-auth?client_id=public#start_view=sign_in&is_visible=true');
  assert.equal(s.result.loginRequired, true); assert.equal(s.result.authProvider, 'soundcloud');
  assert.match(s.result.blockedReason, /ログイン/); assert.equal(s.clicks(), 0); assert.equal(s.window.__nyanSitePlay, undefined);
});
test('a hidden login iframe does not block playback after sign-in; unrelated origins cannot impersonate it', () => {
  for (const src of ['https://secure.soundcloud.com/web-auth#is_visible=false', 'https://secure.soundcloud.com.evil.invalid/web-auth#is_visible=true', 'https://secure.soundcloud.com/other#is_visible=true']) {
    const s = state(src); assert.equal(s.result.loginRequired, false, src); assert.equal(s.clicks(), 1);
  }
});
test('older official login frames without a visibility flag require a visible frame', () => {
  assert.equal(state('https://secure.soundcloud.com/web-auth', { width: 0, height: 0 }).result.loginRequired, false);
  assert.equal(state('https://secure.soundcloud.com/web-auth').result.loginRequired, true);
});
