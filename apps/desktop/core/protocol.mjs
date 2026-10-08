import { validateMediaUrl } from './config.mjs';

const SERVICES = [
  [['youtube.com', 'youtu.be'], 'ゆーちゅーぶ', 'YouTube'],
  [['nicovideo.jp', 'niconico.com', 'nico.ms'], 'にこにこどうが', 'ニコニコ動画'],
  [['x.com'], 'えっくす', 'X'], [['twitter.com'], 'ついったー', 'Twitter'],
  [['instagram.com'], 'いんすたぐらむ', 'Instagram'], [['tiktok.com'], 'てぃっくとっく', 'TikTok'],
  [['facebook.com', 'fb.watch'], 'ふぇいすぶっく', 'Facebook'],
  [['threads.net', 'threads.com'], 'すれっず', 'Threads'], [['bsky.app'], 'ぶるーすかい', 'Bluesky'],
  [['cdn.discordapp.com', 'media.discordapp.net'], 'でぃすこーどのメディア', 'Discord'],
];
export function mediaServiceName(url) {
  const host = new URL(url).hostname.toLowerCase();
  return SERVICES.find(([hosts]) => hosts.some(h => host === h || host.endsWith(`.${h}`)))?.[2] || 'メディア';
}
export function mediaAnnouncement(url) {
  const host = new URL(url).hostname.toLowerCase();
  const service = SERVICES.find(([hosts]) => hosts.some(h => host === h || host.endsWith(`.${h}`)))?.[1] || 'メディア';
  return `${service}を再生します`;
}
export function urlStartSeconds(url) {
  const u = new URL(url); const hash = new URLSearchParams(u.hash.slice(1));
  const time = u.searchParams.get('t') || u.searchParams.get('start') || u.searchParams.get('from') || u.searchParams.get('time_continue') || hash.get('t') || hash.get('start') || '0';
  return /^\d+(?:\.\d+)?$/.test(time) ? Number(time) : durationSeconds(time);
}

export function parseMediaCommand(content, config) {
  const text = String(content || '').trim();
  let command;
  if (text.startsWith('NYANPLAY/1 ')) {
    let data; try { data = JSON.parse(text.slice(11)); } catch { throw new Error('にゃんぷれい命令のJSONを確認してください'); }
    if (data.version !== 1 || data.type !== 'play') throw new Error('未対応のにゃんぷれい命令です');
    const url = data.mediaUrl || data.pageUrl;
    command = { url, title: data.title, mode: data.mode || (data.loop === true ? 'full' : 'preview'), startSeconds: data.startSeconds ?? urlStartSeconds(url) };
  } else {
    const m = text.match(/^(?:<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>]+?))\s*(再生|無限|直接)(?:\r?\n\*\*【([\s\S]*?)】\*\*)?$/);
    if (!m) return null;
    const url = m[1] || m[2], u = new URL(url);
    command = { url, title: m[4] || u.hostname, mode: { 再生: 'preview', 無限: 'full', 直接: 'direct' }[m[3]], startSeconds: urlStartSeconds(url) };
  }
  if (!['preview', 'full', 'direct'].includes(command.mode) || typeof command.url !== 'string' || !Number.isFinite(command.startSeconds) || command.startSeconds < 0 || command.startSeconds > 86400) throw new Error('再生URL・開始位置・方式を確認してください');
  return { ...command, url: validateMediaUrl(command.url, config.media.allowedHosts), title: String(command.title || '').slice(0, 250) };
}
function durationSeconds(text) {
  const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}
export function parseBotCommand(content, prefix) {
  const text = String(content || '').trim();
  if (!text.startsWith(`${prefix} `) && text !== prefix) return null;
  const [name = 'help', ...args] = text.slice(prefix.length).trim().split(/\s+/);
  return { name: (name || 'help').toLowerCase(), args };
}
