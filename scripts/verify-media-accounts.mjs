import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
const require = createRequire(import.meta.url), root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'damare-accounts-'));
writeFileSync(join(directory, 'config.json'), JSON.stringify(normalizeConfig({ desktop: { closeToTray: false, notifications: false }, media: { output: 'local' } })));
let application;
async function launch() {
  const env = { ...process.env, NYAN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: require('electron'), args: [root, ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], env });
  const ui = await application.firstWindow(); await ui.waitForFunction(() => document.querySelector('#media-account-service')?.options.length === 8);
  await application.evaluate(({ session }) => {
    // Exercise production sign-in windows with local responses, without credentials or real accounts.
    session.fromPartition('persist:nyan-playback').protocol.handle('https', request => {
      const url = new URL(request.url);
      if (!['www.youtube.com', 'accounts.google.com'].includes(url.hostname)) return new Response('fixture only', { status: 404 });
      return new Response(`<html><title>Account fixture</title><p id="cookies"></p>
        <button id="sign-in" onclick="document.cookie='nyan_login=fixture; expires=' + new Date(Date.now()+86400000).toUTCString() + '; path=/; Secure'; location.reload()">Sign in</button>
        <a id="auth" href="https://accounts.google.com/ServiceLogin">Official sign-in</a>
        <a id="return" href="https://www.youtube.com/">Return</a>
        <a id="popup" href="https://accounts.google.com/ServiceLogin" target="_blank">Popup</a>
        <a id="blocked" href="https://accounts.google.com.evil.test/">Unrelated</a>
        <script>document.getElementById('cookies').textContent=document.cookie</script></html>`, { headers: { 'Content-Type': 'text/html' } });
    });
  });
  await ui.locator('[data-view="accounts"]').click();
  return ui;
}
async function open(ui) {
  const opened = application.waitForEvent('window'); await ui.locator('#media-account-open').click();
  const window = await opened; await window.locator('#sign-in').waitFor(); return window;
}
try {
  let ui = await launch(), account = await open(ui);
  assert.equal(await account.evaluate(() => typeof window.nyan), 'undefined');
  assert.equal(await account.evaluate(() => typeof require), 'undefined');
  await account.locator('#sign-in').click(); await account.waitForFunction(() => document.cookie.includes('nyan_login=fixture'));
  const initialWindows = application.windows().length;
  await ui.evaluate(() => window.nyan.invoke('media:login', 'youtube'));
  assert.equal(application.windows().length, initialWindows, 'Opening again should reuse the account window');
  await account.locator('#auth').click(); await account.waitForURL('https://accounts.google.com/ServiceLogin');
  await account.locator('#return').click(); await account.waitForURL('https://www.youtube.com/');
  const popupEvent = application.waitForEvent('window'); await account.locator('#popup').click();
  const popup = await popupEvent; await popup.locator('#sign-in').waitFor();
  await popup.evaluate(() => document.querySelector('#blocked').click()); await popup.waitForTimeout(100);
  assert.equal(popup.url(), 'https://accounts.google.com/ServiceLogin', 'Unexpected auth host was allowed');
  await popup.close(); await account.close();
  assert.equal((await ui.evaluate(() => window.nyan.invoke('state'))).value.jobs.length, 0, 'Account login must not enqueue playback');
  await application.evaluate(async ({ session }) => { await session.fromPartition('persist:nyan-playback').cookies.flushStore(); });
  await application.close(); application = null;
  ui = await launch(); account = await open(ui);
  assert.match(await account.locator('#cookies').textContent(), /nyan_login=fixture/, 'Account cookie did not survive app restart');
  await account.close();
  const playbackEvent = application.waitForEvent('window');
  const result = await ui.evaluate(() => window.nyan.invoke('media:add', { url: 'https://www.youtube.com/watch?v=fixture', mode: 'direct' }));
  assert.equal(result.ok, true);
  const playback = await playbackEvent;
  await playback.locator('#cookies').waitFor();
  assert.match(await playback.locator('#cookies').textContent(), /nyan_login=fixture/, 'Playback did not reuse the saved login');
  await ui.evaluate(() => window.nyan.invoke('control', 'stop'));
  console.log('MEDIA_ACCOUNTS_VERIFIED: login UI, auth redirects/popups, window reuse, restart persistence, playback session and isolated renderer');
} finally { if (application) await application.close(); rmSync(directory, { recursive: true, force: true }); }
