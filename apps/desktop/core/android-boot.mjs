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
export async function waitForAndroidBoot(adb, {
  signal, maxMs = 720000, stallMs = 300000, now = Date.now,
  delay = ms => wait(ms, undefined, { signal }), changed = () => {},
} = {}) {
  const began = now(); let progressed = began, last = '', state = { phase: '端末への接続待ち', properties: {}, events: '' };
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
        if (/^package:/m.test(installed)) return { ...state, elapsedMs: now() - began };
      }
    } catch (error) { signal?.throwIfAborted(); state.error = error.message; }
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
        ? ['com.google.android.apps.nexuslauncher', 'com.android.vending'].find(id => new RegExp(id.replaceAll('.', '\\.') + '(?:[}\\s]|$)').test(focus)) : null;
      if (failedPackage && !recovered.has(failedPackage)) {
        changed(failedPackage === 'com.android.vending' ? '初回起動のGoogle Playを復旧しています' : '初回起動のホーム画面を復旧しています');
        recovered.add(failedPackage);
        await adb(['shell', 'am', 'force-stop', failedPackage], { signal, timeout: 10000 });
        await launch(); stable = 0; lastLaunch = now();
      } else if (/com\.android\.vending\//.test(focus) && !/Application (?:Not Responding|Error)/.test(focus)) {
        if (++stable >= 3) return { focus, launcherRecovered: recovered.has('com.google.android.apps.nexuslauncher'), playRecovered: recovered.has('com.android.vending'), elapsedMs: now() - began };
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
