import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { waitForAndroidBoot, emulatorArguments } from '../core/android-boot.mjs';
import { parseRepository, playImages, windowsTools, verifyChecksum, extractZip, avdName, shellQuote, SDK_REPOSITORY, PLAY_REPOSITORY } from '../core/android-packages.mjs';

export class AndroidRuntime extends EventEmitter {
  constructor(directory, getConfig, log, fetcher = fetch) {
    super(); this.directory = join(directory, 'android'); mkdirSync(this.directory, { recursive: true });
    this.getConfig = getConfig; this.log = log; this.fetcher = fetcher; this.child = null; this.status = 'stopped'; this.progress = ''; this.catalog = []; this.licenses = []; this.manifests = null; this.busy = false; this.frameTimer = null; this.frameBusy = false; this.installController = null;
  }
  paths() { const c = this.activeConfig || this.getConfig().android; const sdk = c.sdkPath || join(this.directory, 'sdk'); const jre = join(this.directory, 'jre'); const java = c.javaPath || (existsSync(jre) ? readdirSync(jre).map(n => join(jre, n, 'bin/java.exe')).find(existsSync) : '') || ''; return { sdk, java, adb: join(sdk, 'platform-tools/adb.exe'), emulator: join(sdk, 'emulator/emulator.exe'), avds: join(this.directory, 'avd') }; }
  snapshot() { const p = this.paths(); return { status: this.status, busy: this.busy, progress: this.progress, catalog: this.catalog, licenses: this.licenses, licenseImage: this.licenseImage, sdkPath: p.sdk, avd: avdName(this.getConfig().android), ready: existsSync(p.emulator) && existsSync(p.adb) && existsSync(join(p.avds, `${avdName(this.getConfig().android)}.ini`)) }; }
  change(text) { if (text) this.progress = text; this.emit('change'); }
  async refresh() {
    const [sdkXml, playXml] = await Promise.all([this.fetchText(SDK_REPOSITORY + 'repository2-1.xml'), this.fetchText(PLAY_REPOSITORY + 'sys-img2-1.xml')]);
    const sdk = parseRepository(sdkXml), play = parseRepository(playXml); this.manifests = { sdk, play }; this.catalog = playImages(play);
    // SDK tools and stable Google Play images use these explicitly displayed terms.
    const selected = this.catalog.find(i => i.id === this.getConfig().android.image);
    this.licenses = [[windowsTools(sdk).licenseId, sdk.licenses], [selected?.licenseId, play.licenses]].map(([id, source]) => ({ id, text: source[id] })).filter(l => l.id && l.text).filter((l, index, all) => all.findIndex(x => x.id === l.id && x.text === l.text) === index);
    if (!selected || !this.licenses.length) throw new Error('選択したAndroidのGoogle SDK利用規約を取得できません'); this.licenseImage = selected.id; this.change(); return this.snapshot();
  }
  async fetchText(url) { const r = await this.fetcher(url, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`Android配布情報: HTTP ${r.status}`); const text = await r.text(); if (text.length > 10 * 1024 * 1024) throw new Error('配布情報が大きすぎます'); return text; }
  async download(url, checksum, algorithm, signal) {
    const r = await this.fetcher(url, { signal }); if (!r.ok) throw new Error(`Androidダウンロード: HTTP ${r.status}`);
    const chunks = []; let size = 0; const length = Number(r.headers.get('content-length'));
    for await (const b of r.body) { signal.throwIfAborted(); size += b.length; if (size > 300 * 1024 * 1024) throw new Error('ダウンロード容量が上限です'); chunks.push(Buffer.from(b)); this.change(`ダウンロード ${Math.floor(size / 1048576)} MB${length ? ' / ' + Math.ceil(length / 1048576) + ' MB' : ''}`); }
    const bytes = Buffer.concat(chunks); verifyChecksum(bytes, checksum, algorithm); return bytes;
  }
  async setup({ accepted = false } = {}) {
    if (process.platform !== 'win32') throw new Error('Android環境のセットアップはWindows x64で実行してください');
    if (this.busy) throw new Error('Androidの処理中です'); if (!accepted) throw new Error('表示されたGoogle SDK利用規約への同意が必要です');
    if (!this.manifests || this.licenseImage !== this.getConfig().android.image) throw new Error('選択したAndroidの配布情報と利用規約を取得し、確認して同意してください');
    const c = structuredClone(this.getConfig().android); const image = this.catalog.find(i => i.id === c.image); if (!image) throw new Error('公開されているGoogle Play対応のバージョンを選んでください');
    this.busy = true; this.installController = new AbortController(); const signal = this.installController.signal;
    try {
      await this.stop(); const p = this.paths(); mkdirSync(p.sdk, { recursive: true }); mkdirSync(p.avds, { recursive: true });
      const tools = windowsTools(this.manifests.sdk), toolsVersionPath = join(p.sdk, 'cmdline-tools/latest/.damare-version');
      if ((!existsSync(join(p.sdk, 'cmdline-tools/latest/bin/android.exe')) && !existsSync(join(p.sdk, 'cmdline-tools/latest/lib/sdkmanager-classpath.jar'))) || !existsSync(toolsVersionPath) || readFileSync(toolsVersionPath, 'utf8') !== tools.checksum) {
        this.change('公式Android SDKツールを取得/更新しています');
        extractZip(await this.download(tools.url, tools.checksum, 'sha1', signal), join(p.sdk, 'cmdline-tools/latest'), 'cmdline-tools/');
        writeFileSync(toolsVersionPath, tools.checksum);
      }
      if (!p.java || !existsSync(p.java)) {
        this.change('Java実行環境を取得しています'); const assets = JSON.parse(await this.fetchText('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse'));
        const pkg = assets[0]?.binary?.package; if (!pkg || !/^https:\/\/github.com\/adoptium\//.test(pkg.link) || !/^[a-f0-9]{64}$/i.test(pkg.checksum)) throw new Error('Java実行環境の配布情報を確認できません');
        extractZip(await this.download(pkg.link, pkg.checksum, 'sha256', signal), join(this.directory, 'jre'));
      }
      mkdirSync(join(p.sdk, 'licenses'), { recursive: true });
      for (const license of this.licenses) { if (!/^[a-zA-Z0-9_-]+$/.test(license.id)) throw new Error('利用規約IDが不正です'); const hash = createHash('sha1').update(license.text.trim()).digest('hex'); writeFileSync(join(p.sdk, 'licenses', license.id), `\n${hash}\n`, { flag: 'a' }); }
      this.change('Emulator・ADB・Google Play対応イメージを導入/更新しています（数GB）');
      await this.installPackages(['platform-tools', 'emulator', c.image], { signal, timeout: 30 * 60000, progress: true });
      if (!existsSync(join(p.avds, `${avdName(c)}.ini`))) {
        this.change('Android仮想端末を作成しています');
        await this.javaTool('avdmanager', ['create', 'avd', '--name', avdName(c), '--package', c.image, '--device', 'pixel_7'], { input: 'no\n', signal, timeout: 120000 });
      }
      this.change('セットアップ/更新が完了しました'); this.log('info', `Android ${image.label} / revision ${image.revision} の環境を準備しました`);
    } catch (e) { this.change('セットアップ/更新に失敗しました'); throw e; }
    finally { this.busy = false; this.installController = null; this.change(); }
    return this.snapshot();
  }
  javaTool(tool, args, options) { const p = this.paths(); if (!p.java) throw new Error('Java実行環境を設定してください'); const main = tool === 'sdkmanager' ? 'com.android.sdklib.tool.sdkmanager.SdkManagerCli' : 'com.android.sdklib.tool.AvdManagerCli'; return this.run(p.java, ['-Dcom.android.sdkmanager.toolsdir=' + join(p.sdk, 'cmdline-tools/latest'), '-classpath', join(p.sdk, `cmdline-tools/latest/lib/${tool}-classpath.jar`), main, ...args], options); }
  installPackages(packages, options) { const p = this.paths(), cli = join(p.sdk, 'cmdline-tools/latest/bin/android.exe'); return existsSync(cli) ? this.run(cli, ['--sdk=' + p.sdk, 'sdk', 'install', ...packages.map(id => id.replace(/;/g, '/'))], options) : this.javaTool('sdkmanager', ['--sdk_root=' + p.sdk, ...packages], options); }
  environment() { return { ...process.env, ANDROID_HOME: this.paths().sdk, ANDROID_AVD_HOME: this.paths().avds, ANDROID_USER_HOME: join(this.directory, 'user') }; }
  run(executable, args, { input = '', timeout = 20000, signal, progress = false, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted(); const child = spawn(executable, args, { env: this.environment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let length = 0, errors = '', tail = '', done = false, lastProgress = 0; const timer = setTimeout(() => finish(new Error('Androidの処理がタイムアウトしました')), timeout);
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      const finish = (error, output) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { child.kill(); reject(error); } else resolve(output); };
      signal?.addEventListener('abort', abort, { once: true }); child.on('error', e => finish(new Error(`Androidツールを実行できません: ${e.code}`))); child.stdin.on('error', () => {});
      const report = b => {
        tail = (tail + b.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-16384);
        if (Date.now() - lastProgress >= 250) { lastProgress = Date.now(); this.change(tail.trim().slice(-500)); }
      };
      child.stdout.on('data', b => {
        if (done) return;
        // Installers redraw progress for multi-GB archives. Retain a tail, not the entire transcript.
        if (progress && !binary) { report(b); return; }
        length += b.length; if (length > (binary ? 20 : 5) * 1048576) return finish(new Error('Androidの応答が大きすぎます'));
        chunks.push(b);
      });
      child.stderr.on('data', b => { if (done) return; errors = (errors + b.toString()).slice(-2000); if (progress && !binary) report(b); });
      child.once('close', code => {
        if (done) return;
        if (code !== 0) finish(new Error(`Androidツールの終了コード ${code}: ${(errors || tail).slice(-500)}`));
        else finish(null, progress && !binary ? tail : binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString());
      }); child.stdin.end(input);
    });
  }
  adb(args, options) { return this.run(this.paths().adb, ['-s', `emulator-${(this.activeConfig || this.getConfig().android).port}`, ...args], options); }
  async start() {
    if (process.platform !== 'win32') throw new Error('Android仮想環境はWindows x64で実行してください');
    if (this.child || this.busy || this.bootController) throw new Error('Androidは起動中またはセットアップ中です'); if (!this.snapshot().ready) throw new Error('先にAndroid環境をセットアップしてください');
    const c = structuredClone(this.getConfig().android); this.activeConfig = c; const p = this.paths();
    const controller = this.bootController = new AbortController(); this.bootAttempts = [];
    try {
      const devices = await this.run(p.adb, ['devices'], { signal: controller.signal }); if (devices.includes(`emulator-${c.port}`)) throw new Error('指定したEmulatorポートは使用中です');
      for (let attempt = 0; attempt < 2; attempt++) {
        controller.signal.throwIfAborted(); this.status = 'booting';
        this.change(attempt ? 'Androidをソフトウェア描画・コールドブートで復旧しています' : 'Androidを起動しています');
        const entry = { recovery: Boolean(attempt), args: emulatorArguments({ ...c, avd: avdName(c) }, { recovery: Boolean(attempt), cores: availableParallelism() }), log: '', state: null };
        this.bootAttempts.push(entry); this.emulatorLog = '';
        const exited = new AbortController();
        const signal = AbortSignal.any([controller.signal, exited.signal]);
        const child = spawn(p.emulator, entry.args, { env: this.environment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child;
        const diagnostic = bytes => { entry.log = (entry.log + bytes.toString()).slice(-65536); this.emulatorLog = entry.log; };
        child.stdout.on('data', diagnostic); child.stderr.on('data', diagnostic);
        child.once('error', e => exited.abort(new Error(`Androidを起動できません: ${e.code}`)));
        child.once('exit', code => {
          exited.abort(new Error(`Androidが終了しました (${code})`));
          if (this.child === child && this.status === 'running') { this.child = null; this.activeConfig = null; this.status = 'stopped'; clearInterval(this.frameTimer); this.change(`Androidが終了しました (${code})`); }
        });
        try {
          entry.state = await waitForAndroidBoot((args, options) => this.adb(args, options), {
            signal, maxMs: c.bootTimeoutSeconds * 1000,
            changed: state => { entry.state = state; this.change(`${attempt ? '復旧起動' : 'Android起動'}: ${state.phase}（${Math.floor(state.elapsedMs / 1000)}秒）`); },
          });
          await this.adb(['shell', 'input', 'keyevent', '82'], { signal }).catch(() => {});
          controller.signal.throwIfAborted(); this.status = 'running'; this.change('Androidを起動しました');
          this.frameTimer = setInterval(() => this.frame(), 350); void this.frame(); return this.snapshot();
        } catch (e) {
          entry.error = signal.aborted ? signal.reason.message : e.message; entry.state = e.state || entry.state;
          await this.stopProcess(); controller.signal.throwIfAborted();
          if (attempt) throw new Error(`Androidを起動できません: ${entry.error}`);
          this.log('warn', `Android初回起動: ${entry.error}。端末データを保持して復旧起動します`);
        }
      }
    } catch (e) {
      await this.stopProcess(); this.activeConfig = null;
      if (controller.signal.aborted) { this.status = 'stopped'; this.change('Androidの起動を中止しました'); }
      else { if (this.emulatorLog) this.log('error', `Android起動診断: ${this.emulatorLog.trim().slice(-2000)}`); this.status = 'error'; this.change(e.message); }
      throw e;
    } finally { if (this.bootController === controller) this.bootController = null; }
  }
  async frame() { if (this.frameBusy || this.status !== 'running') return; this.frameBusy = true; try { const png = await this.adb(['exec-out', 'screencap', '-p'], { binary: true, timeout: 10000 }); if (png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) this.emit('frame', png); } catch (e) { this.progress = e.message; } finally { this.frameBusy = false; } }
  async input(data) {
    if (this.status !== 'running') throw new Error('Androidを起動してください');
    const coordinate = v => { if (!Number.isInteger(v) || v < 0 || v > 8192) throw new Error('座標が不正です'); return String(v); };
    if (data.type === 'tap') return this.adb(['shell', 'input', 'tap', coordinate(data.x), coordinate(data.y)]);
    if (data.type === 'swipe') return this.adb(['shell', 'input', 'swipe', coordinate(data.x), coordinate(data.y), coordinate(data.endX), coordinate(data.endY), String(Math.max(100, Math.min(2000, Number(data.duration) || 300)))]);
    if (data.type === 'key' && [3, 4, 19, 20, 21, 22, 61, 66, 67, 187].includes(data.code)) return this.adb(['shell', 'input', 'keyevent', String(data.code)]);
    if (data.type === 'text' && typeof data.text === 'string' && /^[\x20-\x7e]{1,500}$/.test(data.text)) return this.adb(['shell', 'input', 'text', shellQuote(data.text.replace(/ /g, '%s'))]);
    throw new Error('Android操作を確認してください。日本語はAndroid画面のキーボードから入力できます');
  }
  async openPlay(packageId = '') { if (this.status !== 'running') throw new Error('Androidを起動してください'); if (packageId && !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageId)) throw new Error('アプリのパッケージIDを確認してください'); return packageId ? this.adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellQuote(`market://details?id=${packageId}`)]) : this.adb(['shell', 'monkey', '-p', 'com.android.vending', '-c', 'android.intent.category.LAUNCHER', '1']); }
  cancelSetup() { this.installController?.abort(); }
  async stopProcess() {
    clearInterval(this.frameTimer); const child = this.child; this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    await this.adb(['emu', 'kill'], { timeout: 5000 }).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timer; await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); clearTimeout(timer);
  }
  async stop() { this.bootController?.abort(new DOMException('起動を中止しました', 'AbortError')); await this.stopProcess(); this.activeConfig = null; this.status = 'stopped'; this.change(); }
  close() { this.cancelSetup(); this.bootController?.abort(new DOMException('終了しました', 'AbortError')); clearInterval(this.frameTimer); this.child?.kill(); this.child = null; }
}
