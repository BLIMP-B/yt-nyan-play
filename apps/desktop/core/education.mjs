import { ReadingText } from './latin-reading.mjs';
const normalize = value => value.normalize('NFKC');
export const EDUCATION_MAX_CHARACTERS = 30;
export function validateEducationLength(source, reading) {
  const size = [...source].length;
  if (!size || size > EDUCATION_MAX_CHARACTERS || [...reading].length > EDUCATION_MAX_CHARACTERS) throw new Error('教育する語句は1～30文字、読み方は30文字以内で指定してください');
}
export function parseEducationCommand(text) {
  const input = String(text).trim();
  const match = input.match(/^(教育|忘却|無音)\s*[（(]([^()（）]*)[)）]$/u);
  if (!match) {
    if (/^(教育|忘却|無音)\s*[（(]/u.test(input)) throw new Error('教育(単語=読み方)、忘却(単語)、無音(単語)で指定してください');
    return null;
  }
  let source = match[2].trim(), reading = '';
  if (match[1] === '教育') {
    const separator = source.search(/[=＝]/u);
    if (separator < 0) throw new Error('教育の単語と読み方を = または ＝ で区切ってください');
    reading = source.slice(separator + 1).trim(); source = source.slice(0, separator).trim();
  }
  if (!source || source.length > 2000 || /[\t\r\n]/u.test(source + reading)) throw new Error('教育する単語を確認してください');
  return { type: match[1] === '忘却' ? 'Forget' : match[1] === '無音' ? 'Mute' : 'Study', source, reading };
}
export function educationKey(value) { return normalize(value).replace(/[a-z]/g, c => c.toUpperCase()); }
export function fallbackEducation(config) {
  const native = config.speech.bouyomiPreprocess || config.speech.provider === 'bouyomi' && config.speech.bouyomiNativeRules;
  return config.education.filter(e => !e.metadataOnly && !(native && e.native));
}
export function applyEducation(text, entries) {
  const tracked = text instanceof ReadingText;
  if (!entries?.length) return text;
  let value = tracked ? text.normalize() : normalize(text);
  for (const entry of [...entries].sort((a, b) => b.source.length - a.source.length)) {
    const source = normalize(entry.source), literal = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /^[a-z]+$/iu.test(source) ? `(?<![a-z])${literal}(?![a-z])` : literal;
    // A replacement function preserves literal dollar signs in readings.
    const current = value;
    value = value.replace(new RegExp(pattern, 'giu'), (match, offset) => tracked && current.protected.slice(offset, offset + match.length).some(Boolean) ? current.slice(offset, offset + match.length) : entry.reading, true);
  }
  return value;
}
