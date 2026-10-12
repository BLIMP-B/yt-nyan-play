import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync, lstatSync, cpSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { extractZip } from '../core/android-packages.mjs';

export function inspectBouyomi(directory) {
  const settingsFile = join(directory, 'BouyomiChan.setting');
  if (!existsSync(join(directory, 'BouyomiChan.exe')) || !existsSync(settingsFile)) throw new Error('棒読みちゃん本体と設定ファイルが見つかりません');
  const xml = readFileSync(settingsFile, 'utf8'); if (xml.length > 5 * 1048576 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('棒読みちゃんの設定XMLを確認してください');
  const settings = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml).Settings;
  if (!settings) throw new Error('棒読みちゃんの設定を読み込めません');
  const dictionaries = readdirSync(directory).filter(name => /^Replace(?:Pre|Tag|Study|Word|Talk|Post)(?:Regex)?\.dic$/.test(name)).map(name => {
    const bytes = readFileSync(join(directory, name)); if (bytes.length > 20 * 1048576) throw new Error('辞書ファイルが大きすぎます');
    const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) if (line.split('\t').length !== 4) throw new Error(`${name}の辞書形式を確認してください`);
    return { name, count: lines.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { version: String(settings.PrvVersion || '不明'), dictionaries, settings,
    port: Number(settings.PortNumber), httpPort: Number(settings.PortNumberHttp),
    broadcasterMode: settings.BroadcasterMode === 'true', tagsEnabled: settings.TagEnable === 'true',
    volume: Number(settings.Volume), speed: Number(settings.Speed), tone: Number(settings.Tone), voiceNumber: Number(settings.VoiceTypeNum) };
}
function findRoot(directory, depth = 0) {
  if (existsSync(join(directory, 'BouyomiChan.exe'))) return directory;
  if (depth > 2) return null;
  for (const item of readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) { const root = findRoot(join(directory, item.name), depth + 1); if (root) return root; }
  return null;
}
function checkFolder(directory) {
  let total = 0;
  function visit(path) { for (const item of readdirSync(path)) { const child = join(path, item), stat = lstatSync(child); if (stat.isSymbolicLink()) throw new Error('リンクを含むフォルダは取り込めません'); if (stat.isDirectory()) visit(child); else { total += stat.size; if (total > 1024 * 1048576) throw new Error('取り込むフォルダが大きすぎます'); } } }
  visit(directory);
}
export class BouyomiImport extends EventEmitter {
  constructor(directory) { super(); this.directory = join(directory, 'bouyomi'); this.child = null; this.error = ''; }
  snapshot() { const installed = existsSync(join(this.directory, 'BouyomiChan.setting')); if (!installed) return { imported: false, running: Boolean(this.child), error: this.error }; const { settings, ...info } = inspectBouyomi(this.directory); return { imported: true, running: Boolean(this.child), ...info, error: this.error }; }
  import(source) {
    if (this.child) throw new Error('棒読みちゃんを終了してから取り込んでください');
    const stage = mkdtempSync(join(dirname(this.directory), 'bouyomi-import-'));
    try {
      if (statSync(source).isDirectory()) { checkFolder(source); cpSync(source, stage, { recursive: true }); }
      else { const bytes = readFileSync(source); if (bytes.length > 100 * 1048576) throw new Error('ZIPファイルが大きすぎます'); extractZip(bytes, stage); }
      const root = findRoot(stage); if (!root) throw new Error('棒読みちゃん本体が含まれていません'); const info = inspectBouyomi(root);
      if (existsSync(this.directory)) renameSync(this.directory, `${this.directory}.backup-${Date.now()}`);
      renameSync(root, this.directory); this.error = ''; this.emit('change'); return info;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  start() {
    if (process.platform !== 'win32') throw new Error('棒読みちゃん本体はWindowsで起動してください'); if (this.child) return;
    inspectBouyomi(this.directory);
    const child = spawn(join(this.directory, 'BouyomiChan.exe'), [], { cwd: this.directory, shell: false, stdio: 'ignore' }); this.child = child;
    child.once('error', error => { this.error = `棒読みちゃんを起動できません: ${error.code}`; if (this.child === child) this.child = null; this.emit('change'); });
    child.once('exit', () => { if (this.child === child) this.child = null; this.emit('change'); }); this.emit('change');
  }
  // Ask the owned window to close so its education dictionary and settings can be saved.
  async stop() {
    const child = this.child; if (!child) return;
    await new Promise((resolve, reject) => { const closer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(child.pid)} -ErrorAction SilentlyContinue).CloseMainWindow() | Out-Null`], { windowsHide: true, shell: false, stdio: 'ignore' }); closer.once('error', reject); closer.once('exit', resolve); });
  }
}
