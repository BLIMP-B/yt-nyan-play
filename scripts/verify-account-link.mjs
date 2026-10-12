import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron, chromium } from 'playwright-core';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'nyan-account-link-')), data = join(temp, 'app'), profile = join(temp, 'chrome'), extension = join(temp, 'extension');
const output = join(root, 'dist/account-link-verification'); mkdirSync(output, { recursive: true }); mkdirSync(data);
writeFileSync(join(data, 'config.json'), JSON.stringify({ desktop: { closeToTray: false, notifications: false }, media: { output: 'local' } }));
cpSync(join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
// This fixture pregrants the two OPTIONAL permissions instead of automating Chrome's consent dialog.
// All extension JS and the desktop application are the production source; no real account is used.
manifest.permissions.push('cookies'); manifest.host_permissions.push('http://127.0.0.1/*');
manifest.optional_permissions = []; manifest.optional_host_permissions = ['https://*/*'];
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const report = { passed: false, platform: process.platform, extensionVersion: manifest.version, mode: 'production JS with pregranted optional permissions, local synthetic YouTube session', checks: [] };
let application, context;
async function launchApp() {
  const env = { ...process.env, NYAN_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [root, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], env });
  const page = await application.firstWindow(); await page.waitForFunction(() => document.querySelector('#media-account-service')?.options.length === 8);
  await application.evaluate(({ shell, session }) => {
    globalThis.nyanExternalFixture = [];
    shell.openExternal = async url => { globalThis.nyanExternalFixture.push(url); };
    session.fromPartition('persist:nyan-playback').protocol.handle('https', async request => {
      const cookies = await session.fromPartition('persist:nyan-playback').cookies.get({ url: request.url });
      const loggedIn = cookies.some(c => c.name === 'LOGIN_INFO' && c.value === 'local-session-fixture');
      return new Response(`<html><title>Session playback fixture</title><p id="session-result">${loggedIn ? 'session-present' : 'session-missing'}</p><a id="google-login" target="_blank" href="https://accounts.google.com/ServiceLogin">Google sign-in</a></html>`, { headers: { 'Content-Type': 'text/html' } });
    });
  });
  await page.locator('[data-view="accounts"]').click(); return page;
}
try {
  let ui = await launchApp();
  await ui.locator('#media-account-open').click();
  await ui.locator('#media-account-code').waitFor(); await ui.waitForFunction(() => document.querySelector('#media-account-code').value.startsWith('nyan-youtube:'));
  const code = await ui.locator('#media-account-code').inputValue();
  assert.equal(application.windows().length, 1, 'Google login must not open in Electron');
  assert.deepEqual(await application.evaluate(() => globalThis.nyanExternalFixture), ['https://www.youtube.com/']);
  await ui.locator('#media-account-copy').click(); assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), code);
  await ui.screenshot({ path: join(output, 'desktop-link.png') });
  report.checks.push('YouTube uses ordinary browser; code copy is an explicit local action');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])], ignoreDefaultArgs: ['--disable-extensions'] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = worker.url().split('/')[2];
  await worker.evaluate(async () => {
    await chrome.cookies.set({ url: 'https://www.youtube.com/', domain: '.youtube.com', name: 'LOGIN_INFO', value: 'local-session-fixture', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: Date.now() / 1000 + 86400 });
    await chrome.cookies.set({ url: 'https://www.nicovideo.jp/', name: 'unrelated_fixture', value: 'not-exported', secure: true });
  });
  const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#accountCode').fill(code);
  // Optional permission is already granted by this fixture; exercise the exact production handler.
  await options.locator('#transferAccount').click();
  await options.locator('#accountStatus').filter({ hasText: 'ログイン情報を引き継ぎました' }).waitFor({ timeout: 20000 });
  assert.equal(await options.locator('#accountCode').inputValue(), '');
  await ui.locator('#media-account-status').filter({ hasText: '受け取りました' }).waitFor();
  const cookies = await application.evaluate(async ({ session }) => session.fromPartition('persist:nyan-playback').cookies.get({}));
  assert.equal(cookies.find(c => c.name === 'LOGIN_INFO')?.value, 'local-session-fixture');
  assert.ok(!cookies.some(c => c.name === 'unrelated_fixture'));
  await options.screenshot({ path: join(output, 'extension-received.png') });
  await ui.screenshot({ path: join(output, 'desktop-received.png') });
  report.checks.push('Real Chrome extension options → service worker → authenticated loopback → Electron cookies; unrelated service excluded');
  await options.locator('#accountCode').fill(code); await options.locator('#transferAccount').click();
  await options.locator('#accountStatus').filter({ hasText: /再発行|期限切れ/ }).waitFor({ timeout: 20000 });
  report.checks.push('Consumed connection code cannot be replayed');
  await application.close(); application = null; ui = await launchApp();
  const playbackEvent = application.waitForEvent('window');
  const result = await ui.evaluate(() => window.nyan.invoke('media:add', { url: 'https://www.youtube.com/watch?v=fixture', mode: 'direct' })); assert.equal(result.ok, true);
  const playback = await playbackEvent; await playback.locator('#session-result').filter({ hasText: 'session-present' }).waitFor();
  assert.equal(await playback.evaluate(() => typeof window.nyan), 'undefined');
  await playback.locator('#google-login').click();
  await ui.waitForFunction(() => document.querySelector('#media-account-code').value.startsWith('nyan-youtube:'));
  assert.equal(application.windows().length, 2, 'Google sign-in popup must be sent to the ordinary browser');
  assert.deepEqual(await application.evaluate(() => globalThis.nyanExternalFixture), ['https://www.youtube.com/']);
  await ui.evaluate(() => window.nyan.invoke('control', 'stop'));
  report.checks.push('Session survives app restart and is available in the isolated playback window; Google popup uses external login');
  report.passed = true;
  console.log('ACCOUNT_LINK_VERIFIED ' + JSON.stringify(report));
} finally {
  writeFileSync(join(output, 'account-link-report.json'), JSON.stringify(report, null, 2));
  if (context) await context.close(); if (application) await application.close(); rmSync(temp, { recursive: true, force: true });
}
