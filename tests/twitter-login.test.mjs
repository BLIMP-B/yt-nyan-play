import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TwitterSource } from '../apps/desktop/runtime/twitter.mjs';
import { XApi } from '../apps/desktop/core/twitter.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'nyan-x-login-')), writes = [];
  const config = normalizeConfig({ twitter: { clientId: 'fixture-client', callbackPort: port } });
  const vault = { hasToken: () => false, read: () => 'fixture-app-token', save: value => writes.push(JSON.parse(value)), clear() {} };
  const source = new TwitterSource(directory, () => config, vault, vault, { logout() {}, log() {} });
  source.api.me = async () => ({ data: { id: 'owner', username: 'fixture' } });
  t.after(async () => { source.stop(); await source.cancelLogin(); rmSync(directory, { recursive: true, force: true }); });
  return { source, config, writes, port };
}
function callback(auth, code = 'fixture-code', state) {
  const url = new URL(auth), redirect = new URL(url.searchParams.get('redirect_uri'));
  redirect.searchParams.set('state', state ?? url.searchParams.get('state')); redirect.searchParams.set('code', code); return redirect;
}
test('concurrent/repeated login requests reuse one registered callback port and PKCE state, and a real HTTP callback saves the owner once', async t => {
  const f = await fixture(t); const [first, second] = await Promise.all([f.source.login(), f.source.login()]); assert.equal(first, second); assert.equal(await f.source.login(), first);
  assert.equal(f.source.snapshot().loginWaiting, true); assert.equal(f.source.snapshot().callbackUrl, `http://127.0.0.1:${f.port}/callback`);
  f.source.tokenRequest = async parameters => { assert.equal(parameters.redirect_uri, new URL(first).searchParams.get('redirect_uri')); assert.equal(createHash('sha256').update(parameters.code_verifier).digest('base64url'), new URL(first).searchParams.get('code_challenge')); return { access_token: 'fixture-user', expires_in: 300 }; };
  const bad = await fetch(callback(first, 'wrong', 'wrong-state')); assert.equal(bad.status, 400); assert.equal(f.source.snapshot().loginWaiting, true);
  const result = await fetch(callback(first)); assert.equal(result.status, 200); assert.match(await result.text(), /ログインしました/); await f.source.callbackClosing;
  assert.equal(f.writes.length, 1); assert.equal(f.source.owner().id, 'owner'); assert.equal(f.source.snapshot().loginWaiting, false);
});
test('cancel, logout and close release the same port repeatedly; obsolete timeouts cannot erase the next listener', async t => {
  const f = await fixture(t), timeouts = [], original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { if (ms === 180000) timeouts.push(fn); return original(fn, ms, ...args); });
  const old = await f.source.login(); await f.source.cancelLogin(); const current = await f.source.login(); assert.notEqual(current, old);
  timeouts[0](); assert.equal(f.source.snapshot().loginWaiting, true); assert.equal(await f.source.login(), current); assert.equal(f.source.error, '');
  for (let i = 0; i < 10; i++) { f.source.logout(); await f.source.login(); }
  f.source.close(); await f.source.callbackClosing; assert.equal(f.source.snapshot().loginWaiting, false); await f.source.login();
});
test('late OAuth completion after cancellation cannot save credentials, change errors, or close a newer listener', async t => {
  const f = await fixture(t); let finish, reached; const exchanged = new Promise(resolve => { reached = resolve; });
  f.source.tokenRequest = () => new Promise(resolve => { finish = resolve; reached(); });
  const old = await f.source.login(), pending = fetch(callback(old)).catch(() => null); await exchanged;
  await f.source.cancelLogin(); const next = await f.source.login(); finish({ access_token: 'old', expires_in: 300 }); await pending; await turn();
  assert.equal(await f.source.login(), next); assert.equal(f.source.snapshot().loginWaiting, true); assert.equal(f.source.error, ''); assert.equal(f.writes.length, 0); assert.equal(f.source.owner(), null);
});
test('an unrelated listener is preserved and port conflicts explain the matching X callback setting; retry works once the port is free', async t => {
  const f = await fixture(t), other = createServer((req, res) => res.end('other')); other.listen(f.port, '127.0.0.1'); await once(other, 'listening');
  t.after(() => new Promise(resolve => other.close(resolve)));
  await assert.rejects(f.source.login(), error => error.code === 'EADDRINUSE' && error.message.includes(String(f.port)) && error.message.includes('Callback URL'));
  assert.equal(f.source.snapshot().loginWaiting, false); assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'other');
  await new Promise(resolve => other.close(resolve)); await f.source.login(); assert.equal(f.source.snapshot().loginWaiting, true);
});
test('cancellation during bind rejects the pending login and leaves the port reusable', async t => {
  const f = await fixture(t), first = f.source.login(); const rejection = assert.rejects(first, { name: 'AbortError' }); await f.source.cancelLogin(); await rejection;
  await f.source.login(); assert.equal(f.source.snapshot().loginWaiting, true);
});
test('X HTTP 402 is reported as an API allocation/payment rejection and stops polling until an explicit retry', async t => {
  const api = new XApi(async () => new Response('{}', { status: 402 })); await assert.rejects(api.me('fixture'), e => e.status === 402 && /利用枠・残高・課金設定/.test(e.message));
  const f = await fixture(t); f.config.twitter.accounts = ['fixture']; f.source.api = api; f.source.running = true; await f.source.poll();
  assert.equal(f.source.running, false); assert.equal(f.source.timer, null); assert.match(f.source.error, /HTTP 402/);
});
