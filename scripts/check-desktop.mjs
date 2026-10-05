import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]); }
for (const file of files(join(root, 'apps/desktop'))) {
  if (/\.(js|mjs|cjs)$/.test(file)) execFileSync(process.execPath, ['--check', file]);
  assert.ok(!/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(readFileSync(file, 'utf8')), `Webhook secret: ${file}`);
}
const html = readFileSync(join(root, 'apps/desktop/renderer/index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(statSync(resolve(root, 'apps/desktop/renderer', match[1])).isFile());
assert.ok(html.includes("script-src 'self'"));
console.log('Desktop syntax, UI references, CSP, and embedded webhook checks passed.');
