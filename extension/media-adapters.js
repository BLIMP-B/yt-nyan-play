/* Site adapters run in Chrome's isolated content-script world. */
const NyanMedia = (() => {
  const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const hostIs = (host, domain) => host === domain || host.endsWith('.' + domain);
  const httpUrl = (value, base = location.href) => {
    try { const u = new URL(value, base); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u : null; } catch { return null; }
  };
  const services = [
    { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be'], post: u => /\/(watch|shorts\/|embed\/)/.test(u.pathname) && (u.pathname !== '/watch' || u.searchParams.has('v')) || hostIs(u.hostname, 'youtu.be') && u.pathname.length > 1, scope: 'ytd-reel-video-renderer, ytd-watch-flexy', text: 'h1 yt-formatted-string, h1, ytd-reel-player-header-renderer' },
    { id: 'niconico', name: 'ニコニコ動画', hosts: ['nicovideo.jp', 'nico.ms'], post: u => /\/watch\/(?:sm|so|nm)\d+/.test(u.pathname) || hostIs(u.hostname, 'nico.ms') && /\/(?:sm|so|nm)\d+/.test(u.pathname), scope: '[data-watch-root], main', text: 'h1, [data-testid="video-title"]' },
    { id: 'x', name: 'X', hosts: ['x.com', 'twitter.com'], post: u => /\/(?:[^/]+\/status|i\/status)\/\d+/.test(u.pathname), scope: 'article[data-testid="tweet"], article', text: '[data-testid="tweetText"]' },
    { id: 'instagram', name: 'Instagram', hosts: ['instagram.com'], post: u => /^\/(?:p|reel|reels)\/[^/]+/.test(u.pathname), scope: 'article, [role="dialog"]', text: 'h1, [data-testid="post-caption"], span[dir="auto"]' },
    { id: 'tiktok', name: 'TikTok', hosts: ['tiktok.com'], post: u => /\/@[^/]+\/video\/\d+/.test(u.pathname), scope: '[data-e2e="recommend-list-item-container"], [data-e2e="browse-video"], article', text: '[data-e2e="browse-video-desc"], [data-e2e="video-desc"]' },
    { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch'], post: u => /\/(?:reel\/|[^/]+\/videos\/|watch)/.test(u.pathname) || u.searchParams.has('v') || hostIs(u.hostname, 'fb.watch') && u.pathname.length > 1, scope: '[role="article"], article', text: '[data-ad-preview="message"], [data-ad-comet-preview="message"]' },
    { id: 'threads', name: 'Threads', hosts: ['threads.net', 'threads.com'], post: u => /\/@[^/]+\/post\/[^/]+/.test(u.pathname), scope: '[data-pressable-container="true"], article', text: '[data-testid="post-text"], [dir="auto"]' },
    { id: 'bluesky', name: 'Bluesky', hosts: ['bsky.app'], post: u => /\/profile\/[^/]+\/post\/[^/]+/.test(u.pathname), scope: '[data-testid="postThreadItem"], [data-testid^="feedItem"], article', text: '[data-testid="postText"], [data-testid="postTextContainer"]' },
    { id: 'mastodon', name: 'Mastodon', hosts: ['mastodon.social', 'mastodon.online', 'mstdn.jp', 'pawoo.net'], post: u => /\/@[^/]+\/\d+/.test(u.pathname) || /\/users\/[^/]+\/statuses\/\d+/.test(u.pathname), scope: '.status, .detailed-status, article', text: '.status__content, .status__content__text, .detailed-status__content' }
  ];
  function serviceFor(url = location.href) {
    const u = httpUrl(url); if (!u) return null;
    return services.find(s => s.hosts.some(h => hostIs(u.hostname, h))) || (document.querySelector('.status__content, .detailed-status__content') ? services.at(-1) : { id: 'html', name: '動画・音声', hosts: [], post: () => true, scope: 'article', text: 'h1, h2' });
  }
  function mediaSource(media) {
    const source = media.currentSrc || media.getAttribute('src') || [...media.querySelectorAll('source')].map(s => s.getAttribute('src')).find(Boolean);
    if (!source && media.readyState < 1) return null;
    if (source && !/^(blob:|https?:|data:video\/|data:audio\/|\/|\.\/|\.\.\/)/i.test(source)) {
      // Relative source filenames are permitted; reject active and unsupported schemes.
      if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
    }
    return source || null;
  }
  function canonicalPost(url, service) {
    const u = httpUrl(url); if (!u || !service.post(u)) return null;
    if (service.id !== 'html' && !service.hosts.some(h => hostIs(u.hostname, h)) && service.id !== 'mastodon') return null;
    if (service.id === 'youtube') {
      const id = hostIs(u.hostname, 'youtu.be') ? u.pathname.split('/')[1] : u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/)?.[1];
      if (!id || !/^[\w-]+$/.test(id)) return null;
      return `https://www.youtube.com/watch?v=${id}`;
    }
    if (service.id === 'niconico') return `https://www.nicovideo.jp/watch/${u.pathname.match(/(?:sm|so|nm)\d+/)?.[0]}`;
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|si$|feature$|fbclid$|s$|t$|start$|from$|time_continue$|share_)/i.test(key)) u.searchParams.delete(key);
    u.hash = '';
    if (['x', 'instagram', 'tiktok', 'threads', 'bluesky', 'mastodon'].includes(service.id)) {
      u.search = ''; if (service.id === 'x') u.pathname = u.pathname.replace(/\/(video|photo)\/\d+\/?$/, '');
    }
    return u.href;
  }
  function resolvePost(media, service) {
    const scope = media.closest(service.scope) || media.parentElement;
    const links = [...(scope?.querySelectorAll('a[href]') || [])];
    // A timestamp/permalink wins over quoted posts or author profile links.
    const primary = links.filter(a => a.querySelector('time') || a.matches('.status__relative-time, .detailed-status__datetime, [data-testid="timestamp"]'));
    for (const a of [...primary, ...links]) { const post = canonicalPost(a.href, service); if (post) return { url: post, scope }; }
    // On a timeline never fall back to a different post's URL.
    const own = canonicalPost(location.href, service);
    if (own && (!scope || !['x', 'bluesky', 'mastodon'].includes(service.id) || !scope.querySelector('a[href]') || location.pathname.includes('/status/') || location.pathname.includes('/post/') || /\/@[^/]+\/\d+/.test(location.pathname))) return { url: own, scope };
    return { url: null, scope };
  }
  function titleFor(scope, service, media) {
    const text = cleanText(scope?.querySelector(service.text)?.textContent);
    if (text) return text;
    const label = cleanText(media.getAttribute('aria-label') || media.getAttribute('title'));
    if (label) return label;
    // Global metadata is suitable for a single permalink, not each timeline item.
    if (canonicalPost(location.href, service)) return cleanText(document.querySelector('meta[property="og:title"], meta[name="title"]')?.content || document.title.replace(/\s[-|]\s(?:YouTube|ニコニコ動画).*$/, '')) || `${service.name}の${media.tagName === 'AUDIO' ? '音声' : '動画'}`;
    return `${service.name}の${media.tagName === 'AUDIO' ? '音声' : '動画'}`;
  }
  function detect() {
    const service = serviceFor(); if (!service) return [];
    const result = [];
    for (const media of document.querySelectorAll('video, audio')) {
      if (media.closest('#nyan-play-share-modal, #nyan-play-controls') || media.closest('[aria-hidden="true"], [hidden]')) continue;
      const source = mediaSource(media); if (!source && media.readyState < 1) continue;
      const { url, scope } = resolvePost(media, service); if (!url) continue;
      if (service.id === 'youtube' && (document.querySelector('.ad-showing, .ad-interrupting') || scope?.querySelector('.ad-showing'))) continue;
      result.push({ media, url, service: service.id, serviceName: service.name, title: titleFor(scope, service, media), kind: media.tagName === 'AUDIO' ? '音声' : '動画', source });
    }
    return result;
  }
  function sendUrl(candidate, { mode = 'play', time = 'start' } = {}) {
    const u = new URL(candidate.url);
    for (const key of ['t', 'start', 'from', 'time_continue']) u.searchParams.delete(key);
    u.hash = '';
    const seconds = time === 'current' ? Math.max(0, Math.floor(Number(candidate.media.currentTime) || 0)) : 0;
    if (candidate.service === 'youtube' && mode !== 'play') {
      const id = u.searchParams.get('v'); return `https://youtu.be/${id}${seconds ? '?t=' + seconds : ''}`;
    }
    if (seconds) u.searchParams.set(candidate.service === 'niconico' ? 'from' : 't', String(seconds));
    return u.href;
  }
  function content(candidate, options) {
    const marker = { play: '再生', infinite: '無限', direct: '直接' }[options.mode] || '再生';
    const title = cleanText(candidate.title).replace(/[*`\[\]<>]/g, '');
    return `${sendUrl(candidate, options)}${marker}\n**【${title}】**`;
  }
  return { detect, content, sendUrl, serviceFor, canonicalPost, mediaSource, cleanText };
})();
