import { validateMediaUrl } from './config.mjs';

export function parseMediaCommand(content, config) {
  const text = String(content || '').trim();
  let command;
  if (text.startsWith('NYANPLAY/1 ')) {
    let data; try { data = JSON.parse(text.slice(11)); } catch { throw new Error('にゃんぷれい命令のJSONを確認してください'); }
    if (data.version !== 1 || data.type !== 'play') throw new Error('未対応のにゃんぷれい命令です');
    command = { url: data.mediaUrl || data.pageUrl, title: data.title, loop: data.loop === true, startSeconds: data.startSeconds ?? 0 };
  } else {
    const m = text.match(/^(https?:\/\/\S+?)(再生|無限)(?:\r?\n\*\*【([\s\S]*?)】\*\*)?$/);
    if (!m) return null;
    const u = new URL(m[1]);
    const time = u.searchParams.get('t') || u.searchParams.get('start') || '0';
    const seconds = /^\d+$/.test(time) ? Number(time) : durationSeconds(time);
    command = { url: m[1], title: m[3] || u.hostname, loop: m[2] === '無限', startSeconds: seconds };
  }
  if (typeof command.url !== 'string' || !Number.isFinite(command.startSeconds) || command.startSeconds < 0 || command.startSeconds > 86400) throw new Error('再生URL・開始位置を確認してください');
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
