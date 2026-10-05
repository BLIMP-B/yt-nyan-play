import { isIP } from 'node:net';

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  desktop: { autoStart: false, startMinimized: false, closeToTray: true, notifications: true, theme: 'light' },
  android: { sdkPath: '', javaPath: '', image: 'system-images;android-35;google_apis_playstore;x86_64', avdName: 'nyantalk_play', port: 5580, ramMb: 2048, gpu: 'auto' },
  twitter: { accounts: [], clientId: '', callbackPort: 11488, pollSeconds: 60, readRetweets: true, readReplies: true, readExisting: false, guildId: '' },
  bot: {
    autoConnect: false, prefix: '!nyan', includeBots: false, includeWebhooks: true,
    allowedWebhookIds: [], controlUserIds: [], autoJoin: false, autoLeave: true,
    announceJoinLeave: false, readDMs: false, bindings: [], masterTextChannelId: '',
  },
  speech: {
    enabled: true, provider: 'voicevox', engineUrl: 'http://127.0.0.1:50021',
    engineExecutable: '', styleId: 3, speed: 1, pitch: 0, intonation: 1,
    volume: 0.8, output: 'discord', outputDevice: '', maxChars: 500,
    readNames: true, readUrls: false, readEmoji: false, readAttachments: true,
    readSpoilers: false, spoilerText: 'ネタバレ', readCode: false,
    messageTemplate: '$nickname$、$text$', joinTemplate: '$nickname$が$channel$に参加しました',
    leaveTemplate: '$nickname$が$channel$から退出しました',
    moveTemplate: '$nickname$が$channel-prev$から$channel-next$へ移動しました',
    ignoredUserIds: [], allowedUserIds: [], ignoredRoleIds: [], blockedWords: [],
    profiles: [], emojiReadings: [], soundClips: [], forwarding: [],
    bouyomiNativeRules: true, bouyomiUseDefaults: true, bouyomiHost: '127.0.0.1', bouyomiPort: 50001, bouyomiHttpPort: 50080, bouyomiCommunication: 'tcp', bouyomiVoice: 0, bouyomiTone: -1,
    bouyomiPreprocess: false, bouyomiTagMode: 'original', bouyomiVoiceMap: [],
  },
  media: {
    enabled: true, volume: 0.7, ducking: 0.35, showWindow: true,
    output: 'discord', maxMinutes: 120,
    allowedHosts: ['youtube.com', 'youtu.be', 'nicovideo.jp', 'niconico.com', 'nico.ms', 'x.com',
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
  for (const group of ['desktop', 'bot', 'speech', 'media', 'android', 'twitter']) {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG[group])) {
      if (typeof value === 'boolean' && typeof c[group][key] !== 'boolean') fail(`${group}.${key}`);
      if (typeof value === 'string' && (typeof c[group][key] !== 'string' || c[group][key].length > 2000)) fail(`${group}.${key}`);
    }
  }
  if (!['light', 'dark'].includes(c.desktop.theme)) fail('配色');
  if (!/^system-images;android-\d{2,3};google_apis_playstore;x86_64$/.test(c.android.image) || !/^[a-zA-Z0-9_-]{1,40}$/.test(c.android.avdName)) fail('Android端末・イメージ');
  number(c.android.port, 5554, 5682, 'Emulatorポート', true); if (c.android.port % 2) fail('Emulatorポートは偶数');
  number(c.android.ramMb, 1024, 8192, 'Androidメモリ', true); if (!['auto', 'software'].includes(c.android.gpu)) fail('Android描画');
  strings(c.twitter.accounts, 'X対象アカウント'); c.twitter.accounts = [...new Set(c.twitter.accounts.map(a => a.replace(/^@/, '').toLowerCase()))];
  if (c.twitter.accounts.some(a => !/^[a-zA-Z0-9_]{1,15}$/.test(a))) fail('Xアカウント名');
  number(c.twitter.callbackPort, 1024, 65535, 'Xログイン待受けポート', true); number(c.twitter.pollSeconds, 30, 3600, 'X取得間隔', true);
  if (c.twitter.guildId && !/^\d{5,22}$/.test(c.twitter.guildId)) fail('X読み上げ先');
  if (c.bot.masterTextChannelId && !/^\d{5,22}$/.test(c.bot.masterTextChannelId)) fail('マスタチャンネルID');
  if (!['voicevox', 'bouyomi'].includes(c.speech.provider)) fail('音声エンジン');
  if (!['original', 'on', 'off'].includes(c.speech.bouyomiTagMode)) fail('棒読みちゃんの配信者向け機能');
  if (!Array.isArray(c.speech.bouyomiVoiceMap) || c.speech.bouyomiVoiceMap.length > 500) fail('棒読みちゃんの声対応');
  c.speech.bouyomiVoiceMap = c.speech.bouyomiVoiceMap.map(p => { number(p.voiceId, 0, 32767, '元の声ID', true); number(p.styleId, 0, 65535, '対応する声種', true); return { voiceId: p.voiceId, styleId: p.styleId }; });
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
    const disabledTextChannelIds = b.disabledTextChannelIds || []; strings(disabledTextChannelIds, '無効チャンネルID', true);
    const readEnabled = b.readEnabled === undefined ? true : b.readEnabled;
    const announceJoinLeave = b.announceJoinLeave ?? null;
    if (typeof readEnabled !== 'boolean' || announceJoinLeave !== null && typeof announceJoinLeave !== 'boolean') fail('サーバーの読み上げ・入退室通知');
    return { guildId: b.guildId, voiceChannelId: b.voiceChannelId, textChannelIds: [...new Set(b.textChannelIds)], disabledTextChannelIds: [...new Set(disabledTextChannelIds)], readEnabled, announceJoinLeave, label: String(b.label || '').slice(0, 100) };
  });
  if (new Set(c.bot.bindings.map(b => b.guildId)).size !== c.bot.bindings.length) fail('1サーバーにつき1接続先を設定してください');
  if (!Array.isArray(c.speech.forwarding) || c.speech.forwarding.length > 100) fail('読み上げ転送');
  c.speech.forwarding = c.speech.forwarding.map(f => { if (!/^\d{5,22}$/.test(f.fromGuildId) || !/^\d{5,22}$/.test(f.toGuildId) || f.fromGuildId === f.toGuildId || !['one-way', 'two-way', 'none'].includes(f.mode)) fail('読み上げ転送先・方向'); return { fromGuildId: f.fromGuildId, toGuildId: f.toGuildId, mode: f.mode }; });
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
