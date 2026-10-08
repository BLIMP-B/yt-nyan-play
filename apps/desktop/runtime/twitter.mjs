import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XApi, tweetSpeech, protectedReadable } from '../core/twitter.mjs';
import { writeAtomic } from '../core/store.mjs';

export class TwitterSource extends EventEmitter {
  constructor(directory, getConfig, userVault, appVault, handlers, fetcher = fetch) {
    super(); this.getConfig = getConfig; this.userVault = userVault; this.appVault = appVault; this.handlers = handlers; this.fetcher = fetcher; this.api = new XApi(fetcher); this.file = join(directory, 'twitter-state.json');
    this.since = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; this.auth = null; this.timer = null; this.callback = null; this.callbackClosing = Promise.resolve(); this.polling = false; this.running = false; this.error = ''; this.accounts = []; this.generation = 0;
  }
  owner() { return this.auth && this.auth.expiresAt > Date.now() ? this.auth.owner : null; }
  snapshot() { return { running: this.running, login: this.owner(), tokenSaved: this.userVault.hasToken(), appTokenSaved: this.appVault.hasToken(), accounts: this.accounts, error: this.error, loginWaiting: Boolean(this.callback), loginProcessing: Boolean(this.callback?.claimed), callbackUrl: `http://127.0.0.1:${this.getConfig().twitter.callbackPort}/callback` }; }
  async restore() { if (this.userVault.hasToken()) { try { this.auth = JSON.parse(this.userVault.read()); await this.userSession(); } catch { this.auth = null; } } this.emit('change'); }
  async tokenRequest(parameters, signal) {
    const r = await this.fetcher('https://api.x.com/2/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
    if (!r.ok) throw new Error(`Xログインの認証を確認してください (HTTP ${r.status})`); return r.json();
  }
  async userSession() {
    if (!this.auth) return null;
    if (this.auth.expiresAt <= Date.now() + 30000) {
      if (!this.auth.refreshToken) { this.auth = null; this.emit('change'); return null; }
      const previous = this.auth, c = this.getConfig().twitter; const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: c.clientId });
      if (this.auth !== previous) return null;
      this.auth = { ...this.auth, accessToken: next.access_token, refreshToken: next.refresh_token || this.auth.refreshToken, expiresAt: Date.now() + next.expires_in * 1000 }; this.userVault.save(JSON.stringify(this.auth));
    }
    return this.auth;
  }
  closeLogin(attempt = this.callback, force = true) {
    if (!attempt) return this.callbackClosing;
    if (attempt.closing) return attempt.closing;
    clearTimeout(attempt.timeout); attempt.controller.abort();
    if (this.callback === attempt) { this.callback = null; this.emit('change'); }
    attempt.closing = new Promise(resolve => { attempt.server.close(() => resolve()); if (force) attempt.server.closeAllConnections(); });
    this.callbackClosing = Promise.all([this.callbackClosing, attempt.closing]).then(() => {});
    return attempt.closing;
  }
  cancelLogin() { return this.closeLogin(); }
  async login() {
    const c = { ...this.getConfig().twitter }; if (!c.clientId) throw new Error('X Developer PortalのOAuth 2.0 Client IDを設定してください');
    if (this.callback?.clientId === c.clientId && this.callback.port === c.callbackPort) return this.callback.ready;
    if (this.callback) this.closeLogin();
    const previousClose = this.callbackClosing, verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const redirect = `http://127.0.0.1:${c.callbackPort}/callback`, attempt = { clientId: c.clientId, port: c.callbackPort, controller: new AbortController(), claimed: false };
    const active = () => this.callback === attempt && !attempt.controller.signal.aborted;
    const server = attempt.server = createServer(async (request, response) => {
      let url;
      try { url = new URL(request.url, redirect); } catch { response.writeHead(400).end('Invalid callback'); return; }
      if (request.method !== 'GET' || url.origin !== new URL(redirect).origin || url.pathname !== '/callback' || url.searchParams.get('state') !== state || !active()) { response.writeHead(400).end('Invalid callback'); return; }
      if (attempt.claimed) { response.writeHead(400).end('Callback already used'); return; } attempt.claimed = true; this.emit('change');
      try {
        const code = url.searchParams.get('code'); if (!code) throw new Error('Xへのログインが取消されました');
        const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: c.clientId }, attempt.controller.signal);
        if (!active()) return;
        const me = await this.api.me(tokens.access_token, attempt.controller.signal); if (!active()) return;
        this.auth = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, owner: me.data }; this.userVault.save(JSON.stringify(this.auth)); this.error = '';
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ログインしました。この画面を閉じて、にゃんとーくへ戻ってください。');
      } catch (e) { if (active()) this.error = e.message; if (!response.destroyed) response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('ログインを完了できません。アプリの状態を確認してください。'); }
      finally {
        // Finish writing the browser response before closing its connection.
        response.once('finish', () => server.closeIdleConnections());
        if (response.writableFinished) server.closeIdleConnections();
        void this.closeLogin(attempt, response.destroyed);
      }
    });
    server.on('error', e => { if (server.listening && active()) { this.error = `Xログインの待受けエラー: ${e.code}`; void this.closeLogin(attempt); } });
    this.callback = attempt; this.error = '';
    attempt.ready = (async () => {
      await previousClose; attempt.controller.signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const cleanup = () => { server.removeListener('error', failed); server.removeListener('listening', listening); attempt.controller.signal.removeEventListener('abort', cancelled); };
        const failed = e => { cleanup(); reject(e); };
        const listening = () => { cleanup(); resolve(); };
        const cancelled = () => { cleanup(); reject(attempt.controller.signal.reason); };
        attempt.controller.signal.addEventListener('abort', cancelled, { once: true });
        server.once('error', failed); server.once('listening', listening); server.listen({ port: c.callbackPort, host: '127.0.0.1', signal: attempt.controller.signal });
      });
      if (!active()) { await this.closeLogin(attempt); throw new Error('Xログインの待機を中止しました'); }
      attempt.timeout = setTimeout(() => { if (active()) { this.error = 'Xログインがタイムアウトしました。ログイン画面を開き直してください'; void this.closeLogin(attempt); } }, 180000); attempt.timeout.unref();
      const query = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: redirect, scope: 'tweet.read users.read offline.access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      return `https://x.com/i/oauth2/authorize?${query}`;
    })().catch(async e => {
      if (e.name === 'AbortError') { await this.closeLogin(attempt); throw e; }
      const message = e.code === 'EADDRINUSE' ? `Xログイン用ポート ${c.callbackPort} は他の待受けで使用中です。Xの設定で空きポートに変更し、X Developer PortalのCallback URLも ${redirect} のポートを変更して登録してください` : `Xログインの待受けを開始できません: ${e.message}`;
      if (active()) this.error = message; await this.closeLogin(attempt); throw Object.assign(new Error(message), { code: e.code });
    });
    this.emit('change');
    return attempt.ready;
  }
  logout() { this.generation++; void this.closeLogin(); this.auth = null; this.userVault.clear(); this.handlers.logout(); this.emit('change'); }
  start() { if (this.running) return; this.running = true; this.generation++; void this.poll(); this.emit('change'); }
  stop() { this.running = false; this.generation++; clearTimeout(this.timer); this.timer = null; this.emit('change'); }
  async poll() {
    if (!this.running || this.polling) return; this.polling = true; const generation = this.generation;
    try {
      const c = structuredClone(this.getConfig().twitter); const session = await this.userSession(); const token = session?.accessToken || this.appVault.read(); const owner = this.owner(); const accounts = [];
      for (const username of c.accounts) {
        if (!this.running || this.generation !== generation) break;
        const profile = (await this.api.user(username, token)).data; if (!profile) continue;
        if (!protectedReadable(profile, owner)) { accounts.push({ username, status: '非公開: 本人のログインが必要' }); continue; }
        let next = '', newest = this.since[profile.id], pending = [], pages = 0;
        do {
          const result = await this.api.tweets(profile.id, this.since[profile.id], token, c.readReplies, next);
          for (const tweet of result.data || []) { if (!newest || BigInt(tweet.id) > BigInt(newest)) newest = tweet.id; const text = tweetSpeech(tweet, result.includes, c); if (text) pending.push({ id: tweet.id, text }); }
          next = result.meta?.next_token || ''; pages++;
        } while (next && pages < 20 && this.running && generation === this.generation);
        // Never advance the cursor past an unconsumed page.
        if (next) throw new Error('Xの新着投稿が多すぎます。対象アカウントや取得間隔を調整してください');
        if (!this.running || generation !== this.generation) break;
        if (this.since[profile.id] || c.readExisting) for (const tweet of pending.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) this.handlers.speech({ text: `${profile.name}、${tweet.text}`, guildId: c.guildId, userId: '', source: `@${username}`, twitterId: tweet.id, privateOwnerId: profile.protected ? owner.id : '' });
        if (newest) this.since[profile.id] = newest; writeAtomic(this.file, this.since); accounts.push({ username, status: '取得済み' });
      }
      this.accounts = accounts; this.error = '';
    } catch (e) { this.error = e.message; if (e.status === 402) this.stop(); this.handlers.log('error', e.message); }
    finally { this.polling = false; this.emit('change'); if (this.running) this.timer = setTimeout(() => this.poll(), this.getConfig().twitter.pollSeconds * 1000); }
  }
  close() { this.stop(); void this.closeLogin(); }
}
