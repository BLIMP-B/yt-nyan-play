import { RE2 } from 're2-wasm';

export function formatTemplate(template, values) {
  return template.replace(/\$([\w-]+)\$/g, (_, key) => String(values[key] ?? ''));
}
export function shouldRead(message, config) {
  if (message.isSelf || message.isSystem) return false;
  if (config.speech.ignoredUserIds.includes(message.userId)) return false;
  if (config.speech.allowedUserIds.length && !config.speech.allowedUserIds.includes(message.userId)) return false;
  if (message.roleIds?.some(id => config.speech.ignoredRoleIds.includes(id))) return false;
  if (config.speech.blockedWords.some(w => w && message.content.includes(w))) return false;
  if (message.webhookId) {
    if (!config.bot.includeWebhooks || config.bot.allowedWebhookIds.length && !config.bot.allowedWebhookIds.includes(message.webhookId)) return false;
  } else if (message.isBot && !config.bot.includeBots) return false;
  if (!message.guildId) return config.bot.readDMs;
  return config.bot.bindings.some(b => b.guildId === message.guildId && b.textChannelIds.includes(message.channelId));
}
export function applyDictionary(text, entries, context) {
  const matching = entries.filter(d => d.scope === 'global' || d.scope === 'guild' && d.scopeId === context.guildId || d.scope === 'user' && d.scopeId === context.userId)
    .sort((a, b) => b.source.length - a.source.length);
  let result = text;
  for (const entry of matching) {
    const pattern = entry.regex ? entry.source : entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RE2(pattern, entry.caseSensitive ? 'gu' : 'giu');
    result = result.replace(regex, entry.replacement).slice(0, 8000);
  }
  return result;
}
export function prepareSpeech(message, config) {
  const s = config.speech;
  let text = message.content;
  if (!s.readSpoilers) text = text.replace(/\|\|[\s\S]*?\|\|/g, s.spoilerText);
  if (!s.readCode) text = text.replace(/```[\s\S]*?```/g, 'コード').replace(/`([^`]+)`/g, '$1');
  text = text.replace(/<@!?(\d+)>/g, (_, id) => message.mentions?.[id] || 'メンション')
    .replace(/<@&(\d+)>/g, (_, id) => message.roles?.[id] || 'ロール')
    .replace(/<#(\d+)>/g, (_, id) => message.channels?.[id] || 'チャンネル');
  text = text.replace(/<a?:([^:>]+):\d+>/g, (_, name) => s.readEmoji ? name : '');
  if (!s.readUrls) text = text.replace(/https?:\/\/\S+/g, 'URL');
  for (const e of s.emojiReadings) text = text.split(e.source).join(e.replacement);
  if (!s.readEmoji) text = text.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_~]/g, '');
  if (s.readAttachments && message.attachments?.length) {
    const names = message.attachments.map(a => a.spoiler && !s.readSpoilers ? s.spoilerText : a.name).join('、');
    text += `。添付ファイル${message.attachments.length}件、${names}`;
  }
  text = applyDictionary(text, config.dictionary, message).trim();
  if (!text) return '';
  const values = { username: message.userName, nickname: message.displayName || message.userName,
    server: message.guildName || '', channel: message.channelName || '', text,
    time: new Date().toLocaleTimeString('ja-JP'), userid: message.userId };
  const formatted = s.readNames ? formatTemplate(s.messageTemplate, values) : text;
  return [...formatted].slice(0, s.maxChars).join('');
}
