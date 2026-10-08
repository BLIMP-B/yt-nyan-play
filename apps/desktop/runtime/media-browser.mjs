import { BrowserWindow } from 'electron';
import { validateMediaUrl } from '../core/config.mjs';
import { mediaServiceName } from '../core/protocol.mjs';

import { mediaScript } from '../core/media-script.mjs';
import { APP_ICON } from './app-icon.mjs';
import { playbackSession, guardMediaWindow } from './media-session.mjs';
import { mediaAuthHosts } from '../core/media-accounts.mjs';
import { openAudioStream } from './media-streams.mjs';
import { mediaPolicy, streamContinuation } from '../core/media-policy.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export class MediaBrowser {
  constructor(getConfig, bridge, log, accounts, resolver) { this.getConfig = getConfig; this.bridge = bridge; this.log = log; this.accounts = accounts; this.resolver = resolver; this.window = null; this.paused = false; this.ducked = false; this.status = null; this.overlayGain = 1; this.volumeRampMs = 0; }
  async play(job, signal, { browserOnly = false } = {}) {
    signal.throwIfAborted(); const c = this.getConfig(); const payload = job.payload;
    const { mode, limitSeconds } = mediaPolicy(payload);
    const url = validateMediaUrl(payload.url, c.media.allowedHosts);
    let stream, selected;
    this.playOptions = null;
    if (!browserOnly && c.media.bandwidthSaving && this.resolver) {
      selected = await this.resolver.resolve(url, signal);
      if (selected) try { stream = await openAudioStream(selected, payload.startSeconds || 0, mode, signal, limitSeconds ?? 45); }
      catch (error) { signal.throwIfAborted(); this.log('warn', '音声配信を開始できないためブラウザの最低画質設定へ切り替えます'); }
    }
    if (signal.aborted) { stream?.close(); signal.throwIfAborted(); }
    const ses = playbackSession();
    let window;
    try { window = new BrowserWindow({ width: 1050, height: 720, show: c.media.showWindow, title: payload.title || 'にゃんとーく〜Damare〜 再生',
      icon: APP_ICON, autoHideMenuBar: true, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } }); }
    catch (error) { stream?.close(); throw error; }
    window.webContents.setAudioMuted(true);
    this.window = window; let captureStarted = false, continuation;
    this.playOptions = { startSeconds: stream ? 0 : payload.startSeconds || 0, mode, previewSeconds: limitSeconds ?? 45, volume: c.media.output === 'discord' ? 1 : c.media.volume * this.overlayGain, paused: this.paused, volumeRampMs: 0, bandwidthSaving: c.media.bandwidthSaving && !stream, seek: !stream };
    guardMediaWindow(window, url, this.getConfig, child => this.accounts?.track(child), !payload.background && this.accounts ? () => this.accounts.open('youtube') : undefined);
    const abort = () => { if (!window.isDestroyed()) window.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      let loadingTimer;
      const destination = new URL(url);
      // Official embedded YouTube players require an HTTPS application identity as HTTP Referer.
      const loadOptions = /(^|\.)youtube\.com$/.test(destination.hostname) && destination.pathname.startsWith('/embed/') ? { httpReferrer: 'https://github.com/BLIMP-B/yt-nyan-play' } : {};
      const target = stream ? 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src http://127.0.0.1:*; style-src 'unsafe-inline'"><title>にゃんとーく 音声配信</title><body style="font:16px sans-serif;padding:24px;background:#202020;color:#eee"><p>${selected.audioOnly ? '音声のみの配信' : '最低画質から音声を配信'}を再生しています。</p><audio controls autoplay src="${stream.url}"></audio></body></html>`) : url;
      try { await Promise.race([window.loadURL(target, stream ? {} : loadOptions), new Promise((_, reject) => { loadingTimer = setTimeout(() => reject(new Error('再生ページの読み込みがタイムアウトしました')), 45000); })]); }
      finally { clearTimeout(loadingTimer); }
      const initial = await window.webContents.executeJavaScript(mediaScript(this.playOptions), true);
      if (!initial.found) for (const frame of window.webContents.mainFrame.framesInSubtree.slice(1)) {
        try { await frame.executeJavaScript(mediaScript(this.playOptions), true); } catch {}
      }
      {
        if (c.media.output === 'discord' && !payload.guildId && !payload.master) throw new Error('Discord送信にはサーバーと音声チャンネルを指定してください');
        captureStarted = true; await this.bridge.startCapture(job.id, payload.guildId, signal);
      }
      window.webContents.setAudioMuted(false);
      const startedAt = Date.now(); let seen = false, playbackStartedAt = null, reportedBlock = '', qualityReported = false;
      while (!signal.aborted && !window.isDestroyed()) {
        const captureError = this.bridge.captureError?.(job.id);
        if (captureError) throw new Error(`メディア音声の転送に失敗しました: ${captureError}`);
        const volume = c.media.output === 'discord' ? 1 : this.getConfig().media.volume * (this.ducked ? this.getConfig().media.ducking : 1) * this.overlayGain;
        const options = this.playOptions = { startSeconds: stream ? 0 : payload.startSeconds || 0, mode, previewSeconds: limitSeconds ?? 45, volume, paused: this.paused, volumeRampMs: c.media.output === 'discord' ? 0 : this.volumeRampMs, bandwidthSaving: c.media.bandwidthSaving && !stream, seek: !stream };
        let state = await window.webContents.executeJavaScript(mediaScript(options), true);
        if (!state.found) for (const frame of window.webContents.mainFrame.framesInSubtree.slice(1)) {
          try { const next = await frame.executeJavaScript(mediaScript(options), true); if (next.found) { state = next; break; } } catch {}
        }
        if (state.found && !state.advertisement && state.ready >= 2 && !state.paused && !seen) { seen = true; playbackStartedAt = Date.now(); this.bridge.played?.(job); }
        if (seen && !qualityReported && c.media.bandwidthSaving && !stream) { qualityReported = true; this.log(state.lowestQuality ? 'info' : 'warn', state.lowestQuality ? 'ブラウザの最低画質を指定しました' : 'このページは画質制御APIを公開していません。再生画面の画質設定をご確認ください'); }
        const title = payload.title && payload.title !== new URL(url).hostname ? payload.title : state.pageTitle || payload.title;
        this.status = { ...state, title, service: mediaServiceName(url), mode, limitSeconds, startedAt: playbackStartedAt, paused: this.paused, delivery: stream ? selected.audioOnly ? 'audio-only' : 'lowest-video' : 'browser' }; this.bridge.changed();
        if (state.blockedReason && state.blockedReason !== reportedBlock) {
          const youtube = /(^|\.)youtube\.com$|^youtu\.be$/.test(new URL(url).hostname);
          reportedBlock = state.blockedReason; this.log('warn', `${mediaServiceName(url)}の再生条件: ${state.blockedReason}${state.loginRequired ? youtube ? '。「再生アカウント」で通常ブラウザのログインを引き継いでから再実行してください' : '。再生画面からログインしてください（Chromeとは別のCookie領域です）' : ''}`);
          if (state.loginRequired && !payload.background && !window.isVisible()) window.show();
        }
        if (stream && (stream.error || state.ended || state.error)) {
          // A browser ended event alone cannot prove that the original video ended.
          // Wait for FFmpeg's EOF and compare against the source metadata.
          if (!stream.finished && state.ended) await Promise.race([stream.completion, delay(1000, undefined, { signal })]);
          signal.throwIfAborted();
          continuation = streamContinuation(payload, state, stream);
          if (continuation) { this.log('warn', `${mediaServiceName(url)}の音声配信が途中で終了しました（${{ preview: '再生', full: '無限', direct: '直接' }[mode]} / ${Math.round(Number(state.currentTime) || 0)}秒${stream.expectedSeconds != null ? '・予定' + Math.round(stream.expectedSeconds) + '秒' : ''}）。元のページで${Math.round(continuation.startSeconds)}秒から継続します`); break; }
        }
        if (state.error) throw new Error(`メディアを再生できません: ${state.error}`);
        if (state.previewFinished || state.ended) { this.log('info', `メディア再生を完了しました: ${mediaServiceName(url)} / ${{ preview: '再生', full: '無限', direct: '直接' }[mode]} / ${state.endedReason || 'preview'}`); return; }
        const authenticating = state.loginRequired || mediaAuthHosts(url).includes(new URL(window.webContents.getURL()).hostname);
        if (!seen && Date.now() - startedAt > (authenticating || state.advertisement ? 300000 : 90000)) throw new Error(state.blockedReason || '再生できる動画・音声を見つけられません。ログインやサイトの再生条件を確認してください');
        await new Promise(resolve => { const t = setTimeout(resolve, 500); const stop = () => { clearTimeout(t); resolve(); }; signal.addEventListener('abort', stop, { once: true }); setTimeout(() => signal.removeEventListener('abort', stop), 550).unref(); });
      }
      signal.throwIfAborted(); if (!continuation) throw new Error('再生ウィンドウが閉じられました');
    } finally {
      signal.removeEventListener('abort', abort);
      stream?.close();
      if (captureStarted) await this.bridge.stopCapture(job.id, payload.guildId);
      if (!window.isDestroyed()) window.destroy(); if (this.window === window) this.window = null; this.playOptions = null; this.status = null; this.bridge.changed();
    }
    return this.play({ ...job, payload: continuation }, signal, { browserOnly: true });
  }
  setPaused(value) { this.paused = value; if (this.playOptions && this.window && !this.window.isDestroyed()) void this.window.webContents.executeJavaScript(mediaScript({ ...this.playOptions, paused: value }), true).catch(() => {}); }
  setDucked(value) { if (this.ducked === value) return; this.ducked = value; this.applyVolume(value ? this.getConfig().media.duckFadeOutMs : this.getConfig().media.duckFadeInMs); }
  applyVolume(ms) {
    this.volumeRampMs = ms;
    const c = this.getConfig(); if (c.media.output === 'discord' || !this.playOptions || this.window?.isDestroyed()) return;
    const volume = c.media.volume * (this.ducked ? c.media.ducking : 1) * this.overlayGain;
    void this.window?.webContents.executeJavaScript(mediaScript({ ...this.playOptions, volume, volumeRampMs: ms }), true).catch(() => {});
  }
  setOverlayGain(value, ms = 0) {
    this.overlayGain = value; this.applyVolume(ms);
  }
  show() { if (!this.window?.isDestroyed()) this.window?.show(); }
  close() { if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = null; }
}
