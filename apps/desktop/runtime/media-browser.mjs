import { BrowserWindow, session } from 'electron';
import { validateMediaUrl } from '../core/config.mjs';
import { mediaServiceName } from '../core/protocol.mjs';

import { mediaScript } from '../core/media-script.mjs';

export class MediaBrowser {
  constructor(getConfig, bridge, log) { this.getConfig = getConfig; this.bridge = bridge; this.log = log; this.window = null; this.paused = false; this.ducked = false; this.status = null; }
  async play(job, signal) {
    signal.throwIfAborted(); const c = this.getConfig(); const payload = job.payload;
    const url = validateMediaUrl(payload.url, c.media.allowedHosts);
    const ses = session.fromPartition('persist:nyan-playback');
    ses.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({ width: 1050, height: 720, show: c.media.showWindow, title: payload.title || 'にゃんとーく〜Damare〜 再生',
      autoHideMenuBar: true, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    this.window = window; let captureStarted = false;
    const checkNavigation = (event, destination) => { try { validateMediaUrl(destination, this.getConfig().media.allowedHosts); } catch { event.preventDefault(); } };
    window.webContents.on('will-navigate', checkNavigation); window.webContents.on('will-redirect', checkNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-prevent-unload', event => event.preventDefault());
    const abort = () => { if (!window.isDestroyed()) window.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([window.loadURL(url), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('再生ページの読み込みがタイムアウトしました')), 45000); t.unref(); window.webContents.once('did-finish-load', () => clearTimeout(t)); })]);
      if (c.media.output !== 'local') {
        if (!payload.guildId && !payload.master) throw new Error('Discord送信にはサーバーと音声チャンネルを指定してください');
        captureStarted = true; await this.bridge.startCapture(job.id, payload.guildId, signal);
      }
      const startedAt = Date.now(); let seen = false, playbackStartedAt = null;
      while (!signal.aborted && !window.isDestroyed()) {
        const volume = c.media.output === 'discord' ? 1 : this.getConfig().media.volume * (this.ducked ? this.getConfig().media.ducking : 1);
        const mode = payload.mode || (payload.loop ? 'full' : 'preview');
        const options = { startSeconds: payload.startSeconds, mode, volume, paused: this.paused };
        let state = await window.webContents.executeJavaScript(mediaScript(options), true);
        if (!state.found) for (const frame of window.webContents.mainFrame.framesInSubtree.slice(1)) {
          try { const next = await frame.executeJavaScript(mediaScript(options), true); if (next.found) { state = next; break; } } catch {}
        }
        if (state.found && state.ready >= 2 && !state.paused && !seen) { seen = true; playbackStartedAt = Date.now(); }
        const title = payload.title && payload.title !== new URL(url).hostname ? payload.title : state.pageTitle || payload.title;
        this.status = { ...state, title, service: mediaServiceName(url), startedAt: playbackStartedAt, paused: this.paused }; this.bridge.changed();
        if (state.error) throw new Error(`メディアを再生できません (コード${state.error})`);
        if (state.previewFinished || state.ended) return;
        if (!seen && Date.now() - startedAt > 90000) throw new Error('再生できる動画・音声を見つけられません。ログインやサイトの再生条件を確認してください');
        await new Promise(resolve => { const t = setTimeout(resolve, 500); const stop = () => { clearTimeout(t); resolve(); }; signal.addEventListener('abort', stop, { once: true }); setTimeout(() => signal.removeEventListener('abort', stop), 550).unref(); });
      }
      signal.throwIfAborted(); throw new Error('再生ウィンドウが閉じられました');
    } finally {
      signal.removeEventListener('abort', abort);
      if (captureStarted) await this.bridge.stopCapture(job.id, payload.guildId);
      if (!window.isDestroyed()) window.destroy(); if (this.window === window) this.window = null; this.status = null; this.bridge.changed();
    }
  }
  setPaused(value) { this.paused = value; }
  setDucked(value) { this.ducked = value; }
  show() { if (!this.window?.isDestroyed()) this.window?.show(); }
  close() { if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = null; }
}
