import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = resolve(root, 'extension');
const manifest = JSON.parse(readFileSync(resolve(extension, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, metadata.extensionVersion ?? metadata.version, 'Extension versions must agree');
assert.ok(!manifest.update_url, 'Do not bundle Chrome Web Store update metadata');

function checkReference(path) {
  const absolute = resolve(extension, path);
  assert.ok(absolute.startsWith(extension + sep), `Invalid extension path: ${path}`);
  assert.ok(statSync(absolute).isFile(), `Missing extension file: ${path}`);
}

const references = [
  manifest.background.service_worker,
  manifest.options_page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
  ...manifest.web_accessible_resources.flatMap(group => group.resources),
];
for (const path of new Set(references)) checkReference(path);
const html = readFileSync(resolve(extension, manifest.options_page), 'utf8');
for (const match of html.matchAll(/(src|href)="([^"]+)"/g)) {
  if (match[1] === 'href' && match[2].startsWith('https://')) assert.doesNotThrow(() => new URL(match[2]));
  else checkReference(match[2]);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const files = filesUnder(extension);
for (const path of files) {
  const name = relative(extension, path);
  assert.ok(!name.startsWith('_metadata'), 'Do not bundle store signatures');
  assert.ok(!/\.(crx|pem)$/i.test(path), 'Do not bundle signed archives or private keys');
  const text = readFileSync(path).toString('utf8');
  assert.ok(
    !/https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/.test(text),
    `Embedded Discord webhook found in ${name}`,
  );
  if (path.endsWith('.js')) execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
}
console.log(`Checked ${files.length} extension files: syntax, references, versions, and webhook values.`);
