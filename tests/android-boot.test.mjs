import test from 'node:test';
import assert from 'node:assert/strict';
import { bootProperties, waitForAndroidBoot, waitForPlayWindow, emulatorArguments, systemUiAnrClosePoint } from '../apps/desktop/core/android-boot.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

test('first boot can progress beyond the old three-minute limit and waits for Google Play package readiness', async () => {
  let clock = 0, packageChecks = 0; const phases = [];
  const state = await waitForAndroidBoot(async args => {
    if (args[0] === 'logcat') return clock >= 190000 ? 'boot_progress_pms_ready: 190000' : 'boot_progress_system_run: 3000';
    if (args.includes('getprop')) return `[init.svc.zygote]: [running]\r\n[init.svc.bootanim]: [running]\r\n[sys.boot_completed]: [${clock >= 200000 ? '1' : '0'}]\r\n`;
    if (args.includes('path')) return ++packageChecks >= 2 ? 'package:/product/priv-app/Phonesky/Phonesky.apk' : '';
    throw new Error('unexpected ADB call');
  }, { now: () => clock, delay: async ms => { clock += ms; }, changed: state => phases.push(state.phase) });
  assert.ok(state.elapsedMs > 180000); assert.equal(packageChecks, 4); assert.ok(phases.includes('Androidシステムの初期化')); assert.equal(state.properties['sys.boot_completed'], '1');
});
test('offline ADB during startup is retried and an unchanged boot has a bounded recovery deadline', async () => {
  let clock = 0;
  await assert.rejects(waitForAndroidBoot(async () => { throw new Error('device offline'); }, {
    now: () => clock, delay: async ms => { clock += ms; }, stallMs: 10000,
  }), error => error.name === 'AndroidBootError' && /進んでいません/.test(error.message) && error.state.error === 'device offline');
  assert.ok(clock < 20000);
});
test('boot cancellation aborts polling immediately and a changing boot still respects its absolute upper bound', async () => {
  const controller = new AbortController(); let clock = 0;
  await assert.rejects(waitForAndroidBoot(async () => '', {
    signal: controller.signal, now: () => clock, delay: async () => { controller.abort(new DOMException('stop', 'AbortError')); },
  }), { name: 'AbortError' });
  await assert.rejects(waitForAndroidBoot(async args => args[0] === 'logcat' ? String(clock) : '[sys.boot_completed]: [0]', {
    now: () => clock, delay: async ms => { clock += ms; }, maxMs: 12000,
  }), /上限/);
});
test('recovery preserves user data, disables Vulkan and snapshot loading, and only disables host sound when configured', () => {
  const config = { ...normalizeConfig().android, avd: 'nyantalk_play_api35' };
  const normal = emulatorArguments(config, { cores: 128 }), recovery = emulatorArguments(config, { recovery: true });
  assert.ok(!normal.includes('-no-audio')); assert.equal(normal[normal.indexOf('-cores') + 1], '4');
  assert.ok(recovery.includes('-no-snapshot-load') && recovery.includes('-Vulkan')); assert.ok(!recovery.includes('-wipe-data'));
  assert.ok(emulatorArguments({ ...config, audioEnabled: false }).includes('-no-audio'));
  assert.ok(normal.includes('-no-window'));
  assert.ok(!emulatorArguments({ ...config, showWindow: true }).includes('-no-window'));
  for (const [host, guest] of [[1, 1], [2, 1], [4, 2], [8, 4]]) {
    const args = emulatorArguments(config, { cores: host });
    assert.equal(Number(args[args.indexOf('-cores') + 1]), guest, 'Windows audio and UI must retain host CPU capacity');
  }
  assert.equal(bootProperties('[sys.boot_completed]: [1]\r\n')['sys.boot_completed'], '1');
  assert.equal(normalizeConfig({ android: { ramMb: 2048 } }).android.ramMb, 2048);
});
test('Play readiness recovers a first-boot launcher ANR and requires the actual focused window to remain stable', async () => {
  let clock = 0, recovered = false, launches = 0; const stopped = [];
  const state = await waitForPlayWindow(async args => {
    if (args.includes('force-stop')) { stopped.push(args.at(-1)); recovered = true; return ''; }
    assert.deepEqual(args, ['shell', 'dumpsys', 'window', 'displays']);
    return recovered ? 'mCurrentFocus=Window{123 u0 com.android.vending/com.google.android.finsky.activities.MainActivity}' : 'mCurrentFocus=Window{123 u0 Application Not Responding: com.google.android.apps.nexuslauncher}';
  }, async () => { launches++; }, { now: () => clock, delay: async ms => { clock += ms; } });
  assert.deepEqual(stopped, ['com.google.android.apps.nexuslauncher']); assert.equal(launches, 1); assert.equal(state.launcherRecovered, true); assert.ok(state.elapsedMs >= 3000);
});
test('Play readiness never dismisses another app error and remains cancellable', async () => {
  let clock = 0;
  await assert.rejects(waitForPlayWindow(async args => { assert.ok(!args.includes('force-stop')); return 'mCurrentFocus=Window{1 u0 Application Not Responding: com.other.app}'; }, async () => {}, { now: () => clock, maxMs: 3000, delay: async ms => { clock += ms; } }), /Google Play/);
  const controller = new AbortController();
  await assert.rejects(waitForPlayWindow(async () => '', async () => {}, { signal: controller.signal, delay: async () => controller.abort(new DOMException('stop', 'AbortError')) }), { name: 'AbortError' });
});
test('opening Play recovers its own ANR once, preserves data and still requires stable foreground focus', async () => {
  let clock = 0, restarted = false, launches = 0; const commands = [];
  const state = await waitForPlayWindow(async args => {
    commands.push(args);
    if (args.includes('force-stop')) { restarted = true; return ''; }
    return restarted ? 'mCurrentFocus=Window{1 u0 com.android.vending/MainActivity}' : 'mCurrentFocus=Window{1 u0 Application Not Responding: com.android.vending}';
  }, async () => { launches++; }, { now: () => clock, delay: async ms => { clock += ms; } });
  assert.equal(state.playRecovered, true); assert.equal(state.launcherRecovered, false); assert.equal(launches, 1);
  assert.deepEqual(commands.filter(args => args.includes('force-stop')), [['shell', 'am', 'force-stop', 'com.android.vending']]);
  assert.ok(!commands.some(args => args.includes('clear') || args.includes('uninstall'))); assert.ok(state.elapsedMs >= 3000);
  let retries = 0; clock = 0;
  await assert.rejects(waitForPlayWindow(async args => { if (args.includes('force-stop')) retries++; return 'mCurrentFocus=Window{1 u0 Application Not Responding: com.android.vending}'; }, async () => {}, { now: () => clock, maxMs: 5000, delay: async ms => { clock += ms; } }), /Google Play/);
  assert.equal(retries, 1);
});
test('Play focus verification retries slow launch requests and succeeds when the Activity becomes ready', async () => {
  let clock = 0, launches = 0;
  const state = await waitForPlayWindow(async () => launches > 1 ? 'mCurrentFocus=Window{1 com.android.vending/MainActivity}' : 'mCurrentFocus=Window{1 com.google.android.apps.nexuslauncher/Main}', async () => { if (++launches === 1) throw new Error('initialization timeout'); }, { now: () => clock, maxMs: 60000, delay: async ms => { clock += ms; } });
  assert.equal(launches, 2); assert.match(state.focus, /com.android.vending/);
});

test('boot completion must remain reachable after the first-boot ADB restart', async () => {
  let clock = 0, packages = 0; const phases = [];
  const result = await waitForAndroidBoot(async args => {
    if (clock === 3000) throw new Error("adb.exe: device 'emulator-5580' not found");
    if (args.includes('getprop')) return '[sys.boot_completed]: [1]';
    if (args.includes('path')) { packages++; return 'package:/product/priv-app/Phonesky/Phonesky.apk'; }
    return '';
  }, { now: () => clock, delay: async ms => { clock += ms; }, changed: state => phases.push(state) });
  assert.ok(result.elapsedMs >= 12000); assert.equal(packages, 4);
  assert.ok(phases.some(s => s.error?.includes('not found')));
});


test('System UI ANR recovery clicks only the framework Close app button and still requires stable Play focus', async () => {
  let clock = 0, closed = false; const commands = [];
  const xml = '<hierarchy><node package="android" resource-id="android:id/aerr_close" enabled="true" bounds="[100,600][620,740]" /></hierarchy>';
  const state = await waitForPlayWindow(async args => {
    commands.push(args);
    if (args.includes('uiautomator')) return 'UI hierarchy dumped';
    if (args[1] === 'cat') return xml;
    if (args.includes('tap')) { closed = true; return ''; }
    return closed ? 'mCurrentFocus=Window{1 com.android.vending/Main}' : 'mCurrentFocus=Window{2 Application Not Responding: com.android.systemui}';
  }, async () => {}, { now: () => clock, delay: async ms => { clock += ms; } });
  assert.equal(state.systemUiRecovered, true); assert.equal(state.playRecovered, false);
  assert.deepEqual(commands.filter(args => args.includes('tap')), [['shell', 'input', 'tap', '360', '670']]);
  assert.ok(!commands.some(args => args.includes('force-stop') || args.includes('clear'))); assert.ok(state.elapsedMs >= 3000);
});
test('unidentified, foreign-package and invalid-bounds ANR controls are never clicked', async () => {
  assert.equal(systemUiAnrClosePoint('<node resource-id="android:id/aerr_close" package="com.other.app" enabled="true" bounds="[1,1][2,2]"/>'), null);
  assert.equal(systemUiAnrClosePoint('<node resource-id="android:id/aerr_close" package="android" enabled="true" bounds="[10,10][9000,20]"/>'), null);
  assert.equal(systemUiAnrClosePoint('<node resource-id="android:id/aerr_close" package="android" enabled="false" bounds="[1,1][2,2]"/>'), null);
  let clock = 0, taps = 0;
  await assert.rejects(waitForPlayWindow(async args => {
    if (args.includes('tap')) taps++;
    return args.includes('dumpsys') ? 'mCurrentFocus=Window{2 Application Not Responding: com.android.systemui}' : '<hierarchy />';
  }, async () => {}, { now: () => clock, maxMs: 3000, delay: async ms => { clock += ms; } }), /Google Play/);
  assert.equal(taps, 0);
});
test('a persistent System UI ANR is clicked at most once and retains its original failure', async () => {
  let clock = 0, taps = 0;
  await assert.rejects(waitForPlayWindow(async args => {
    if (args.includes('tap')) { taps++; return ''; }
    if (args[1] === 'cat') return '<node resource-id="android:id/aerr_close" package="android" enabled="true" bounds="[100,100][200,200]"/>';
    return 'mCurrentFocus=Window{2 Application Not Responding: com.android.systemui}';
  }, async () => {}, { now: () => clock, maxMs: 5000, delay: async ms => { clock += ms; } }), /Google Play/);
  assert.equal(taps, 1);
});

test('a System UI dialog that disappears during inspection is never tapped', async () => {
  let clock = 0, queries = 0, taps = 0;
  const state = await waitForPlayWindow(async args => {
    if (args.includes('dumpsys')) return ++queries === 1 ? 'mCurrentFocus=Window{2 Application Not Responding: com.android.systemui}' : 'mCurrentFocus=Window{1 com.android.vending/Main}';
    if (args[1] === 'cat') return '<node resource-id="android:id/aerr_close" package="android" enabled="true" bounds="[100,100][200,200]"/>';
    if (args.includes('tap')) taps++;
    return '';
  }, async () => {}, { now: () => clock, delay: async ms => { clock += ms; } });
  assert.equal(taps, 0); assert.equal(state.systemUiRecovered, false);
});
