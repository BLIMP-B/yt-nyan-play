import { BrowserWindow } from 'electron';
import { mediaAccount } from '../core/media-accounts.mjs';
import { validateMediaUrl } from '../core/config.mjs';
import { APP_ICON } from './app-icon.mjs';
import { playbackSession, guardMediaWindow } from './media-session.mjs';

export class MediaAccounts {
  constructor(getConfig, log) { this.getConfig = getConfig; this.log = log; this.windows = new Map(); this.children = new Set(); }
  async open(id) {
    const service = mediaAccount(id), existing = this.windows.get(id);
    validateMediaUrl(service.url, this.getConfig().media.allowedHosts);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const window = new BrowserWindow({ width: 1100, height: 800, title: `${service.name}にログイン`, icon: APP_ICON,
      autoHideMenuBar: true, webPreferences: { session: playbackSession(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    this.windows.set(id, window);
    guardMediaWindow(window, service.url, this.getConfig, child => this.track(child));
    window.on('closed', () => { if (this.windows.get(id) === window) this.windows.delete(id); void playbackSession().cookies.flushStore().catch(() => {}); });
    try { await window.loadURL(service.url); this.log('info', `${service.name}のログイン画面を開きました。再生でもこのログイン情報を使用します`); }
    catch (e) { if (!window.isDestroyed()) window.destroy(); throw new Error(`${service.name}のログイン画面を開けません: ${e.message}`); }
  }
  track(window) { this.children.add(window); window.on('closed', () => this.children.delete(window)); }
  close() { for (const window of [...this.windows.values(), ...this.children]) if (!window.isDestroyed()) window.destroy(); this.windows.clear(); this.children.clear(); }
}
