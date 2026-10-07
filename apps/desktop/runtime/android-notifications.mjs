import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { parseAndroidNotification } from '../core/android-notifications.mjs';
import { shellQuote } from '../core/android-packages.mjs';

export class AndroidNotifications extends EventEmitter {
  constructor(android, getConfig, { speech, cancel = () => {}, log = () => {} }, { automatic = true } = {}) {
    super(); Object.assign(this, { android, getConfig, speech, cancel, log, automatic });
    this.seen = new Map(); this.baselined = false; this.cursor = 0; this.error = ''; this.count = 0; this.closed = false;
    this.changed = () => this.update(); android.on('change', this.changed); this.update();
  }
  snapshot() { return { enabled: this.getConfig().android.readNotifications, running: Boolean(this.timer || this.controller), count: this.count, error: this.error }; }
  update() {
    const enabled = this.getConfig().android.readNotifications && this.android.status === 'running' && !this.closed;
    if (!enabled) {
      clearTimeout(this.timer); this.timer = null; this.controller?.abort();
      this.seen.clear(); this.baselined = false; this.cursor = 0; this.cancel(); this.error = ''; this.emit('change'); return;
    }
    if (this.automatic && !this.timer && !this.controller) this.schedule(0);
  }
  schedule(ms = 3000) {
    if (this.closed || !this.getConfig().android.readNotifications || this.android.status !== 'running') return;
    this.timer = setTimeout(() => { this.timer = null; void this.poll().finally(() => this.schedule(this.error ? 15000 : 3000)); }, ms);
    this.timer.unref?.();
  }
  async poll() {
    if (this.controller || this.closed || !this.getConfig().android.readNotifications || this.android.status !== 'running' || this.android.busy || this.android.bootController || this.android.playController) return;
    const controller = this.controller = new AbortController(), signal = controller.signal;
    try {
      const list = await this.android.adb(['shell', 'cmd notification list'], { signal, timeout: 3000, maxOutputBytes: 32768 }); signal.throwIfAborted();
      if (/unknown command|permission denial|error:/i.test(list)) throw new Error('このAndroidで通知の取得が許可されていません');
      const keys = [...new Set(list.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+\|[^|\s]+\|/.test(s) && s.length <= 1000))].slice(0, 128);
      const active = new Set(keys); for (const key of this.seen.keys()) if (!active.has(key)) this.seen.delete(key);
      if (!this.baselined) { for (const key of keys) this.seen.set(key, null); this.baselined = true; this.error = ''; return; }
      const fresh = keys.filter(key => !this.seen.has(key));
      const rotation = keys.filter(key => this.seen.has(key)); const offset = rotation.length ? this.cursor % rotation.length : 0;
      const pending = [...fresh, ...rotation.slice(offset), ...rotation.slice(0, offset)].slice(0, 8);
      const until = Date.now() + 5000; let partialError = '';
      for (const key of pending) {
        if (Date.now() >= until) break;
        const old = this.seen.get(key), existed = this.seen.has(key);
        let dump;
        try { dump = await this.android.adb(['shell', `cmd notification get ${shellQuote(key)}`], { signal, timeout: Math.max(1, Math.min(2000, until - Date.now())), maxOutputBytes: 65536 }); signal.throwIfAborted(); }
        catch (error) { signal.throwIfAborted(); partialError = error.message; if (existed) this.cursor++; else this.seen.set(key, ''); continue; }
        const notification = parseAndroidNotification(dump);
        const hash = notification ? createHash('sha256').update(notification.text).digest('hex') : '';
        this.seen.set(key, hash);
        if (!fresh.includes(key)) this.cursor++;
        if (!notification || hash === old || existed && old === null) continue;
        const payload = { text: notification.text, source: 'Android通知', androidNotification: true, system: true, master: true, output: this.getConfig().android.notificationOutput };
        if (this.speech(payload) !== false) this.count++;
      }
      this.error = partialError;
      if (partialError) this.warn(partialError);
    } catch (error) {
      if (!signal.aborted) {
        this.error = error.message;
        this.warn(error.message);
      }
    } finally { if (this.controller === controller) this.controller = null; this.emit('change'); }
  }
  warn(message) { if (!this.lastErrorAt || Date.now() - this.lastErrorAt >= 60000) { this.lastErrorAt = Date.now(); this.log('warn', `Android通知: ${message}`); } }
  close() { this.closed = true; this.android.removeListener('change', this.changed); this.update(); }
}
