import { RE2 } from 're2-wasm';
import { applyEducation, fallbackEducation } from './education.mjs';
import { ReadingText } from './latin-reading.mjs';
import { messageMediaText } from './message-media.mjs';
import { spokenText } from './spoken-text.mjs';

export function formatTemplate(template, values) {
  return template.replace(/\$([\w-]+)\$/g, (_, key) => String(values[key] ?? ''));
}
export function shouldReceive(message, config, forMedia = false) {
  if (message.isSelf || message.isSystem) return false;
  if (config.speech.ignoredUserIds.includes(message.userId)) return false;
  if (config.speech.allowedUserIds.length && !config.speech.allowedUserIds.includes(message.userId)) return false;
  if (message.roleIds?.some(id => config.speech.ignoredRoleIds.includes(id))) return false;
  if (config.speech.blockedWords.some(w => w && message.content.includes(w))) return false;
  if (message.webhookId) {
    if (!config.bot.includeWebhooks || config.bot.allowedWebhookIds.length && !config.bot.allowedWebhookIds.includes(message.webhookId)) return false;
  } else if (message.isBot && !config.bot.includeBots) return false;
  if (!message.guildId) return config.bot.readDMs;
  if (config.bot.masterTextChannelId === message.channelId) return true;
  if (forMedia) return config.bot.bindings.some(b => b.guildId === message.guildId);
  return config.bot.bindings.some(b => b.guildId === message.guildId && (b.voiceChannelId === message.channelId || b.textChannelIds.includes(message.channelId)));
}
export function shouldRead(message, config) {
  return shouldReceive(message, config) && (!message.guildId || config.bot.masterTextChannelId === message.channelId || config.bot.bindings.some(b => b.guildId === message.guildId && b.readEnabled !== false && (b.voiceChannelId === message.channelId || b.textChannelIds.includes(message.channelId)) && !b.disabledTextChannelIds?.includes(message.channelId)));
}
export function speechTargets(guildId, forwarding) { const targets = new Set(guildId ? [guildId] : []); for (const f of forwarding) { if (f.mode !== 'none' && f.fromGuildId === guildId) targets.add(f.toGuildId); if (f.mode === 'two-way' && f.toGuildId === guildId) targets.add(f.fromGuildId); } return [...targets]; }
export function applyDictionary(text, entries, context) {
  const matching = entries.filter(d => d.scope === 'global' || d.scope === 'guild' && d.scopeId === context.guildId || d.scope === 'user' && d.scopeId === context.userId)
    .sort((a, b) => b.source.length - a.source.length);
  let result = text;
  for (const entry of matching) {
    const pattern = entry.regex ? entry.source : entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RE2(pattern, entry.caseSensitive ? 'gu' : 'giu');
    result = result.replace(regex, entry.replacement, true).slice(0, 8000);
  }
  return result;
}
// Channel IDs distinguish Discord chat from titles, system messages and previews.
export function speakerName(message) {
  return [message.serverNickname, message.userName, message.userId].find(value => typeof value === 'string' && value.trim()) || '';
}
export function speakerSuffix(message, config) {
  if (!message.channelId || config.speech.speakerSuffixDisabledChannelIds?.includes(message.channelId)) return '';
  const name = speakerName(message);
  // Parentheses are only a UI placeholder. Imported preprocessing/dictionary
  // rules may erase their complete contents, including the selected name.
  return name ? `、${name}の発言` : '';
}
function fallbackText(content, message, config) {
  const s = config.speech;
  let text = content;
  if (s.chatEducationEnabled) text = applyEducation(text, fallbackEducation(config));
  if (!s.readSpoilers) text = text.replace(/\|\|[\s\S]*?\|\|/g, s.spoilerText);
  if (!s.readCode) text = text.replace(/```[\s\S]*?```/g, 'コード').replace(/`([^`]+)`/g, '$1');
  text = text.replace(/<@!?(\d+)>/g, (_, id) => message.mentions?.[id] || 'メンション')
    .replace(/<@&(\d+)>/g, (_, id) => message.roles?.[id] || 'ロール')
    .replace(/<#(\d+)>/g, (_, id) => message.channels?.[id] || 'チャンネル');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').urls(s.readUrls);
  text = text.replace(/[*_~]/g, (match, offset) => text.protected[offset] ? match : '');
  return applyDictionary(text, config.dictionary, message).replace(/^\s+|\s+$/gu, '');
}
export function prepareSpeakerSuffix(message, config) {
  const suffix = speakerSuffix(message, config);
  if (!suffix) return '';
  const content = messageMediaText({ ...message, content: suffix, attachments: [], stickers: [] }, config);
  const s = config.speech;
  if (s.bouyomiPreprocess || s.provider === 'bouyomi' && s.bouyomiNativeRules) {
    return (s.chatEducationEnabled ? applyEducation(content, fallbackEducation(config)) : content).text;
  }
  return spokenText(fallbackText(content, message, config).latinReading());
}
export function prepareSpeech(message, config) {
  const s = config.speech;
  if (s.bouyomiPreprocess || s.provider === 'bouyomi' && s.bouyomiNativeRules) {
    const content = messageMediaText(message, config);
    const text = (s.chatEducationEnabled ? applyEducation(content, fallbackEducation(config)) : content).text;
    if (message.channelId) return text.trim() ? text + prepareSpeakerSuffix(message, config) : '';
    const values = { username: message.userName || '', nickname: message.displayName || message.userName || '', server: message.guildName || '', channel: message.channelName || '', text, userid: message.userId || '', time: new Date().toLocaleTimeString('ja-JP') };
    return s.readNames ? formatTemplate(s.messageTemplate, values) : text;
  }
  const text = fallbackText(messageMediaText(message, config), message, config);
  if (!text.text) return '';
  const values = { username: message.userName, nickname: message.displayName || message.userName,
    server: message.guildName || '', channel: message.channelName || '', text,
    time: new Date().toLocaleTimeString('ja-JP'), userid: message.userId };
  // Limit the body before appending attribution, so a long post keeps its speaker.
  const formatted = !message.channelId && s.readNames ? new ReadingText(s.messageTemplate).replace(/\$([\w-]+)\$/g, (_, key) => values[key] ?? '') : text;
  const body = spokenText(formatted.latinReading(s.maxChars));
  return body ? body + prepareSpeakerSuffix(message, config) : '';
}

// Native processing has already interpreted tags. Only its spoken text enters
// this fallback; command arguments and media URLs never pass through it.
export function prepareNativeText(text, config, context = {}, readings = []) {
  let value = new ReadingText(text);
  const explicit = [...readings, ...config.speech.emojiReadings.map(e => e.replacement), ...(config.speech.chatEducationEnabled ? config.education.map(e => e.reading) : [])];
  for (const reading of explicit.sort((a, b) => b.length - a.length)) {
    if (reading) value = value.replace(new RegExp(reading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'), () => reading, true);
  }
  return spokenText(applyDictionary(value, config.dictionary, context).latinReading());
}
