import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AndroidRuntime } from '../apps/desktop/runtime/android.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

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
  console.log('ANDROID_INSTALL_VERIFIED ' + JSON.stringify(report));
} catch (e) { report.error = e.message; console.error(e); process.exitCode = 1; }
finally { clearTimeout(timeout); android.close(); writeFileSync(join(reports, 'android-report.json'), JSON.stringify(report, null, 2)); rmSync(directory, { recursive: true, force: true }); }
