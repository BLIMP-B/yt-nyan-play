// Renderer playback must complete or cancel exactly one queued job.
export class AudioBridge {
  constructor(getWindow) { this.getWindow = getWindow; this.pending = new Map(); }
  command(type, data, signal, timeout = 180000) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted(); const id = data.id || crypto.randomUUID();
      const window = this.getWindow();
      if (!window || window.isDestroyed()) throw new Error('音声出力画面が終了しました');
      const cancel = () => { try { if (!window.isDestroyed()) window.webContents.send('nyan:audio', { type: type === 'capture:start' ? 'capture:stop' : 'cancel', id }); } catch {} };
      const finish = error => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { cancel(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('音声処理がタイムアウトしました')), timeout);
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      this.pending.set(id, finish); signal?.addEventListener('abort', abort, { once: true });
      try {
        if (type === 'capture:start') window.webContents.executeJavaScript(`window.nyanCapture(${JSON.stringify({ ...data, type, id })})`, true).catch(finish);
        else window.webContents.send('nyan:audio', { ...data, type, id });
      } catch (error) { finish(error); }
    });
  }
  result(data) { if (typeof data?.id === 'string') this.pending.get(data.id)?.(data.error ? new Error(String(data.error).slice(0, 300)) : null); }
  close() { for (const finish of [...this.pending.values()]) finish(new Error('音声出力画面が終了しました')); }
}
