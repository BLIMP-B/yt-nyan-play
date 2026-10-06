import { ReadingText } from './latin-reading.mjs';
const normalize = value => value.normalize('NFKC');
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
export function applyEducation(text, entries) {
  const tracked = text instanceof ReadingText;
  if (!entries?.length) return text;
  let value = tracked ? new ReadingText(normalize(text.text)) : normalize(text);
  for (const entry of [...entries].sort((a, b) => b.source.length - a.source.length)) {
    const source = normalize(entry.source), literal = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /^[a-z]+$/iu.test(source) ? `(?<![a-z])${literal}(?![a-z])` : literal;
    // A replacement function preserves literal dollar signs in readings.
    value = value.replace(new RegExp(pattern, 'giu'), () => entry.reading, true);
  }
  return value;
}
