import { validateMediaUrl } from './config.mjs';
import { mediaAuthHosts } from './media-accounts.mjs';
export function validateMediaNavigation(raw, allowedHosts, playbackUrl) {
  const url = new URL(raw);
  if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && mediaAuthHosts(playbackUrl).includes(url.hostname)) return url.href;
  return validateMediaUrl(raw, allowedHosts);
}
