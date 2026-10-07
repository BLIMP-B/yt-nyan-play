import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AndroidRuntime } from '../apps/desktop/runtime/android.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
import { AndroidNotifications } from '../apps/desktop/runtime/android-notifications.mjs';
import { shellQuote } from '../apps/desktop/core/android-packages.mjs';

if (process.platform !== 'win32') throw new Error('Android導入試験はWindows x64で実行してください');
const directory = mkdtempSync(join(tmpdir(), 'damare-android-install-'));
const reports = resolve(import.meta.dirname, '../dist/android-verification'); mkdirSync(reports, { recursive: true });
const config = normalizeConfig(), report = { platform: process.platform, image: config.android.image, installed: false, bootVerified: false };
const android = new AndroidRuntime(directory, () => config, (level, text) => console.log(`${level}: ${text}`));
let last = 0;
android.on('change', () => { if (Date.now() - last > 10000) { last = Date.now(); console.log(android.progress.replace(/[\r\n]+/g, ' ').slice(-300)); } });
const timeout = setTimeout(() => android.cancelSetup(), 25 * 60000);
try {
  await android.refresh();
  // CI installs the official SDK solely to exercise the same setup path as the desktop action.
  const state = await android.setup({ accepted: true }); assert.equal(state.ready, true);
  const devices = await android.javaTool('avdmanager', ['list', 'avd'], { timeout: 60000 });
  assert.ok(devices.includes(state.avd), 'Google Play AVD was not registered');
  report.installed = true; report.avd = state.avd;
  report.emulator = (await android.run(android.paths().emulator, ['-version'])).slice(0, 500);
  try { report.acceleration = await android.run(android.paths().emulator, ['-accel-check']); }
  catch (e) { report.acceleration = e.message; }
  if (/is installed and usable/i.test(report.acceleration)) {
    // Hosted Windows has no physical display adapter. Exercise the supported software renderer.
    config.android.gpu = 'software'; report.gpu = config.android.gpu;
    config.android.audioEnabled = false;
    config.android.showWindow = true;
    await android.start(); report.bootVerified = true;
    const windows = await android.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Android Emulator' } | Select-Object -ExpandProperty MainWindowTitle) -join [Environment]::NewLine"], { timeout: 15000 });
    report.nativeWindowVerified = /Android Emulator/.test(windows);
    assert.equal(report.nativeWindowVerified, true, 'The native Android window for protected authentication screens was not visible');
    report.stage = 'verify-installed-play';
    report.playInstalled = /^package:/m.test(await android.adb(['shell', 'pm', 'path', 'com.android.vending'], { timeout: 60000 }));
    assert.equal(report.playInstalled, true, 'Google Play was not installed in the AVD');
    report.stage = 'open-play'; report.playWindow = await android.openPlay();
    report.playForeground = /com\.android\.vending\//.test(report.playWindow.focus);
    assert.equal(report.playForeground, true, 'Google Play did not become the focused, unobstructed window');
    await new Promise(resolve => setTimeout(resolve, 3000));
    report.playProcess = (await android.adb(['shell', 'pidof', 'com.android.vending'])).trim();
    assert.ok(report.playProcess, 'Google Play did not start');
    const png = await android.adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 15000 });
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    writeFileSync(join(reports, 'android-play.png'), png);
    report.stage = 'notifications';
    const spoken = [];
    const notifications = new AndroidNotifications(android, () => config, { speech: payload => spoken.push(payload), log: (l, t) => console.log(`${l}: ${t}`) }, { automatic: false });
    try {
      await notifications.poll(); await notifications.poll(); assert.equal(spoken.length, 0, 'Existing Android notifications must not be read at startup');
      const post = async body => {
        await android.adb(['shell', `cmd notification post -t ${shellQuote('通知試験')} -S bigtext --bigtext ${shellQuote(body)} damare_notification_probe ${shellQuote('省略本文')}`], { timeout: 10000 });
        for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 200)); await notifications.poll(); if (spoken.at(-1)?.text.includes(body)) break; }
      };
      await post('Androidから届いた新しい通知です');
      assert.equal(spoken.length, 1, notifications.error || 'Native Android notification was not delivered');
      assert.equal(spoken[0].text, '通知試験。Androidから届いた新しい通知です');
      await notifications.poll(); assert.equal(spoken.length, 1, 'Duplicate notification was read twice');
      await post('更新された通知です'); assert.equal(spoken.length, 2, 'Updated notification was not delivered');
      assert.equal(spoken[1].output, 'both'); assert.equal(spoken[1].master, true); assert.equal(spoken[1].system, true);
      config.android.notificationOutput = 'local'; await post('PCだけに送る通知です'); assert.equal(spoken.at(-1).output, 'local');
      config.android.notificationOutput = 'discord'; await post('全VCに送る通知です'); assert.equal(spoken.at(-1).output, 'discord');
      report.notifications = { nativePost: true, expandedText: true, initialBaselineSkipped: true, duplicateSuppressed: true, updateDelivered: true, outputChoices: ['both', 'local', 'discord'], passed: true };
    } finally { notifications.close(); }
  }
  console.log('ANDROID_INSTALL_VERIFIED ' + JSON.stringify(report));
} catch (e) {
  report.error = e.message; report.errorState = e.state; console.error(e); process.exitCode = 1;
  if (android.status === 'running') {
    try {
      writeFileSync(join(reports, 'android-failure.png'), await android.adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 15000 }));
      writeFileSync(join(reports, 'android-display.txt'), await android.adb(['shell', 'dumpsys', 'window', 'displays']));
    } catch (diagnosticError) { report.diagnosticError = diagnosticError.message; }
  }
}
finally {
  clearTimeout(timeout); await android.stop().catch(() => {}); android.close(); report.emulatorOutput = android.emulatorLog; report.bootAttempts = android.bootAttempts;
  writeFileSync(join(reports, 'android-report.json'), JSON.stringify(report, null, 2));
  // This isolated CI machine owns the ADB server; stop it before removing its locked executable.
  await android.run(android.paths().adb, ['kill-server']).catch(() => {});
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
  catch (e) { console.warn('Temporary SDK cleanup: ' + e.message); }
}
