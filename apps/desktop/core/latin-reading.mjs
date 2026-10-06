const names = ['エー', 'ビー', 'シー', 'ディー', 'イー', 'エフ', 'ジー', 'エイチ', 'アイ', 'ジェー', 'ケー', 'エル', 'エム', 'エヌ', 'オー', 'ピー', 'キュー', 'アール', 'エス', 'ティー', 'ユー', 'ブイ', 'ダブリュー', 'エックス', 'ワイ', 'ゼット'];
const letters = /[A-Za-zＡ-Ｚａ-ｚ]+(?:['’][A-Za-zＡ-Ｚａ-ｚ]+)*/gu;
const urls = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()[\]{}「」『』【】、。！？]+/giu;
const kana = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
  shi: 'し', chi: 'ち', tsu: 'つ', fu: 'ふ', ji: 'じ', sha: 'しゃ', shu: 'しゅ', sho: 'しょ', she: 'しぇ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', che: 'ちぇ', ja: 'じゃ', ju: 'じゅ', jo: 'じょ', je: 'じぇ',
  wi: 'うぃ', we: 'うぇ', wo: 'を', wu: 'う', yi: 'い', ye: 'いぇ',
  fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', fya: 'ふゃ', fyu: 'ふゅ', fyo: 'ふょ',
  tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ', kwa: 'くぁ', kwi: 'くぃ', kwe: 'くぇ', kwo: 'くぉ',
  gwa: 'ぐぁ', gwi: 'ぐぃ', gwe: 'ぐぇ', gwo: 'ぐぉ', tha: 'てゃ', thi: 'てぃ', thu: 'てゅ', the: 'てぇ', tho: 'てょ',
  dha: 'でゃ', dhi: 'でぃ', dhu: 'でゅ', dhe: 'でぇ', dho: 'でょ', twa: 'とぁ', twi: 'とぃ', twu: 'とぅ', twe: 'とぇ', two: 'とぉ',
  dwa: 'どぁ', dwi: 'どぃ', dwu: 'どぅ', dwe: 'どぇ', dwo: 'どぉ', xtsu: 'っ', ltsu: 'っ', xtu: 'っ', ltu: 'っ',
};
for (const [row, values] of Object.entries({ k: 'かきくけこ', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', h: 'はひふへほ', m: 'まみむめも', r: 'らりるれろ', g: 'がぎぐげご', z: 'ざじずぜぞ', d: 'だぢづでど', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ', v: ['ゔぁ', 'ゔぃ', 'ゔ', 'ゔぇ', 'ゔぉ'] })) {
  for (const [i, vowel] of [...'aiueo'].entries()) kana[row + vowel] = values[i];
}
Object.assign(kana, { ya: 'や', yu: 'ゆ', yo: 'よ', wa: 'わ' });
for (const [row, base] of Object.entries({ ky: 'き', sy: 'し', ty: 'ち', ny: 'に', hy: 'ひ', my: 'み', ry: 'り', gy: 'ぎ', zy: 'じ', jy: 'じ', dy: 'ぢ', by: 'び', py: 'ぴ' })) {
  for (const [vowel, small] of Object.entries({ a: 'ゃ', u: 'ゅ', o: 'ょ', e: 'ぇ', i: 'ぃ' })) kana[row + vowel] = base + small;
}
for (const prefix of ['x', 'l']) for (const [key, value] of Object.entries({ a: 'ぁ', i: 'ぃ', u: 'ぅ', e: 'ぇ', o: 'ぉ', ya: 'ゃ', yu: 'ゅ', yo: 'ょ', wa: 'ゎ', ka: 'ヵ', ke: 'ヶ' })) kana[prefix + key] = value;

export function romanKana(value) {
  const normalized = value.normalize('NFKC');
  if (normalized === 'n') return 'ん';
  const word = normalized.toLowerCase();
  if (word.length === 1) return names[word.charCodeAt(0) - 97];
  const result = []; let position = 0;
  while (position < word.length) {
    const c = word[position], next = word[position + 1];
    if (c === 'n' && (next === "'" || next === '’')) { result.push('ん'); position += 2; continue; }
    if (c === "'" || c === '’') { result.push(c); position++; continue; }
    if (c === 'n' && (!next || !'aiueoy'.includes(next))) {
      result.push('ん'); position += next === 'n' && !word[position + 2] ? 2 : 1; continue;
    }
    if ((c === next && !'aiueon'.includes(c)) || word.startsWith('tch', position)) { result.push('っ'); position++; continue; }
    let matched = false;
    for (let length = Math.min(4, word.length - position); length > 0; length--) {
      const syllable = word.slice(position, position + length);
      if (kana[syllable]) { result.push(kana[syllable]); position += length; matched = true; break; }
    }
    if (!matched) { result.push(names[c.charCodeAt(0) - 97]); position++; }
  }
  return result.join('');
}

// Keep replacement provenance alongside text, rather than injecting marker strings
// that chat content or native Bouyomi tags could collide with.
export class ReadingText {
  constructor(text, protectedText = false) {
    this.text = String(text);
    this.protected = Array(this.text.length).fill(protectedText);
  }
  slice(start, end) {
    const value = new ReadingText(this.text.slice(start, end));
    value.protected = this.protected.slice(start, end); return value;
  }
  replace(pattern, replacement, protect = false) {
    const original = this.text, chunks = []; let position = 0;
    original.replace(pattern, (...args) => {
      const named = typeof args.at(-1) === 'object';
      const offset = args.at(named ? -3 : -2), match = args[0];
      chunks.push(this.slice(position, offset));
      let value;
      if (typeof replacement === 'function') value = replacement(...args);
      else {
        const captures = args.slice(1, named ? -3 : -2), groups = named ? args.at(-1) : undefined;
        // RE2 has its own capture/substitution rules; preserve those exactly.
        value = typeof pattern.replaceMatch === 'function' ? pattern.replaceMatch(original, { match, index: offset, groups: captures }, replacement) : String(replacement).replace(/\$([$&`']|\d{1,2}|<[^>]*>)/g, (token, key) => {
          if (key === '$') return '$'; if (key === '&') return match;
          if (key === '`') return original.slice(0, offset); if (key === "'") return original.slice(offset + match.length);
          if (key.startsWith('<')) return groups ? String(groups[key.slice(1, -1)] ?? '') : token;
          let index = Number(key); if (index > 0 && index <= captures.length) return captures[index - 1] ?? '';
          index = Number(key[0]); return key.length === 2 && index > 0 && index <= captures.length ? (captures[index - 1] ?? '') + key[1] : token;
        });
      }
      chunks.push(value instanceof ReadingText ? value : new ReadingText(value, protect || this.protected.slice(offset, offset + match.length).some(Boolean)));
      position = offset + match.length; return match;
    });
    chunks.push(this.slice(position));
    const result = new ReadingText(chunks.map(c => c.text).join(''));
    result.protected = chunks.flatMap(c => c.protected); return result;
  }
  urls(read = true) {
    return this.replace(urls, match => {
      try {
        const value = new URL(/^www\./i.test(match) ? 'https://' + match : match);
        if (!value.hostname) return match;
        return new ReadingText(read ? match : 'URL', true);
      } catch { return match; }
    });
  }
  latinReading(maxChars = Infinity) {
    const input = this.urls(), chunks = []; let position = 0, length = 0;
    const append = value => { const part = [...value].slice(0, Math.max(0, maxChars - length)).join(''); chunks.push(part); length += [...part].length; };
    for (const match of input.text.matchAll(letters)) {
      append(input.text.slice(position, match.index));
      for (let n = 0; n < match[0].length && length < maxChars;) {
        const protectedText = input.protected[match.index + n]; let end = n + 1;
        while (end < match[0].length && input.protected[match.index + end] === protectedText) end++;
        const word = match[0].slice(n, end); append(protectedText ? word : romanKana(word)); n = end;
      }
      position = match.index + match[0].length;
      if (length >= maxChars) break;
    }
    if (length < maxChars) append(input.text.slice(position));
    return chunks.join('');
  }
}

export function readLatin(text, maxChars) { return new ReadingText(text).latinReading(maxChars); }
