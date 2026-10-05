import { isIP } from 'node:net';

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  desktop: { autoStart: false, startMinimized: false, closeToTray: true, notifications: true },
  bot: {
    autoConnect: false, prefix: '!nyan', includeBots: false, includeWebhooks: true,
    allowedWebhookIds: [], controlUserIds: [], autoJoin: false, autoLeave: true,
    announceJoinLeave: false, readDMs: false, bindings: [],
  },
  speech: {
    enabled: true, provider: 'voicevox', engineUrl: 'http://127.0.0.1:50021',
    engineExecutable: '', styleId: 3, speed: 1, pitch: 0, intonation: 1,
    volume: 0.8, output: 'local', outputDevice: '', maxChars: 500,
    readNames: true, readUrls: false, readEmoji: false, readAttachments: true,
    readSpoilers: false, spoilerText: 'ネタバレ', readCode: false,
    messageTemplate: '$nickname$、$text$', joinTemplate: '$nickname$が$channel$に参加しました',
    leaveTemplate: '$nickname$が$channel$から退出しました',
    moveTemplate: '$nickname$が$channel-prev$から$channel-next$へ移動しました',
    ignoredUserIds: [], allowedUserIds: [], ignoredRoleIds: [], blockedWords: [],
    profiles: [], emojiReadings: [], soundClips: [],
    bouyomiHost: '127.0.0.1', bouyomiPort: 50001, bouyomiHttpPort: 50080, bouyomiCommunication: 'tcp', bouyomiVoice: 0, bouyomiTone: -1,
  },
  media: {
    enabled: true, volume: 0.7, ducking: 0.35, showWindow: true,
    output: 'local', maxMinutes: 120,
    allowedHosts: ['youtube.com', 'youtu.be', 'nicovideo.jp', 'niconico.com', 'x.com',
      'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'fb.watch',
      'threads.net', 'threads.com', 'bsky.app', 'cdn.discordapp.com', 'media.discordapp.net'],
  },
  dictionary: [],
};

function mergeKnown(base, patch) {
  const result = structuredClone(base);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return result;
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(patch, key)) continue;
    if (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = mergeKnown(base[key], patch[key]);
    } else result[key] = structuredClone(patch[key]);
  }
  return result;
}

const fail = (label) => { throw new Error(`設定を確認してください: ${label}`); };
const number = (value, min, max, label, integer = false) => {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(label);
};
const strings = (value, label, ids = false) => {
  if (!Array.isArray(value) || value.length > 5000 || value.some(v => typeof v !== 'string' || v.length > 500 || (ids && !/^\d{5,22}$/.test(v)))) fail(label);
};
export function normalizeConfig(patch) {
  const c = mergeKnown(DEFAULT_CONFIG, patch);
  c.schemaVersion = 1;
  for (const group of ['desktop', 'bot', 'speech', 'media']) {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG[group])) {
      if (typeof value === 'boolean' && typeof c[group][key] !== 'boolean') fail(`${group}.${key}`);
      if (typeof value === 'string' && (typeof c[group][key] !== 'string' || c[group][key].length > 2000)) fail(`${group}.${key}`);
    }
  }
  if (!['voicevox', 'bouyomi'].includes(c.speech.provider)) fail('音声エンジン');
  for (const g of ['speech', 'media']) if (!['local', 'discord', 'both'].includes(c[g].output)) fail('音声出力先');
  number(c.speech.styleId, 0, 65535, '声種', true);
  number(c.speech.speed, 0.5, 2, '話速'); number(c.speech.pitch, -0.15, 0.15, '音程');
  number(c.speech.intonation, 0, 2, '抑揚'); number(c.speech.volume, 0, 1, '読み上げ音量');
  number(c.speech.maxChars, 1, 2000, '読み上げ文字数', true);
  number(c.speech.bouyomiPort, 1, 65535, '棒読みちゃんポート', true);
  number(c.speech.bouyomiHttpPort, 1, 65535, '棒読みちゃんHTTPポート', true);
  number(c.speech.bouyomiVoice, 0, 32767, '棒読みちゃんの声', true); number(c.speech.bouyomiTone, -1, 200, '棒読みちゃんの音程', true);
  if (!['tcp', 'http'].includes(c.speech.bouyomiCommunication)) fail('棒読みちゃん通信方式');
  number(c.media.volume, 0, 1, '動画音量'); number(c.media.ducking, 0, 1, '読み上げ中の動画音量');
  number(c.media.maxMinutes, 1, 1440, '再生上限', true);
  if (!/^\S{1,20}$/.test(c.bot.prefix)) fail('コマンド接頭辞');
  for (const key of ['allowedWebhookIds', 'controlUserIds']) strings(c.bot[key], key, true);
  for (const key of ['ignoredUserIds', 'allowedUserIds', 'ignoredRoleIds']) strings(c.speech[key], key, true);
  strings(c.speech.blockedWords, 'NGワード'); strings(c.media.allowedHosts, '許可ホスト');
  for (const host of c.media.allowedHosts) if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..') || host.startsWith('.')) fail('許可ホスト');
  const engine = new URL(c.speech.engineUrl);
  if (!['http:', 'https:'].includes(engine.protocol) || engine.username || engine.password || engine.search || engine.hash) fail('音声エンジンURL');
  if (!Array.isArray(c.bot.bindings) || c.bot.bindings.length > 100) fail('チャンネル設定');
  c.bot.bindings = c.bot.bindings.map(b => {
    if (!b || !/^\d{5,22}$/.test(b.guildId) || !/^\d{5,22}$/.test(b.voiceChannelId)) fail('サーバー・音声チャンネルID');
    strings(b.textChannelIds, 'テキストチャンネルID', true);
    return { guildId: b.guildId, voiceChannelId: b.voiceChannelId, textChannelIds: b.textChannelIds, label: String(b.label || '').slice(0, 100) };
  });
  if (new Set(c.bot.bindings.map(b => b.guildId)).size !== c.bot.bindings.length) fail('1サーバーにつき1接続先を設定してください');
  if (!Array.isArray(c.dictionary) || c.dictionary.length > 10000) fail('辞書');
  c.dictionary = c.dictionary.map(d => {
    if (!d || typeof d.source !== 'string' || !d.source || d.source.length > 200 || typeof d.replacement !== 'string' || d.replacement.length > 500) fail('辞書の単語・読み方');
    if (!['global', 'guild', 'user'].includes(d.scope) || (d.scope !== 'global' && !/^\d{5,22}$/.test(d.scopeId))) fail('辞書の対象');
    return { id: String(d.id || crypto.randomUUID()), source: d.source, replacement: d.replacement, scope: d.scope,
      scopeId: d.scope === 'global' ? '' : d.scopeId, regex: d.regex === true, caseSensitive: d.caseSensitive === true };
  });
  for (const key of ['profiles', 'emojiReadings', 'soundClips']) if (!Array.isArray(c.speech[key]) || c.speech[key].length > 5000) fail(key);
  c.speech.profiles = c.speech.profiles.map(p => {
    if (!/^\d{5,22}$/.test(p.userId)) fail('利用者ID');
    number(p.styleId, 0, 65535, '利用者の声種', true); number(p.speed, 0.5, 2, '利用者の話速');
    return { userId: p.userId, name: String(p.name || '').slice(0, 100), styleId: p.styleId, speed: p.speed };
  });
  c.speech.emojiReadings = c.speech.emojiReadings.map(e => {
    if (typeof e.source !== 'string' || !e.source || e.source.length > 100 || typeof e.replacement !== 'string' || e.replacement.length > 100) fail('絵文字の読み方');
    return { source: e.source, replacement: e.replacement };
  });
  c.speech.soundClips = c.speech.soundClips.map(s => {
    if (typeof s.trigger !== 'string' || !s.trigger || s.trigger.length > 100 || typeof s.path !== 'string' || !/\.(wav|mp3|ogg|flac)$/i.test(s.path)) fail('音声クリップ');
    return { trigger: s.trigger, path: s.path };
  });
  return c;
}

export function validateMediaUrl(raw, allowedHosts) {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port && !['80', '443'].includes(u.port)) throw new Error('再生には通常のHTTP/HTTPS URLを指定してください');
  if (isIP(host) || host === 'localhost' || host.endsWith('.local') || !host.includes('.')) throw new Error('ローカルネットワークのURLは再生できません');
  if (!allowedHosts.some(h => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) throw new Error(`再生先のホストを設定で許可してください: ${host}`);
  return u.toString();
}
