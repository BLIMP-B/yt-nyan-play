import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectBouyomi } from './bouyomi-import.mjs';

function run(executable, args, input, signal, cwd) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let output = '', error = '', settled = false;
    const finish = (failure, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill(); failure ? reject(failure) : resolve(result); };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('棒読みちゃんの辞書処理がタイムアウトしました')), 30000);
    signal?.addEventListener('abort', abort, { once: true }); child.once('error', finish); child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 1024 * 1024) finish(new Error('辞書処理の出力が大きすぎます')); });
    child.stderr.on('data', bytes => { error = (error + bytes.toString()).slice(-2000); });
    child.once('close', code => { if (code === 0) finish(null, output); else { let message; try { message = JSON.parse(output).error; } catch {} finish(new Error(message || error || '棒読みちゃんの辞書処理を実行できません')); } });
    child.stdin.end(input);
  });
}
export class BouyomiProcessor {
  constructor(userData) { this.userData = userData; this.directory = join(userData, 'bouyomi'); this.tail = Promise.resolve(); this.compiling = null; }
  async helper() {
    if (process.platform !== 'win32') throw new Error('棒読みちゃんのネイティブ前処理はWindowsで利用してください');
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../native/BouyomiBridge.cs'));
    const cache = join(this.userData, 'native'); mkdirSync(cache, { recursive: true });
    const target = join(cache, `BouyomiBridge-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.exe`);
    if (existsSync(target)) return target;
    if (!this.compiling) this.compiling = (async () => {
      const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
      const savedSource = join(cache, 'BouyomiBridge.cs'); writeFileSync(savedSource, source);
      await run(compiler, ['/nologo', '/target:exe', '/platform:x86', '/reference:System.Web.Extensions.dll', `/out:${target}`, savedSource], '', null, cache);
      writeFileSync(`${target}.config`, '<configuration><startup useLegacyV2RuntimeActivationPolicy="true"><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>');
      return target;
    })().finally(() => { this.compiling = null; });
    return this.compiling;
  }
  async request(data, signal) {
    const task = this.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted(); inspectBouyomi(this.directory);
      const executable = await this.helper(); signal?.throwIfAborted();
      return JSON.parse(await run(executable, [this.directory], JSON.stringify(data), signal, this.directory));
    }); this.tail = task; return task;
  }
  process(text, tagMode, signal, educationEnabled = false) { return this.request({ operation: 'process', text, tagMode, educationEnabled }, signal); }
  learn(type, args, signal) { return this.request({ operation: 'learn', type, args }, signal); }
}
