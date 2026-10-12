// Called only from the extension's options page, after an explicit permission request.
const NyanAccountLink = (() => {
  function parse(code) {
    const match = /^nyan-youtube:(\d{1,5}):([a-f0-9]{64})$/.exec(String(code || '').trim());
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('にゃんとーくの「再生アカウント」から接続コードをコピーしてください。');
    return { url: `http://127.0.0.1:${Number(match[1])}/youtube-session`, token: match[2] };
  }
  async function transfer(code) {
    const target = parse(code);
    if (!await chrome.permissions.contains({ permissions: ['cookies'], origins: ['http://127.0.0.1/*'] })) throw new Error('YouTubeのログイン引き継ぎを許可してください。');
    const cookies = (await chrome.cookies.getAll({ domain: 'youtube.com' })).filter(c => !c.partitionKey).map(c => {
      const value = { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, hostOnly: c.hostOnly, sameSite: c.sameSite };
      if (c.expirationDate !== undefined) value.expirationDate = c.expirationDate;
      return value;
    });
    if (!cookies.some(c => ['LOGIN_INFO', 'SID', '__Secure-1PSID', '__Secure-3PSID'].includes(c.name) && c.value)) throw new Error('このChrome / EdgeでYouTubeへログインしてから、もう一度引き継いでください。');
    let response;
    try { response = await fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nyan-Account-Code': target.token }, body: JSON.stringify({ version: 1, cookies }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('同じPCでにゃんとーくを起動し、接続コードを再発行してください。'); }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'ログイン情報を引き継げませんでした。');
    return { ok: true, count: result.count };
  }
  return { parse, transfer };
})();
