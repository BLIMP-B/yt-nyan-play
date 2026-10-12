import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AndroidRuntime } from '../apps/desktop/runtime/android.mjs';
import { normalizeConfig } from '../apps/desktop/core/config.mjs';
function runtime(t) {
  const directory = mkdtempSync(join(tmpdir(), 'damare-android-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new AndroidRuntime(directory, () => normalizeConfig(), () => {});
}
const largeOutput = `const b = Buffer.alloc(65536, 'x'); for (let i = 0; i < 144; i++) process.stdout.write(b); process.stderr.write('installing 100%'); process.stdout.write('INSTALL_COMPLETE');`;
test('Android installation streams more than 5 MB of redraws and retains only a bounded diagnostic tail', async t => {
  const android = runtime(t); let changes = 0; android.on('change', () => changes++);
  const output = await android.run(process.execPath, ['-e', largeOutput], { progress: true });
  assert.ok(output.length <= 16384); assert.match(output, /INSTALL_COMPLETE/); assert.ok(changes > 0 && changes < 20);
});
test('Android progress does not hide installer failures or remove bounded response protection', async t => {
  const android = runtime(t);
  await assert.rejects(android.run(process.execPath, ['-e', largeOutput + "process.stderr.write('missing space'); process.exitCode = 7;"], { progress: true }), /終了コード 7.*missing space/);
  await assert.rejects(android.run(process.execPath, ['-e', largeOutput]), /応答が大きすぎます/);
});
test('Android installation still supports cancellation and process timeouts while streaming', async t => {
  const android = runtime(t), controller = new AbortController();
  android.once('change', () => controller.abort());
  await assert.rejects(android.run(process.execPath, ['-e', "setInterval(() => process.stdout.write('download progress'), 10)"], { progress: true, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(android.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { progress: true, timeout: 100 }), /タイムアウト/);
});
// Node's stdio inheritance closes differently on Windows. The test below
// exercises actual POSIX descriptors; Windows has its own real process-tree
// test and the native Emulator shutdown check in verify-android.
test('POSIX Android stop releases inherited output pipes even after the launcher exited', { skip: process.platform === 'win32' }, async t => {
  const android = runtime(t);
  const script = `const {spawn}=require('node:child_process'); const worker=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:['ignore',1,2]}); process.stdout.write(String(worker.pid)+'\\n',()=>process.exit(0));`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const [output] = await once(child.stdout, 'data'); const workerPid = Number(output.toString().trim());
  assert.ok(Number.isInteger(workerPid) && workerPid > 1);
  t.after(() => { try { process.kill(workerPid); } catch {} child.stdout.destroy(); child.stderr.destroy(); });
  await exited; assert.equal(child.stdout.destroyed, false, 'The worker must retain the inherited pipe for this regression');
  android.child = child; android.adb = async () => { throw new Error('An exited launcher must not issue more ADB commands'); };
  await android.stop(); assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true);
});
test('Windows Android tool timeouts terminate the owned subprocess tree', { skip: process.platform !== 'win32' }, async t => {
  const android = runtime(t), file = join(android.directory, 'owned-pids.json'); let pids = [];
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { for (const pid of pids) if (alive(pid)) { try { process.kill(pid); } catch {} } });
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  await assert.rejects(android.run(process.execPath, ['-e', script], { timeout: 2000 }), /タイムアウト/);
  pids = JSON.parse(readFileSync(file, 'utf8'));
  for (let i = 0; i < 350 && pids.some(alive); i++) await wait(20);
  assert.deepEqual(pids.map(alive), [false, false], 'A timed-out launcher must not leave its worker running');
});
