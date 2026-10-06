export const MEDIA_EXTRACTOR = { version: '2026.08.19', url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' };
const services = [
  ['youtube', ['youtube.com', 'youtu.be'], ['googlevideo.com']],
  ['niconico', ['nicovideo.jp', 'nico.ms', 'niconico.com'], ['nicovideo.jp', 'dmc.nico']],
  ['x', ['x.com', 'twitter.com'], ['twimg.com']],
  ['instagram', ['instagram.com'], ['cdninstagram.com', 'fbcdn.net']],
  ['tiktok', ['tiktok.com'], ['tiktokcdn.com', 'tiktokv.com', 'byteoversea.com', 'ibytedtos.com', 'muscdn.com']],
  ['facebook', ['facebook.com', 'fb.watch'], ['fbcdn.net', 'fbsbx.com']],
  ['threads', ['threads.com', 'threads.net'], ['cdninstagram.com', 'fbcdn.net']],
  ['bluesky', ['bsky.app'], ['bsky.app', 'bsky.social', 'bsky.network']],
];
const matches = (host, roots) => roots.some(r => host === r || host.endsWith('.' + r));
export function streamingService(url) {
  const u = new URL(url), service = services.find(([, hosts]) => matches(u.hostname, hosts));
  if (service?.[0] === 'youtube' && !/^[a-zA-Z0-9_-]{11}$/.test(u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).at(-1) || '')) return null;
  return service || (/\/(?:@[^/]+\/\d+|users\/[^/]+\/statuses\/\d+)/.test(u.pathname) ? ['mastodon', [u.hostname], [u.hostname]] : null);
}
export function selectStream(info, source) {
  const service = streamingService(source); if (!service || !info || info._type === 'playlist' || info.is_live) return null;
  const formats = Array.isArray(info.formats) ? info.formats : [info];
  const allowed = formats.filter(f => {
    try {
      const u = new URL(f.url);
      return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && matches(u.hostname, [...service[1], ...service[2]]) && !f.has_drm && f.acodec && f.acodec !== 'none' && !/^rtmp|^dash_segments/.test(f.protocol || '');
    } catch { return false; }
  });
  const audio = allowed.filter(f => f.vcodec === 'none').sort((a,b) => (a.abr || a.tbr || 1e9) - (b.abr || b.tbr || 1e9));
  const muxed = allowed.filter(f => f.vcodec && f.vcodec !== 'none').sort((a,b) => (a.height || 1e9) - (b.height || 1e9) || (a.tbr || 1e9) - (b.tbr || 1e9));
  const format = audio[0] || muxed[0]; if (!format) return null;
  const headers = {};
  for (const [key, value] of Object.entries(format.http_headers || info.http_headers || {})) if (/^(User-Agent|Referer|Origin|Cookie|Authorization)$/i.test(key) && typeof value === 'string' && value.length <= 32768 && !/[\r\n\x00]/.test(value)) headers[key] = value;
  return { url: format.url, headers, audioOnly: Boolean(audio.length), service: service[0], height: format.height || null, bitrate: format.abr || format.tbr || null, title: info.title || '', format: String(format.format_id || ''), duration: Number.isFinite(info.duration) && info.duration > 0 ? info.duration : null };
}
