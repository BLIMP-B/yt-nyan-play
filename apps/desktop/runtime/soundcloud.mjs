import { validateMediaUrl } from '../core/config.mjs';
import { validateMediaNavigation } from '../core/media-navigation.mjs';

// Chromium fetch rejects manual redirects instead of exposing a 3xx Response.
// Read ClientRequest's redirect event without following an unvalidated target.
export function nativeRedirectResponse(requestFactory, url, { signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = requestFactory({ url, method: 'GET', redirect: 'manual' });
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(response);
      request.abort();
    };
    const abort = () => finish(signal.reason);
    // Keep the error listener after abort: cancellation can emit an error later.
    request.on('error', error => finish(error));
    // ClientRequest is a Writable: 'close' can follow end() before Chromium
    // supplies the response. Network errors and the abort signal end the wait.
    request.once('redirect', (status, _method, destination) => finish(null, new Response(null, { status, headers: { location: destination } })));
    request.once('response', response => { response.on('error', () => {}); finish(null, new Response(null, { status: response.statusCode })); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else request.end();
  });
}

// Expand HTTP share links before opening Chromium, which can otherwise follow
// a mobile app transition and reject it with an unhelpful ERR_FAILED.
export async function resolveSoundCloudShare(raw, allowedHosts, fetcher, signal) {
  const source = validateMediaUrl(raw, allowedHosts);
  if (new URL(source).hostname !== 'on.soundcloud.com') return source;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  let next = source;
  for (let count = 0; count < 5; count++) {
    requestSignal.throwIfAborted();
    const response = await fetcher(next, { redirect: 'manual', signal: requestSignal });
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('SoundCloud短縮リンクの転送先がありません');
      const target = new URL(location, next);
      if (target.hostname !== 'soundcloud.com' && !target.hostname.endsWith('.soundcloud.com')) throw new Error('SoundCloudの公式曲ページへ転送できません');
      next = validateMediaNavigation(target.href, allowedHosts, source);
      if (target.hostname !== 'on.soundcloud.com') return next;
      continue;
    }
    if (!response.ok) throw new Error(`SoundCloud短縮リンクを確認できません（HTTP ${response.status}）。共有し直したリンクか曲ページのURLを指定してください`);
    return next;
  }
  throw new Error('SoundCloud短縮リンクの転送が多すぎます');
}
