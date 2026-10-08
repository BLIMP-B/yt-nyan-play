import { BrowserWindow } from 'electron';
import { playbackSession, guardMediaWindow } from './media-session.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import { APP_ICON } from './app-icon.mjs';
export async function searchHourlyBgm(nouns, getConfig, signal) {
  if (!Array.isArray(nouns) || nouns.length !== 2 || nouns.some(n => typeof n !== 'string' || n.length > 40)) throw new Error('BGM検索には名詞2語が必要です');
  const query = nouns.join(' ') + ' フリーBGM', url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
  const window = new BrowserWindow({ show: false, width: 900, height: 600, icon: APP_ICON, webPreferences: { session: playbackSession(), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  guardMediaWindow(window, url, getConfig); const abort = () => { if (!window.isDestroyed()) window.destroy(); }; signal?.addEventListener('abort', abort, { once: true });
  let timeout;
  try {
    signal?.throwIfAborted();
    await Promise.race([window.loadURL(url), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('YouTubeのBGM検索がタイムアウトしました')), 15000); })]); clearTimeout(timeout);
    for (let i = 0; i < 20; i++) {
      signal?.throwIfAborted();
      const results = await window.webContents.executeJavaScript(`(() => {
        const found = [], seen = new Set(), stack = [window.ytInitialData];
        while (stack.length && seen.size < 50000) {
          const node = stack.pop(); if (!node || typeof node !== 'object' || seen.has(node)) continue; seen.add(node);
          if (node.adSlotRenderer || node.promotedSparklesWebRenderer || node.promotedVideoRenderer) continue;
          const v = node.videoRenderer;
          if (v && /^[a-zA-Z0-9_-]{11}$/.test(v.videoId) && v.lengthText) found.push({ id: v.videoId, title: (v.title?.runs || []).map(r => r.text).join('').slice(0,200) });
          for (const value of Object.values(node).reverse()) if (value && typeof value === 'object') stack.push(value);
        }
        return found.slice(0,5);
      })()`, true);
      if (results.length) return { url: 'https://www.youtube.com/watch?v=' + results[0].id, title: results[0].title, query };
      await wait(250, undefined, { signal });
    }
    throw new Error('YouTubeの検索結果に再生可能な動画がありません。再生アカウントのログイン状態を確認してください');
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); abort(); }
}
