import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, createWriteStream, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';

export class HourlyModel extends EventEmitter {
  constructor(directory, getConfig, fetcher = fetch) {
    super(); this.directory = join(directory, 'hourly-model'); mkdirSync(this.directory, { recursive: true });
    this.getConfig = getConfig; this.fetcher = fetcher; this.child = null; this.controller = null; this.progress = ''; this.version = ''; this.busy = false;
    const saved = join(this.directory, 'runtime-version.json'); if (existsSync(saved)) { const info = JSON.parse(readFileSync(saved)); this.installedDigest = info.digest; this.version = info.version; }
  }
  executable() { return join(this.directory, 'runtime', 'ollama.exe'); }
  change(text) { this.progress = text; this.emit('change'); }
  snapshot() { return { busy: this.busy, running: Boolean(this.child), installed: existsSync(this.executable()), progress: this.progress, version: this.version }; }
  async request(path, options = {}) { return this.fetcher(new URL(path, this.getConfig().hourly.slmUrl), options); }
  async start(signal) {
    const host = new URL(this.getConfig().hourly.slmUrl);
    const probe = () => this.request('/api/version', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
    try { const response = await probe(); if (response.ok) return; } catch { signal?.throwIfAborted(); }
    if (process.platform !== 'win32' || !existsSync(this.executable())) throw new Error('「SLMを導入・更新」を実行するか、PC内のOllamaへ接続してください');
    if (!['127.0.0.1', 'localhost'].includes(host.hostname)) throw new Error('管理するSLMの接続先は127.0.0.1を指定してください');
    if (!this.child) {
      const child = spawn(this.executable(), ['serve'], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, OLLAMA_HOST: host.host, OLLAMA_MODELS: join(this.directory, 'models'), OLLAMA_NUM_PARALLEL: '1', OLLAMA_NOHISTORY: '1' } });
      this.child = child; this.tail = '';
      child.stderr.on('data', bytes => { this.tail = (this.tail + bytes.toString()).slice(-4000); });
      child.on('error', error => { this.change(`SLMを起動できません: ${error.message}`); });
      child.once('exit', () => { if (this.child === child) this.child = null; this.emit('change'); });
    }
    for (let i = 0; i < 30; i++) { signal?.throwIfAborted(); try { if ((await probe()).ok) { this.change('ローカルSLMを起動しました'); return; } } catch { signal?.throwIfAborted(); } await wait(500, undefined, { signal }); }
    throw new Error('ローカルSLMへ接続できません');
  }
  async setup() {
    if (this.busy) throw new Error('SLMを導入中です'); if (process.platform !== 'win32') throw new Error('SLM管理導入はWindows x64で実行してください');
    this.busy = true; const controller = this.controller = new AbortController(); const signal = controller.signal;
    try {
      this.change('公式Ollama配布情報を取得しています');
      const response = await this.fetcher('https://api.github.com/repos/ollama/ollama/releases/latest', { signal, headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(`Ollama配布情報: HTTP ${response.status}`);
      const release = await response.json(); const asset = release.assets?.find(a => a.name === 'ollama-windows-amd64.zip');
      if (!asset || !/^https:\/\/github\.com\/ollama\/ollama\/releases\/download\/v[\w.+-]+\/ollama-windows-amd64\.zip$/.test(asset.browser_download_url) || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('公式OllamaのWindows x64配布とSHA256を確認できません');
      this.version = release.tag_name; const zip = join(this.directory, 'runtime.zip');
      if (!existsSync(this.executable()) || this.installedDigest !== asset.digest) {
        const download = await this.fetcher(asset.browser_download_url, { signal }); if (!download.ok) throw new Error(`Ollama取得: HTTP ${download.status}`);
        const out = createWriteStream(zip + '.tmp'); const hash = createHash('sha256'); let size = 0, progressAt = 0;
        const failed = new Promise((_, reject) => out.once('error', reject)); failed.catch(() => {});
        try {
          for await (const bytes of download.body) {
            signal.throwIfAborted(); size += bytes.length; if (size > 5 * 1024 ** 3) throw new Error('Ollama配布の容量が上限です'); hash.update(bytes);
            if (!out.write(bytes)) await Promise.race([once(out, 'drain'), failed]);
            if (Date.now() - progressAt > 500) { progressAt = Date.now(); this.change(`SLM実行環境を取得しています ${Math.floor(size / 1048576)} MB`); }
          }
          const finished = once(out, 'finish'); out.end(); await finished;
        } catch (error) { out.destroy(); throw error; }
        if ('sha256:' + hash.digest('hex') !== asset.digest) { rmSync(zip + '.tmp', { force: true }); throw new Error('Ollama配布のSHA256が一致しません'); }
        renameSync(zip + '.tmp', zip); await this.stop(); const destination = join(this.directory, 'runtime'); mkdirSync(destination, { recursive: true }); this.change('SLM実行環境を展開しています');
        await new Promise((resolve, reject) => {
          const child = spawn('tar.exe', ['-xf', zip, '-C', destination], { windowsHide: true, shell: false, signal, stdio: 'ignore' });
          child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Ollamaの展開に失敗しました (${code})`)));
        }); rmSync(zip, { force: true }); this.installedDigest = asset.digest; writeFileSync(join(this.directory, 'runtime-version.json'), JSON.stringify({ digest: asset.digest, version: this.version }));
      }
      await this.start(signal); this.change(`小型モデル ${this.getConfig().hourly.slmModel} を導入しています`);
      const pull = await this.request('/api/pull', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.getConfig().hourly.slmModel, stream: true }) });
      if (!pull.ok) throw new Error(`小型モデル導入: HTTP ${pull.status}`);
      const decoder = new TextDecoder(); let tail = '', succeeded = false;
      for await (const chunk of pull.body) {
        tail += decoder.decode(chunk, { stream: true }); if (tail.length > 65536) throw new Error('モデル導入の応答が大きすぎます');
        const lines = tail.split('\n'); tail = lines.pop();
        for (const line of lines.filter(Boolean)) { const state = JSON.parse(line); if (state.error) throw new Error(state.error); succeeded ||= state.status === 'success'; this.change(`${state.status}${state.total ? ' ' + Math.floor((state.completed || 0) * 100 / state.total) + '%' : ''}`); }
      }
      if (!succeeded) throw new Error('小型モデルの導入完了を確認できません');
      this.change('SLMの導入が完了しました。文章生成を試せます');
    } catch (error) { this.change(signal.aborted ? 'SLMの導入を中止しました' : error.message); throw error; }
    finally { this.busy = false; this.controller = null; this.emit('change'); }
  }
  cancel() { this.controller?.abort(); }
  async stop() {
    const child = this.child; this.child = null; this.emit('change'); if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid) await new Promise(resolve => { const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); kill.once('error', () => { child.kill(); resolve(); }); kill.once('exit', resolve); });
    else child.kill();
  }
  close() { this.cancel(); void this.stop(); }
}
