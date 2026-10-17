import { validateMediaUrl } from './config.mjs';
import { mediaAuthHosts } from './media-accounts.mjs';
export function validateMediaNavigation(raw, allowedHosts, playbackUrl) {
  const url = new URL(raw);
  // A share link approved by the user must be able to reach its official
  // SoundCloud page, even when only on.soundcloud.com was previously allowed.
  if (new URL(playbackUrl).hostname === 'on.soundcloud.com' && (url.hostname === 'soundcloud.com' || url.hostname.endsWith('.soundcloud.com'))) {
    validateMediaUrl(playbackUrl, allowedHosts);
    return validateMediaUrl(raw, ['soundcloud.com']);
  }
  if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && mediaAuthHosts(playbackUrl).includes(url.hostname)) return url.href;
  return validateMediaUrl(raw, allowedHosts);
}
