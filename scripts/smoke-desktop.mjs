import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'nyan-smoke-'));
const environment = { ...process.env, NYAN_DATA_DIR: directory, NYAN_SMOKE_CATALOG: readFileSync(join(import.meta.dirname, 'fixtures/discord-servers.json'), 'utf8') };
delete environment.ELECTRON_RUN_AS_NODE;
// This test loads only local fixtures. Hosted Linux runners cannot use Electron's SUID helper.
const child = spawn(require('electron'), [resolve(import.meta.dirname, '..'), '--smoke', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])], {
  env: environment, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = ''; let errors = '';
child.stdout.on('data', data => { output += data; process.stdout.write(data); });
child.stderr.on('data', data => { errors += data; });
const timeout = setTimeout(() => child.kill(), 45000);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { clearTimeout(timeout); rmSync(directory, { recursive: true, force: true }); if (code !== 0 || !output.includes('NYAN_SMOKE_READY')) { console.error(errors); process.exitCode = 1; } });
