import { ReadingText } from './latin-reading.mjs';
import { applyEducation, educationKey } from './education.mjs';

const fileKinds = [
  ['画像ファイル', 'jpg jpeg jfif png apng gif webp avif heic heif bmp dib tif tiff svg ico jxl'],
  ['動画ファイル', 'mp4 m4v mov qt mkv webm avi wmv flv f4v mpg mpeg m2v mts m2ts ts 3gp 3g2 ogv'],
  ['音声ファイル', 'mp3 wav wave flac aac m4a m4b ogg oga opus wma aif aiff alac amr mid midi'],
  ['圧縮ファイル', 'zip rar 7z tar gz gzip tgz bz2 xz zst lzh cab'],
  ['文書ファイル', 'pdf doc docx odt rtf pages epub'],
  ['表計算ファイル', 'xls xlsx xlsm ods csv tsv numbers'],
  ['プレゼンテーションファイル', 'ppt pptx odp key'],
  ['テキストファイル', 'txt md markdown log json xml html htm css js mjs cjs ts tsx jsx py rb c cpp h cs java sh bat ps1 yml yaml ini conf toml'],
];
const extensions = new Map(fileKinds.flatMap(([kind, words]) => words.split(' ').map(ext => [ext, kind])));

export function attachmentKind(attachment) {
  const name = String(attachment.name || '').normalize('NFKC').split(/[\\/]/u).at(-1);
  const ext = name.match(/\.([^.]*)$/u)?.[1]?.toLowerCase();
  if (extensions.has(ext)) return extensions.get(ext);
  const mime = String(attachment.contentType || '').toLowerCase().split(';')[0].trim();
  for (const [prefix, kind] of [['image/', '画像ファイル'], ['video/', '動画ファイル'], ['audio/', '音声ファイル'], ['text/', 'テキストファイル']]) if (mime.startsWith(prefix)) return kind;
  return 'ファイル';
}

function namedReading(name, id, token, config) {
  const aliases = [token, name, `:${name}:`, id].filter(Boolean);
  const configured = config.speech.emojiReadings.find(e => aliases.includes(e.source));
  if (configured) return new ReadingText(configured.replacement, true);
  if (config.speech.chatEducationEnabled) {
    const exact = config.education.find(e => aliases.some(alias => educationKey(alias) === educationKey(e.source)));
    if (exact) return new ReadingText(exact.reading, true);
    return applyEducation(new ReadingText(name), config.education);
  }
  return new ReadingText(name);
}

// Preserve explicit readings as tracked text, and remove IDs/filenames before
// either the ordinary speech pipeline or Bouyomi's native tag processing.
export function messageMediaText(message, config) {
  const s = config.speech;
  let text = new ReadingText(message.content || '').replace(/<a?:([^:>]+):(\d+)>/gu, (token, name, id) => s.readEmoji ? namedReading(name, id, token, config) : '');
  for (const reading of s.emojiReadings) {
    // Names/IDs were resolved only inside emoji/sticker metadata. Applying them
    // to arbitrary text would also rename Sound-tag paths and normal words.
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(reading.source)) text = text.replace(new RegExp(reading.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'), () => reading.replacement, true);
  }
  if (!s.readEmoji) text = text.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '');
  if (s.readAttachments && message.attachments?.length) {
    const types = message.attachments.map(a => a.spoiler && !s.readSpoilers ? s.spoilerText : attachmentKind(a));
    text = text.replace(/$/u, () => `。添付ファイル${types.length}件、${types.join('、')}`);
  }
  const stickers = s.readStickers ? (message.stickers || []).filter(sticker => sticker.name) : [];
  if (stickers.length) {
    text = text.replace(/$/u, () => '。スタンプ、');
    for (const [index, sticker] of stickers.entries()) {
      if (index) text = text.replace(/$/u, () => '、');
      text = text.replace(/$/u, () => namedReading(sticker.name, sticker.id, '', config));
    }
  }
  return text;
}
