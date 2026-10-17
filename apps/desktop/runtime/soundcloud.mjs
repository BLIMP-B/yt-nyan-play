import { validateMediaUrl } from '../core/config.mjs';
import { validateMediaNavigation } from '../core/media-navigation.mjs';

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
