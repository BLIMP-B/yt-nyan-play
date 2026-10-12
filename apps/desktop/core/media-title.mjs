export function titleText(value) {
  return String(value || '').replace(/https?:\/\/[^\s<>]+/gu, '').replace(/<[^>]+>/gu, '')
    .replace(/[*`#]/gu, '').replace(/[【】]/gu, '').replace(/[\x00-\x1f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500);
}
export function messageTitle(value) {
  return titleText(String(value || '').replace(/(?:^|\s)(?:再生|無限|直接)(?=\s|$)/gu, ' ')
    .replace(/(?:^|\s)(?:mode|startSeconds|start|t|loop|version|type)\s*[=＝:]\s*[^\s]+/giu, ' '));
}
export function titleChoice(payload, metadata = {}, pending = false) {
  const given = titleText(payload.title);
  let host; try { host = new URL(payload.url).hostname; } catch {}
  if (given && given !== host) return { text: given, source: 'message' };
  const youtubeOrNico = /(^|\.)(youtube\.com|youtu\.be|nicovideo\.jp|nico\.ms|niconico\.com)$/u.test(host || '');
  const generic = new Set([host, 'YouTube', 'ニコニコ動画', 'X', 'Instagram', 'TikTok', 'Facebook', 'Threads', 'Bluesky']);
  const candidate = titleText(metadata.title), title = generic.has(candidate) ? '' : candidate, body = titleText(metadata.body), author = titleText(metadata.author);
  if (youtubeOrNico && title) return { text: title, source: 'title' };
  if (!youtubeOrNico && (body || title)) return { text: body || title, source: body ? 'body' : 'title' };
  if (!pending && (author || titleText(payload.source))) return { text: author || titleText(payload.source), source: 'author' };
  return { text: 'メディアを取得中です', source: 'pending' };
}
const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
export function htmlText(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/giu, (all, code) => {
    if (code[0] !== '#') return entities[code.toLowerCase()] || all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
export function metadataFromHtml(html) {
  const tags = new Map();
  for (const meta of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = new Map([...meta[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)].map(m => [m[1].toLowerCase(), htmlText(m[2] ?? m[3] ?? m[4])]));
    const key = attrs.get('property') || attrs.get('name'); if (key && attrs.has('content')) tags.set(key.toLowerCase(), attrs.get('content'));
  }
  const title = tags.get('og:title') || tags.get('twitter:title') || htmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]);
  const author = tags.get('author') || tags.get('article:author') || tags.get('twitter:creator') || '';
  const main = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/iu)?.[1] || '';
  const body = tags.get('og:description') || tags.get('twitter:description') || tags.get('description') || htmlText(main.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/giu, '').replace(/<[^>]*>/gu, ' '));
  return { title: titleText(title), body: titleText(body), author: titleText(author) };
}
export function browserMetadataScript() {
  return `(() => { const meta = key => document.querySelector('meta[property="'+key+'"],meta[name="'+key+'"]')?.content || '';
    const player = window.ytInitialPlayerResponse?.videoDetails;
    return {title: player?.title || meta('og:title') || document.querySelector('h1')?.textContent || document.title,
      body: meta('og:description') || meta('description') || document.querySelector('article,[data-testid="tweetText"],main')?.textContent || '',
      author: player?.author || meta('author') || meta('twitter:creator')}; })()`;
}
