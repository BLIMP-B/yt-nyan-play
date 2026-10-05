import { validateMediaUrl } from './config.mjs';
const googleAuth = new Set(['accounts.google.com', 'consent.google.com', 'consent.youtube.com']);
export function validateMediaNavigation(raw, allowedHosts, playbackUrl) {
  const url = new URL(raw), source = new URL(playbackUrl);
  if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && googleAuth.has(url.hostname) && (source.hostname === 'youtu.be' || source.hostname === 'youtube.com' || source.hostname.endsWith('.youtube.com'))) return url.href;
  return validateMediaUrl(raw, allowedHosts);
}
