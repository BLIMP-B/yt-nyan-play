import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export class EngineProcess {
  constructor(log) { this.child = null; this.log = log; }
  start(path, url) {
    if (this.child) return;
    if (!path || !existsSync(path)) throw new Error('VOICEVOX Engineの実行ファイルを選択してください');
    const u = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('起動するエンジンのURLはlocalhostに設定してください');
    const child = spawn(path, ['--host', '127.0.0.1', '--port', u.port || '50021'], { windowsHide: true, stdio: 'ignore', shell: false });
    this.child = child;
    child.once('error', e => { this.child = null; this.log('error', `音声エンジンを起動できません: ${e.message}`); });
    child.once('exit', code => { if (this.child === child) this.child = null; this.log('info', `音声エンジンが終了しました (${code})`); });
  }
  stop() { this.child?.kill(); this.child = null; }
}
