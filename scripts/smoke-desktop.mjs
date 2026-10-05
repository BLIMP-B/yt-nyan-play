import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'nyan-smoke-'));
const child = spawn(require('electron'), [resolve(import.meta.dirname, '..'), '--smoke', ...(process.platform === 'linux' && !process.env.DISPLAY ? ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox'] : []), ...(process.platform === 'linux' && process.env.DISPLAY && process.getuid?.() === 0 ? ['--no-sandbox'] : [])], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', NYAN_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = ''; let errors = '';
child.stdout.on('data', data => { output += data; process.stdout.write(data); });
child.stderr.on('data', data => { errors += data; });
const timeout = setTimeout(() => child.kill(), 45000);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { clearTimeout(timeout); rmSync(directory, { recursive: true, force: true }); if (code !== 0 || !output.includes('NYAN_SMOKE_READY')) { console.error(errors); process.exitCode = 1; } });
