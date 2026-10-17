import { messageMediaText } from './message-media.mjs';
import { educationKey } from './education.mjs';
import { speakerSuffix } from './text.mjs';
import { parseMediaCommand } from './protocol.mjs';

// Match semantic text before education/romaji removes an emoji or changes its
// name. Hidden content and filenames must never become playback instructions.
export function conversionText(message, config) {
  let content = String(message.content || '');
  if (!config.speech.readSpoilers) content = content.replace(/\|\|[\s\S]*?\|\|/gu, config.speech.spoilerText);
  if (!config.speech.readCode) content = content.replace(/```[\s\S]*?```/gu, 'コード');
  content = content.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/https?:\/\/[^\s<>]+/gu, '');
  const settings = { ...config, education: [], speech: { ...config.speech, chatEducationEnabled: false, emojiReadings: [] } };
  const body = [...messageMediaText({ ...message, content }, settings).text].slice(0, config.speech.maxChars).join('');
  return body + messageMediaText({ content: speakerSuffix(message, config) }, settings).text;
}

export function convertedMedia(message, config, prepared = '') {
  if (!config.speech.chatEducationEnabled || !config.media.enabled || !config.mediaConversions?.length) return null;
  const native = config.speech.bouyomiPreprocess || config.speech.provider === 'bouyomi' && config.speech.bouyomiNativeRules;
  // Native input is still raw: scanning it a second time would reintroduce
  // hidden spoilers, code and URLs excluded from the semantic candidate.
  const candidates = [conversionText(message, config), native ? '' : prepared.replace(/https?:\/\/[^\s<>]+/gu, '')].map(educationKey);
  let best;
  for (const entry of config.mediaConversions) {
    const key = educationKey(entry.source);
    for (const [candidate, text] of candidates.entries()) {
      let index = text.indexOf(key);
      while (index >= 0) {
        if (!/^[A-Z]+$/u.test(key) || !/[A-Z]/u.test(text[index - 1] || '') && !/[A-Z]/u.test(text[index + key.length] || '')) break;
        index = text.indexOf(key, index + 1);
      }
      if (index < 0) continue;
      if (!best || candidate < best.candidate || candidate === best.candidate && (index < best.index || index === best.index && key.length > best.length)) best = { entry, candidate, index, length: key.length };
    }
  }
  return best ? parseMediaCommand(`${best.entry.url}直接`, config) : null;
}
