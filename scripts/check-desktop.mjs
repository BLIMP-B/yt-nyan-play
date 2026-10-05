import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]); }
for (const file of files(join(root, 'apps/desktop'))) {
  if (/\.(js|mjs|cjs)$/.test(file)) execFileSync(process.execPath, ['--check', file]);
  assert.ok(!/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(readFileSync(file, 'utf8')), `Webhook secret: ${file}`);
}
const html = readFileSync(join(root, 'apps/desktop/renderer/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(statSync(resolve(root, 'apps/desktop/renderer', match[1])).isFile());
assert.ok(html.includes("script-src 'self'"));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = JSON.parse(readFileSync(join(root, 'apps/desktop/assets/app-icon-source.json'), 'utf8'));
const ico = readFileSync(join(root, manifest.build.win.icon));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(join(root, source.source))), source.sourceSha256, 'Header cat icon changed; rebuild the Windows icon.');
assert.equal(hash(ico), source.iconSha256);
assert.equal(manifest.build.nsis.installerIcon, manifest.build.win.icon);
assert.equal(manifest.build.nsis.uninstallerIcon, manifest.build.win.icon);
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), source.sizes.length);
for (const [index, size] of source.sizes.entries()) {
  const entry = 6 + index * 16, offset = ico.readUInt32LE(entry + 12), length = ico.readUInt32LE(entry + 8);
  assert.equal(ico[entry] || 256, size); assert.equal(ico[entry + 1] || 256, size);
  assert.ok(offset + length <= ico.length);
  assert.deepEqual(ico.subarray(offset, offset + 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
console.log('Desktop syntax, UI references, CSP, and embedded webhook checks passed.');
