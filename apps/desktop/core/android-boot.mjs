import { setTimeout as wait } from 'node:timers/promises';

export function bootProperties(text) {
  return Object.fromEntries([...text.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)].map(match => [match[1], match[2]]));
}
export function bootPhase(props) {
  if (props['sys.boot_completed'] === '1') return 'アプリの準備';
  if (props['init.svc.bootanim'] === 'running') return 'Androidシステムの初期化';
  if (props['init.svc.zygote'] === 'running' || props['init.svc.zygote64'] === 'running') return 'アプリ実行環境の初期化';
  return '端末への接続待ち';
}
export class AndroidBootError extends Error {
  constructor(message, state) { super(message); this.name = 'AndroidBootError'; this.state = state; }
}
export function systemUiAnrClosePoint(xml) {
  const button = xml.match(/<node\b[^>]*resource-id="android:id\/aerr_close"[^>]*>/g)?.find(node => /package="android"/.test(node) && /enabled="true"/.test(node));
  const bounds = button?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) return null;
  const [left, top, right, bottom] = bounds.slice(1).map(Number);
  if (left >= right || top >= bottom || right > 8192 || bottom > 8192) return null;
  return [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
}
export async function waitForAndroidBoot(adb, {
  signal, maxMs = 720000, stallMs = 300000, now = Date.now,
  delay = ms => wait(ms, undefined, { signal }), changed = () => {},
} = {}) {
  const began = now(); let stable = 0, progressed = began, last = '', state = { phase: '端末への接続待ち', properties: {}, events: '' };
  while (now() - began < maxMs) {
    signal?.throwIfAborted();
    try {
      const properties = bootProperties(await adb(['shell', 'getprop'], { signal, timeout: 10000 }));
      let events = state.events;
      try { events = await adb(['logcat', '-b', 'events', '-d', '-t', '40', '-s', 'boot_progress_start:I', 'boot_progress_preload_start:I', 'boot_progress_preload_end:I', 'boot_progress_system_run:I', 'boot_progress_pms_start:I', 'boot_progress_pms_ready:I', 'boot_progress_enable_screen:I', '*:S'], { signal, timeout: 5000 }); } catch { signal?.throwIfAborted(); }
      state = { phase: bootPhase(properties), properties: Object.fromEntries(Object.entries(properties).filter(([key]) => /^(sys\.boot_completed|dev\.bootcomplete|init\.svc\.(zygote|zygote64|bootanim|surfaceflinger))$/.test(key))), events };
      const token = JSON.stringify(state);
      if (token !== last) { progressed = now(); last = token; }
      if (properties['sys.boot_completed'] === '1') {
        const installed = await adb(['shell', 'pm', 'path', 'com.android.vending'], { signal, timeout: 15000 });
        // First boot can restart adbd after setting boot_completed. A single
        // successful package query is not proof that the transport is stable.
        if (/^package:/m.test(installed)) { if (++stable >= 3) return { ...state, elapsedMs: now() - began }; }
        else stable = 0;
      } else stable = 0;
    } catch (error) { signal?.throwIfAborted(); stable = 0; state.error = error.message; }
    changed({ ...state, elapsedMs: now() - began });
    if (now() - progressed >= stallMs) throw new AndroidBootError('Androidの起動が進んでいません。復旧起動を試します', state);
    await delay(3000);
  }
  throw new AndroidBootError('Androidの起動待ち上限に達しました', state);
}

export async function waitForPlayWindow(adb, launch, {
  signal, maxMs = 120000, now = Date.now,
  delay = ms => wait(ms, undefined, { signal }), changed = () => {},
} = {}) {
  const began = now(), recovered = new Set(); let stable = 0, focus = '', lastError = '', lastLaunch = began;
  while (now() - began < maxMs) {
    signal?.throwIfAborted();
    try {
      // Android 15 keeps current focus in DisplayContent, not the windows-only dump.
      const windows = await adb(['shell', 'dumpsys', 'window', 'displays'], { signal, timeout: 10000 });
      focus = windows.match(/mCurrentFocus[^\r\n]*/)?.[0] || '';
      // Opening Play may reveal a first-boot launcher or Play ANR. Recover
      // each of these packages once; keep their data and other apps untouched.
      const failedPackage = /Application (?:Not Responding|Error)/.test(focus)
        ? ['com.google.android.apps.nexuslauncher', 'com.android.vending', 'com.android.systemui'].find(id => new RegExp(id.replaceAll('.', '\\.') + '(?:[}\\s]|$)').test(focus)) : null;
      if (failedPackage && !recovered.has(failedPackage)) {
        changed(failedPackage === 'com.android.systemui' ? '初回起動のシステムUIを復旧しています' : failedPackage === 'com.android.vending' ? '初回起動のGoogle Playを復旧しています' : '初回起動のホーム画面を復旧しています');
        if (failedPackage === 'com.android.systemui') {
          // Use the framework's own Close app button. Force-stopping System UI
          // can leave system services stopped; never clear its data or tap a
          // guessed screen position, and never interact with another app's ANR.
          await adb(['shell', 'uiautomator', 'dump', '--compressed', '/data/local/tmp/nyantalk-anr.xml'], { signal, timeout: 15000 });
          const point = systemUiAnrClosePoint(await adb(['shell', 'cat', '/data/local/tmp/nyantalk-anr.xml'], { signal, timeout: 10000 }));
          if (!point) throw new Error('システムUIの復旧ボタンを確認できません');
          const current = (await adb(['shell', 'dumpsys', 'window', 'displays'], { signal, timeout: 10000 })).match(/mCurrentFocus[^\r\n]*/)?.[0] || '';
          if (!/Application (?:Not Responding|Error).*com\.android\.systemui(?:[}\s]|$)/.test(current)) { stable = 0; await delay(1000); continue; }
          recovered.add(failedPackage);
          await adb(['shell', 'input', 'tap', ...point.map(String)], { signal, timeout: 10000 });
        } else {
          recovered.add(failedPackage);
          await adb(['shell', 'am', 'force-stop', failedPackage], { signal, timeout: 10000 });
        }
        await launch(); stable = 0; lastLaunch = now();
      } else if (/com\.android\.vending\//.test(focus) && !/Application (?:Not Responding|Error)/.test(focus)) {
        if (++stable >= 3) return { focus, launcherRecovered: recovered.has('com.google.android.apps.nexuslauncher'), playRecovered: recovered.has('com.android.vending'), systemUiRecovered: recovered.has('com.android.systemui'), elapsedMs: now() - began };
      } else stable = 0;
    } catch (error) { signal?.throwIfAborted(); lastError = error.message; stable = 0; }
    if (!stable && now() - lastLaunch >= 15000) {
      lastLaunch = now();
      try { await launch(); } catch (error) { signal?.throwIfAborted(); lastError = error.message; }
    }
    await delay(1000);
  }
  throw new AndroidBootError('Google Playの画面を準備できませんでした。Android画面とネットワーク接続を確認してください', { focus, lastError });
}

export function emulatorArguments(config, { recovery = false, cores = 2 } = {}) {
  const args = ['-avd', config.avd, '-port', String(config.port), '-no-boot-anim',
    '-memory', String(config.ramMb), '-cores', String(Math.max(1, Math.min(4, cores - 2))), '-skin', '720x1280', '-dpi-device', '320', '-show-kernel',
    '-gpu', recovery ? 'software' : config.gpu, '-camera-back', 'none', '-camera-front', 'none'];
  if (!config.audioEnabled) args.push('-no-audio');
  if (!config.showWindow) args.push('-no-window');
  if (recovery) args.push('-no-snapshot-load', '-feature', '-Vulkan');
  return args;
}
