import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { AccountLink } from '../apps/desktop/runtime/account-link.mjs';
import { youtubeCookies } from '../apps/desktop/core/youtube-session.mjs';
const cookie = { name: 'LOGIN_INFO', value: 'fixture-only', domain: '.youtube.com', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'no_restriction' };
const origin = 'chrome-extension://' + 'a'.repeat(32);
test('YouTube session validation excludes other domains, stale sessions, malformed values and guest-only cookies', () => {
  const input = cookies => ({ version: 1, cookies });
  const result = youtubeCookies(input([cookie])); assert.equal(result[0].url, 'https://youtube.com/'); assert.equal(result[0].httpOnly, true);
  for (const bad of [{ ...cookie, domain: '.google.com' }, { ...cookie, domain: '.youtube.com.evil.test' }, { ...cookie, value: '\nsecret' }, { ...cookie, expirationDate: 0 }, { ...cookie, partitionKey: {} }, { ...cookie, name: 'VISITOR_INFO1_LIVE' }]) assert.throws(() => youtubeCookies(input([bad])));
  assert.throws(() => youtubeCookies(input([cookie, cookie])));
  assert.throws(() => youtubeCookies({ version: 2, cookies: [cookie] }));
});
test('loopback bridge enforces origin, one-time code, payload scope, cancellation and retry after invalid data', async t => {
  const saved = [], bridge = new AccountLink(async cookies => saved.push(cookies)); t.after(() => bridge.close());
  const state = await bridge.open(), [, port, token] = state.code.split(':');
  const url = `http://127.0.0.1:${port}/youtube-session`;
  const request = (data, extra = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nyan-Account-Code': token, Origin: origin, ...extra }, body: JSON.stringify(data) });
  const input = { version: 1, cookies: [cookie] };
  assert.equal((await request(input, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await request(input, { 'X-Nyan-Account-Code': 'b'.repeat(64) })).status, 403);
  assert.equal((await request({ ...input, cookies: [{ ...cookie, domain: '.google.com' }] })).status, 400); assert.equal(saved.length, 0);
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const response = await request(input); assert.equal(response.status, 200); assert.equal((await response.json()).ok, true); assert.equal(saved.length, 1); assert.equal(bridge.snapshot().code, undefined);
  try { const replay = await request(input); assert.equal(replay.status, 403); } catch { /* Closed one-time listener also rejects replay. */ }
  assert.equal(saved.length, 1);
  const next = await bridge.open(); assert.notEqual(next.code, state.code); bridge.close(); assert.equal(bridge.snapshot().status, 'idle');
});
test('extension exports only YouTube cookies to a fixed loopback endpoint after permission', async () => {
  const sent = [], source = readFileSync(new URL('../extension/account-link.js', import.meta.url), 'utf8');
  const chrome = { permissions: { contains: async () => true }, cookies: { getAll: async query => { assert.equal(query.domain, 'youtube.com'); return [cookie, { ...cookie, name: 'partitioned', partitionKey: {} }]; } } };
  const context = vm.createContext({ chrome, AbortSignal, fetch: async (url, options) => { sent.push({ url, options }); return { ok: true, json: async () => ({ ok: true, count: 1 }) }; } });
  const link = vm.runInContext(source + ';NyanAccountLink', context), code = 'nyan-youtube:11490:' + 'a'.repeat(64);
  for (const bad of ['https://evil.test', 'nyan-youtube:80:' + 'a'.repeat(64), 'nyan-youtube:11490:' + 'x'.repeat(64)]) assert.throws(() => link.parse(bad));
  await link.transfer(code); assert.equal(sent[0].url, 'http://127.0.0.1:11490/youtube-session'); assert.equal(sent[0].options.credentials, 'omit'); assert.equal(JSON.parse(sent[0].options.body).cookies.length, 1);
  chrome.permissions.contains = async () => false; await assert.rejects(link.transfer(code), /許可/); assert.equal(sent.length, 1);
});
