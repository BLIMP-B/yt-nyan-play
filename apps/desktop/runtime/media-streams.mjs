import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { MEDIA_EXTRACTOR, streamingService, selectStream } from '../core/media-streams.mjs';
import { mediaPolicy } from '../core/media-policy.mjs';

export class MediaStreamResolver {
  constructor(directory, log, fetcher, cookies) {
    this.directory = join(directory, 'media-tools'); this.log = log; this.fetcher = fetcher; this.cookies = cookies;
    mkdirSync(this.directory, { recursive: true });
    for (const file of readdirSync(this.directory)) if (/^session-[a-f0-9]+\.txt$/.test(file)) try { unlinkSync(join(this.directory, file)); } catch {}
  }
  async install() {
    if (process.platform !== 'win32') throw new Error('音声形式の取得ツールはWindows版で利用します');
    const executable = join(this.directory, `yt-dlp-${MEDIA_EXTRACTOR.version}.exe`);
    if (existsSync(executable) && createHash('sha256').update(readFileSync(executable)).digest('hex') === MEDIA_EXTRACTOR.sha256) return executable;
    if (!this.installing) this.installing = this.download(executable).finally(() => { this.installing = null; });
    return this.installing;
  }
  async download(executable) {
    this.log('info', '音声ストリーミング用ツールを導入しています（約18MB・初回のみ）');
    const response = await this.fetcher(MEDIA_EXTRACTOR.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('音声形式の取得ツールをダウンロードできません');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 24 * 1024 * 1024) throw new Error('音声形式の取得ツールのサイズを確認してください'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== MEDIA_EXTRACTOR.sha256) throw new Error('音声形式の取得ツールの検証に失敗しました');
    writeFileSync(executable + '.tmp', bytes, { mode: 0o700 }); renameSync(executable + '.tmp', executable); return executable;
  }
  async resolve(url, signal) {
    const service = streamingService(url); if (!service) return null;
    signal.throwIfAborted();
    let cookieFile;
    try {
      let abortInstall;
      const cancelled = new Promise((_, reject) => { abortInstall = () => reject(signal.reason); signal.addEventListener('abort', abortInstall, { once: true }); });
      let executable;
      try { executable = await Promise.race([this.install(), cancelled]); }
      finally { signal.removeEventListener('abort', abortInstall); }
      signal.throwIfAborted();
      const cookies = (await this.cookies()).filter(c => service[1].some(h => c.domain.replace(/^\./,'') === h || c.domain.replace(/^\./,'').endsWith('.' + h)));
      cookieFile = join(this.directory, 'session-' + randomBytes(16).toString('hex') + '.txt');
      const lines = cookies.filter(c => !/[\t\r\n]/.test(c.domain + c.name + c.path + c.value)).map(c => `${c.httpOnly ? '#HttpOnly_' : ''}${c.domain}\t${c.hostOnly ? 'FALSE' : 'TRUE'}\t${c.path}\t${c.secure ? 'TRUE' : 'FALSE'}\t${Math.floor(c.expirationDate || 0)}\t${c.name}\t${c.value}`);
      writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n' + lines.join('\n') + '\n', { mode: 0o600 });
      const info = await this.extract(executable, ['--ignore-config', '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0', '--cookies', cookieFile, '--js-runtimes', `node:${process.execPath}`, '--', url], signal);
      const selected = selectStream(info, url);
      if (selected) this.log('info', `${selected.service}: ${selected.audioOnly ? '音声のみの配信' : '最低画質' + (selected.height ? `（${selected.height}p）` : '')}を選択しました`);
      else this.log('warn', `${service[0]}: 使用できる音声形式がないため、ブラウザの最低画質設定へ切り替えます`);
      return selected;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      this.log('warn', `${service[0]}: 音声形式を取得できないためブラウザ再生へ切り替えます（${error.name === 'AbortError' ? '取得時間超過' : '取得・導入失敗'}）`); return null;
    } finally { if (cookieFile && existsSync(cookieFile)) unlinkSync(cookieFile); }
  }
  extract(executable, args, signal) {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0, failed;
      const abort = () => { failed = signal.reason || new Error('Cancelled'); child.kill(); };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { failed = new DOMException('Extraction timeout', 'AbortError'); child.kill(); }, 25000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { failed = new Error('Metadata size'); child.kill(); } else chunks.push(chunk); });
      child.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error); });
      child.once('close', code => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (failed || code !== 0) reject(failed || new Error('Extraction failed')); else try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid metadata')); } });
    });
  }
}

// Source objects come only from selectStream; nothing here is exposed to a web page or IPC.
export async function openAudioStream(source, startSeconds, mode, signal, previewSeconds = 45) {
  const policy = mediaPolicy({ mode, previewSeconds });
  signal.throwIfAborted(); const token = randomBytes(24).toString('hex'); let child, server, response;
  const remaining = Number.isFinite(source.duration) && source.duration > 0 ? Math.max(0, source.duration - startSeconds) : null;
  let closed = false, finish;
  const stream = { error: null, finished: false, outputSeconds: 0, expectedSeconds: remaining == null ? null : policy.limitSeconds == null ? remaining : Math.min(remaining, policy.limitSeconds),
    completion: new Promise(resolve => { finish = resolve; }),
    close: () => { closed = true; signal.removeEventListener('abort', abort); child?.kill(); response?.destroy(); server?.close(); } };
  const abort = () => stream.close(); signal.addEventListener('abort', abort, { once: true });
  try {
    server = createServer((request, reply) => {
      if (request.method !== 'GET' || request.url !== '/' + token || request.headers.host !== `127.0.0.1:${server.address().port}` || response) { reply.writeHead(404).end(); return; }
      response = reply; reply.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' }); child.stdout.pipe(reply);
      reply.on('close', () => { if (!reply.writableFinished) child?.kill(); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); server.unref(); signal.throwIfAborted();
    const headers = Object.entries(source.headers || {}).map(([k,v]) => `${k}: ${v}\r\n`).join('');
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:2', '-readrate', '1', ...(source.url.startsWith('https:') ? ['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '408,429,500,502,503,504', '-reconnect_delay_max', '5'] : []), ...(startSeconds ? ['-ss', String(startSeconds)] : []), ...(headers ? ['-headers', headers] : []), '-i', source.url, ...(policy.limitSeconds != null ? ['-t', String(policy.limitSeconds)] : []), '-vn', '-sn', '-dn', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'ogg', '-page_duration', '20000', '-flush_packets', '1', 'pipe:1'];
    child = spawn(ffmpeg.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    child.stderr.on('data', bytes => {
      // Retain only numeric progress, never CDN URLs, request headers or cookies.
      const lines = (tail + bytes.toString()).split('\n'); tail = lines.pop().slice(-8192);
      for (const line of lines) { const match = line.match(/^out_time_us=(\d+)\s*$/); if (match) stream.outputSeconds = Number(match[1]) / 1000000; }
    });
    child.once('close', code => {
      stream.finished = true;
      if (!closed && !signal.aborted) {
        if (code !== 0) stream.error = '音声ストリームの変換・転送が途中で終了しました';
        else if (stream.expectedSeconds != null && stream.outputSeconds + 0.5 < stream.expectedSeconds) stream.error = '音声ストリームが動画の終端より前に終了しました';
      }
      finish();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('音声ストリームの開始がタイムアウトしました')), 20000);
      const ready = () => { if (child.stdout.readableLength > 0) finish(); else child.stdout.once('readable', ready); }; const stopped = code => finish(new Error(`音声ストリームを開始できません（${code}）`)); const cancel = () => finish(signal.reason);
      const finish = error => { clearTimeout(timer); child.stdout.removeListener('readable', ready); child.removeListener('close', stopped); child.removeListener('error', finish); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
      child.stdout.once('readable', ready); child.once('close', stopped); child.once('error', finish); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    stream.url = `http://127.0.0.1:${server.address().port}/${token}`; return stream;
  } catch (error) { stream.close(); throw error; }
}
