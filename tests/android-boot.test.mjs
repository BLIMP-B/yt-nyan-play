import test from 'node:test';
import assert from 'node:assert/strict';
import { bootProperties, waitForAndroidBoot, emulatorArguments } from '../apps/desktop/core/android-boot.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';

test('first boot can progress beyond the old three-minute limit and waits for Google Play package readiness', async () => {
  let clock = 0, packageChecks = 0; const phases = [];
  const state = await waitForAndroidBoot(async args => {
    if (args[0] === 'logcat') return clock >= 190000 ? 'boot_progress_pms_ready: 190000' : 'boot_progress_system_run: 3000';
    if (args.includes('getprop')) return `[init.svc.zygote]: [running]\r\n[init.svc.bootanim]: [running]\r\n[sys.boot_completed]: [${clock >= 200000 ? '1' : '0'}]\r\n`;
    if (args.includes('path')) return ++packageChecks >= 2 ? 'package:/product/priv-app/Phonesky/Phonesky.apk' : '';
    throw new Error('unexpected ADB call');
  }, { now: () => clock, delay: async ms => { clock += ms; }, changed: state => phases.push(state.phase) });
  assert.ok(state.elapsedMs > 180000); assert.equal(packageChecks, 2); assert.ok(phases.includes('Androidシステムの初期化')); assert.equal(state.properties['sys.boot_completed'], '1');
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
  assert.equal(bootProperties('[sys.boot_completed]: [1]\r\n')['sys.boot_completed'], '1');
  assert.equal(normalizeConfig({ android: { ramMb: 2048 } }).android.ramMb, 2048);
});
