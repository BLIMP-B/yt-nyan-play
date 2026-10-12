import { educationKey } from './education.mjs';

export function readingSource(source) {
  const text = String(source).normalize('NFKC').trim();
  return text.match(/^<a?:([^:>]+):\d+>$/u)?.[1] || text.match(/^:([^:]+):$/u)?.[1] || text;
}
export const readingKey = source => educationKey(readingSource(source));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyed = entries => new Map(entries.map(e => [readingKey(e.source), e]));

// The old arrays remain import/export compatible, but each normalized source
// has one value. Legacy conflicts retain the formerly audible emoji setting.
export function unifyReadings(config, baseline) {
  const words = keyed(config.education), emoji = keyed(config.speech.emojiReadings);
  const oldWords = baseline ? keyed(baseline.education) : new Map(), oldEmoji = baseline ? keyed(baseline.speech.emojiReadings) : new Map();
  for (const key of new Set([...words.keys(), ...emoji.keys(), ...oldWords.keys(), ...oldEmoji.keys()])) {
    let word = words.get(key), named = emoji.get(key);
    const wordChanged = baseline && !equal(word, oldWords.get(key)), emojiChanged = baseline && !equal(named, oldEmoji.get(key));
    if (baseline && ((wordChanged && !word && oldWords.has(key)) || (emojiChanged && !named && oldEmoji.has(key)))) {
      words.delete(key); emoji.delete(key); continue;
    }
    if (!word && named) word = { source: readingSource(named.source), reading: named.replacement, metadataOnly: true };
    if (!word) continue;
    if (named && word.reading !== named.replacement) {
      if (wordChanged && emojiChanged) throw new Error('同じ単語の教育と絵文字設定には同じ読み方を指定してください');
      if (!wordChanged) word = { ...word, reading: named.replacement };
    }
    words.set(key, { ...word, source: readingSource(word.source) });
    if (named) emoji.set(key, { source: readingSource(named.source), replacement: word.reading });
  }
  config.education = [...words.values()]; config.speech.emojiReadings = [...emoji.values()]; return config;
}

export function readingSlots(config) {
  const copy = { education: structuredClone(config.education), speech: { emojiReadings: structuredClone(config.speech.emojiReadings) } };
  unifyReadings(copy);
  const emojiKeys = new Set(copy.speech.emojiReadings.map(e => readingKey(e.source)));
  return copy.education.map(e => ({ ...e, emoji: emojiKeys.has(readingKey(e.source)) }));
}

export function setSharedReading(config, { source, reading = '', forget = false, metadataOnly = false, emoji = metadataOnly, native = false }) {
  source = readingSource(source); const key = readingKey(source);
  const old = config.education.find(e => readingKey(e.source) === key);
  const hadEmoji = config.speech.emojiReadings.some(e => readingKey(e.source) === key);
  config.education = config.education.filter(e => readingKey(e.source) !== key);
  config.speech.emojiReadings = config.speech.emojiReadings.filter(e => readingKey(e.source) !== key);
  if (!forget) {
    config.education.push({ source, reading, ...(metadataOnly && (!old || old.metadataOnly) ? { metadataOnly: true } : {}), ...(native ? { native: true } : {}) });
    if (emoji || hadEmoji) config.speech.emojiReadings.push({ source, replacement: reading });
  }
  return config;
}
