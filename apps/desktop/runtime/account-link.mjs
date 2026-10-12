import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { youtubeCookies } from '../core/youtube-session.mjs';

const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
export class AccountLink {
  constructor(importCookies, changed = () => {}, lifetimeMs = 600000) { this.importCookies = importCookies; this.changed = changed; this.lifetimeMs = lifetimeMs; this.server = null; this.opening = null; this.state = { status: 'idle' }; }
  snapshot() { return { ...this.state }; }
  async open() {
    if (this.busy) throw new Error('ログイン情報を処理中です。完了してから再発行してください');
    if (this.opening) return this.opening;
    if (this.server && this.state.expiresAt > Date.now()) return this.snapshot();
    this.opening = this.start();
    try { return await this.opening; } finally { this.opening = null; }
  }
  async start() {
    this.close(); this.token = randomBytes(32).toString('hex');
    const server = createServer((request, response) => { void this.handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: 'ログイン情報を引き継げませんでした' })); }); });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    server.maxConnections = 8;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server; server.unref();
    this.state = { status: 'waiting', code: `nyan-youtube:${server.address().port}:${this.token}`, expiresAt: Date.now() + this.lifetimeMs };
    this.timer = setTimeout(() => { this.close(); this.state = { status: 'expired' }; this.changed(); }, this.lifetimeMs); this.timer.unref(); this.changed();
    return this.snapshot();
  }
  async handle(request, response) {
    const requestToken = this.token;
    const origin = request.headers.origin, validOrigin = typeof origin === 'string' && extensionOrigin.test(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const reply = (status, value) => { response.writeHead(status, headers); response.end(JSON.stringify(value)); };
    const port = this.server?.address()?.port;
    if (!validOrigin || request.headers.host !== `127.0.0.1:${port}` || request.url !== '/youtube-session') return reply(403, { ok: false, error: 'にゃんぷれいの設定画面から接続してください' });
    headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin';
    if (request.method === 'OPTIONS') {
      headers['Access-Control-Allow-Methods'] = 'POST'; headers['Access-Control-Allow-Headers'] = 'content-type, x-nyan-account-code'; headers['Access-Control-Allow-Private-Network'] = 'true'; return reply(204, null);
    }
    const supplied = request.headers['x-nyan-account-code'];
    if (request.method !== 'POST' || !this.token || typeof supplied !== 'string' || supplied.length !== this.token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token)) || Date.now() >= this.state.expiresAt || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return reply(403, { ok: false, error: '接続コードが無効、または期限切れです' });
    if (this.busy) return reply(409, { ok: false, error: 'ログイン情報を処理中です' });
    this.busy = true;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 512 * 1024) { reply(413, { ok: false, error: 'ログイン情報が大きすぎます' }); request.destroy(); return; } chunks.push(chunk); }
      if (this.token !== requestToken || Date.now() >= this.state.expiresAt) return reply(403, { ok: false, error: '接続コードが取消または期限切れになりました' });
      const cookies = youtubeCookies(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      await this.importCookies(cookies);
      if (this.token !== requestToken) return reply(200, { ok: true, count: cookies.length });
      this.token = null; clearTimeout(this.timer);
      this.state = { status: 'received', receivedAt: Date.now(), count: cookies.length }; this.changed();
      reply(200, { ok: true, count: cookies.length });
      // The code can be used once. Keep the response alive while closing the listener.
      this.server?.close(); this.server = null;
    } catch (error) { reply(400, { ok: false, error: error instanceof SyntaxError ? 'ログイン情報の形式を確認してください' : error.message }); }
    finally { this.busy = false; }
  }
  close() { clearTimeout(this.timer); this.token = null; this.server?.close(); this.server = null; this.state = { status: 'idle' }; }
}
