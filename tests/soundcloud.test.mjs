import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { parseMediaCommand, mediaAnnouncement, mediaServiceName } from '../apps/desktop/core/protocol.mjs';
import { validateMediaNavigation } from '../apps/desktop/core/media-navigation.mjs';
import { mediaAccount } from '../apps/desktop/core/media-accounts.mjs';
import { resolveSoundCloudShare, nativeRedirectResponse } from '../apps/desktop/runtime/soundcloud.mjs';
import { EventEmitter } from 'node:events';
import { fetchTitleMetadata } from '../apps/desktop/runtime/media-title-metadata.mjs';

const short = 'https://on.soundcloud.com/example', allowed = ['on.soundcloud.com'];
const target = 'https://soundcloud.com/artist/track/s-private?secret_token=s-token&si=keep';
test('native redirects are read before expected cancellation errors and abort stops the request', async () => {
  let request;
  const factory = options => {
    assert.equal(options.redirect, 'manual'); request = new EventEmitter();
    request.abort = () => { request.aborted = true; queueMicrotask(() => request.emit('error', Error('Redirect was cancelled'))); };
    request.end = () => request.emit('redirect', 302, 'GET', target, {});
    return request;
  };
  const response = await nativeRedirectResponse(factory, short, { signal: new AbortController().signal });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), target); assert.equal(request.aborted, true);
  const controller = new AbortController();
  const waiting = nativeRedirectResponse(options => { const r = factory(options); r.end = () => {}; return r; }, short, { signal: controller.signal });
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(request.aborted, true);
  await new Promise(resolve => setImmediate(resolve));
});
test('SoundCloud is recognized for every playback mode, activity, service announcement and account session', () => {
  const c = normalizeConfig();
  for (const suffix of ['再生', '無限', '直接']) assert.equal(parseMediaCommand(short + suffix, c).url, short);
  assert.equal(mediaServiceName(short), 'SoundCloud'); assert.equal(mediaAnnouncement(short), 'さうんどくらうどを再生します');
  assert.equal(mediaAccount('soundcloud').hosts[0], 'soundcloud.com');
});
test('an approved short-link can reach only the official SoundCloud destination without altering custom allowlists', () => {
  assert.equal(validateMediaNavigation(target, allowed, short), target);
  for (const bad of ['https://soundcloud.com.evil.test/a', 'http://127.0.0.1/x', 'file:///x', 'soundcloud://track/1', 'https://u:p@soundcloud.com/a']) assert.throws(() => validateMediaNavigation(bad, allowed, short));
  assert.throws(() => validateMediaNavigation(target, [], short));
  assert.deepEqual(normalizeConfig({ media: { allowedHosts: allowed } }).media.allowedHosts, allowed);
});
test('share expansion follows bounded HTTP redirects, preserving secret tokens and stopping before the player opens', async () => {
  const calls = [], redirects = [short, 'https://on.soundcloud.com/next'];
  const url = await resolveSoundCloudShare(short, allowed, async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: url === short ? redirects[1] : target } });
  }, new AbortController().signal);
  assert.equal(url, target); assert.deepEqual(calls, redirects);
  assert.equal(await resolveSoundCloudShare(target, ['soundcloud.com'], () => { throw Error('must not fetch a canonical URL'); }, new AbortController().signal), target);
});
test('share expansion rejects invalid redirects, expired links, loops and cancellation instead of launching app schemes', async () => {
  for (const location of ['https://soundcloud.com.evil.test/a', 'https://127.0.0.1/private', 'soundcloud://track/1']) {
    let calls = 0;
    await assert.rejects(resolveSoundCloudShare(short, allowed, async () => { calls++; return new Response(null, { status: 302, headers: { location } }); }, new AbortController().signal));
    assert.equal(calls, 1);
  }
  await assert.rejects(resolveSoundCloudShare(short, allowed, async () => new Response(null, { status: 404 }), new AbortController().signal), /HTTP 404/);
  await assert.rejects(resolveSoundCloudShare(short, allowed, async () => new Response(null, { status: 302, headers: { location: short } }), new AbortController().signal), /転送が多すぎ/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveSoundCloudShare(short, allowed, () => { throw Error('must not fetch'); }, controller.signal), { name: 'AbortError' });
});
test('title acquisition follows the same official SoundCloud redirect with a short-only allowlist', async () => {
  const result = await fetchTitleMetadata(short, allowed, async url => url === short
    ? new Response(null, { status: 302, headers: { location: target } })
    : new Response('<meta property="og:title" content="曲のタイトル"><meta name="author" content="投稿者">', { headers: { 'Content-Type': 'text/html' } }), new AbortController().signal);
  assert.equal(result.title, '曲のタイトル'); assert.equal(result.author, '投稿者');
});
