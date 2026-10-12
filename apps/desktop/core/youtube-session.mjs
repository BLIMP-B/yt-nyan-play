const hosts = domain => typeof domain === 'string' && /^(?:\.)?(?:[a-z0-9-]+\.)*youtube\.com$/i.test(domain);
const authNames = new Set(['LOGIN_INFO', 'SID', '__Secure-1PSID', '__Secure-3PSID']);

// Only the YouTube web session is accepted; Google and other services stay in Chrome.
export function youtubeCookies(input, now = Date.now() / 1000) {
  if (!input || input.version !== 1 || !Array.isArray(input.cookies) || !input.cookies.length || input.cookies.length > 500) throw new Error('YouTubeのログイン情報を確認してください');
  const seen = new Set(), result = [];
  for (const c of input.cookies) {
    if (!c || !hosts(c.domain) || typeof c.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(c.name) || typeof c.value !== 'string' || c.value.length > 16384 || /[\x00-\x1f\x7f]/.test(c.value) || typeof c.path !== 'string' || !c.path.startsWith('/') || c.path.length > 2048 || /[\x00-\x1f\x7f]/.test(c.path) || typeof c.secure !== 'boolean' || typeof c.httpOnly !== 'boolean' || typeof c.hostOnly !== 'boolean' || !['unspecified', 'no_restriction', 'lax', 'strict'].includes(c.sameSite) || c.partitionKey) throw new Error('YouTube以外、または対応しないログイン情報が含まれています');
    if (c.expirationDate !== undefined && (!Number.isFinite(c.expirationDate) || c.expirationDate > 1e12)) throw new Error('ログイン情報の有効期限を確認してください');
    if (c.expirationDate !== undefined && c.expirationDate <= now) continue;
    const key = `${c.domain.toLowerCase()}\n${c.path}\n${c.name}`;
    if (seen.has(key)) throw new Error('ログイン情報が重複しています');
    seen.add(key);
    const cookie = { url: `https://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
    if (!c.hostOnly) cookie.domain = c.domain;
    if (c.expirationDate !== undefined) cookie.expirationDate = c.expirationDate;
    result.push(cookie);
  }
  if (!result.some(c => authNames.has(c.name) && c.value)) throw new Error('このブラウザでYouTubeへログインしてから、もう一度引き継いでください');
  return result;
}
export function isYoutubeCookie(cookie) { return hosts(cookie.domain); }
export function cookieDetails(cookie) {
  const result = { url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite };
  if (!cookie.hostOnly) result.domain = cookie.domain;
  if (cookie.expirationDate !== undefined) result.expirationDate = cookie.expirationDate;
  return result;
}
