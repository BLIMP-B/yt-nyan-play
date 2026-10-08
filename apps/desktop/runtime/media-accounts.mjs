import { BrowserWindow, shell } from 'electron';
import { mediaAccount } from '../core/media-accounts.mjs';
import { validateMediaUrl } from '../core/config.mjs';
import { APP_ICON } from './app-icon.mjs';
import { playbackSession, guardMediaWindow } from './media-session.mjs';
import { AccountLink } from './account-link.mjs';
import { isYoutubeCookie, cookieDetails } from '../core/youtube-session.mjs';

export class MediaAccounts {
  constructor(getConfig, log, changed = () => {}) {
    this.getConfig = getConfig; this.log = log; this.windows = new Map(); this.children = new Set();
    this.link = new AccountLink(cookies => this.importYoutube(cookies), changed);
  }
  snapshot() { return this.link.snapshot(); }
  async open(id) {
    const service = mediaAccount(id), existing = this.windows.get(id);
    validateMediaUrl(service.url, this.getConfig().media.allowedHosts);
    if (id === 'youtube') {
      const state = await this.link.open();
      await shell.openExternal(service.url);
      this.log('info', '通常のブラウザでYouTubeを開きました。Chrome / Edgeでログインし、にゃんぷれいの設定から接続コードで引き継いでください');
      return state;
    }
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const window = new BrowserWindow({ width: 1100, height: 800, title: `${service.name}にログイン`, icon: APP_ICON,
      autoHideMenuBar: true, webPreferences: { session: playbackSession(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.windows.set(id, window);
    guardMediaWindow(window, service.url, this.getConfig, child => this.track(child));
    window.on('closed', () => { if (this.windows.get(id) === window) this.windows.delete(id); void playbackSession().cookies.flushStore().catch(() => {}); });
    try { await window.loadURL(service.url); this.log('info', `${service.name}のログイン画面を開きました。再生でもこのログイン情報を使用します`); }
    catch (e) { if (!window.isDestroyed()) window.destroy(); throw new Error(`${service.name}のログイン画面を開けません: ${e.message}`); }
  }
  async importYoutube(cookies) {
    if (BrowserWindow.getAllWindows().some(w => /^https:\/\/(?:[^/]+\.)?youtube\.com\//.test(w.webContents.getURL()))) throw new Error('YouTubeの再生を停止してから、もう一度引き継いでください');
    const jar = playbackSession().cookies;
    const previous = (await jar.get({})).filter(isYoutubeCookie);
    const clear = async () => { for (const c of (await jar.get({})).filter(isYoutubeCookie)) await jar.remove(cookieDetails(c).url, c.name); };
    try { await clear(); for (const c of cookies) await jar.set(c); await jar.flushStore(); }
    catch { await clear(); for (const c of previous) await jar.set(cookieDetails(c)); await jar.flushStore(); throw new Error('ログイン情報の保存に失敗しました。接続コードで再度引き継いでください'); }
    this.log('info', 'YouTubeのログイン情報を受け取りました。次の再生と時報BGMの検索で使用します');
  }
  track(window) { this.children.add(window); window.on('closed', () => this.children.delete(window)); }
  close() { this.link.close(); for (const window of [...this.windows.values(), ...this.children]) if (!window.isDestroyed()) window.destroy(); this.windows.clear(); this.children.clear(); }
}
