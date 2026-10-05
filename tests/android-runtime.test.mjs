import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
