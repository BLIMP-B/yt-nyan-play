import { validateMediaUrl } from '../core/config.mjs';
import { metadataFromHtml, titleText } from '../core/media-title.mjs';

// Bounded, credential-scoped page reads. Do not execute HTML or follow an
// unvalidated redirect to an internal address or an unrelated host.
export async function fetchTitleMetadata(url, allowedHosts, fetcher, signal) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const read = async raw => {
    let next = validateMediaUrl(raw, allowedHosts);
    for (let n = 0; n < 4; n++) {
      const response = await fetcher(next, { signal: timeout, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) return ''; next = validateMediaUrl(new URL(location, next).href, allowedHosts); continue; }
      if (!response.ok || !/text\/html|json/iu.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); return ''; }
      const reader = response.body?.getReader(); if (!reader) return '';
      const chunks = []; let count = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; count += value.length; if (count > 512 * 1024) break; chunks.push(value); } }
      finally { await reader.cancel(); }
      return Buffer.concat(chunks).toString('utf8');
    }
    return '';
  };
  const original = new URL(url);
  if (/(^|\.)youtube\.com$|^youtu\.be$/u.test(original.hostname)) {
    try {
      const data = JSON.parse(await read('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url)));
      if (titleText(data.title)) return { title: titleText(data.title), author: titleText(data.author_name), body: '' };
    } catch { timeout.throwIfAborted(); }
  }
  return metadataFromHtml(await read(url));
}
