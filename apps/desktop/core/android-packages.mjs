import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';

export const SDK_REPOSITORY = 'https://dl.google.com/android/repository/';
export const PLAY_REPOSITORY = `${SDK_REPOSITORY}sys-img/google_apis_playstore/`;
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
export function parseRepository(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Android配布情報のXML宣言が不正です');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml);
  const root = parsed['sdk-repository'] || parsed['sdk-sys-img'];
  if (!root) throw new Error('Androidの配布情報を読み込めません');
  return { packages: array(root.remotePackage), licenses: Object.fromEntries(array(root.license).map(l => [l['@_id'], l['#text'] || ''])) };
}
export function revision(p) { return ['major', 'minor', 'micro'].map(k => Number(p.revision?.[k] || 0)).join('.'); }
export function playImages(repository) {
  const images = repository.packages.filter(p => /^system-images;android-\d+;google_apis_playstore;x86_64$/.test(p['@_path']) && p['@_obsolete'] !== 'true' && !p['uses-license']?.['@_ref']?.includes('preview') && (!p['channelRef'] || p.channelRef['@_ref'] === 'channel-0'))
    .map(p => ({ id: p['@_path'], api: Number(p['type-details']['api-level']), label: p['display-name'], revision: revision(p), licenseId: p['uses-license']?.['@_ref'] }))
    .sort((a, b) => b.api - a.api || b.revision.localeCompare(a.revision, undefined, { numeric: true }));
  return images.filter((image, index) => images.findIndex(i => i.id === image.id) === index);
}
export function windowsTools(repository) {
  const p = repository.packages.find(p => p['@_path'] === 'cmdline-tools;latest' && (!p.channelRef || p.channelRef['@_ref'] === 'channel-0'));
  const archive = array(p?.archives?.archive).find(a => a['host-os'] === 'windows')?.complete;
  if (!archive || !/^[a-zA-Z0-9_.-]+\.zip$/.test(archive.url) || !/^[a-f0-9]{40}$/i.test(archive.checksum)) throw new Error('公式Windows SDKの配布情報が見つかりません');
  return { url: SDK_REPOSITORY + archive.url, size: Number(archive.size), checksum: archive.checksum, licenseId: p['uses-license']['@_ref'] };
}
export function verifyChecksum(bytes, expected, algorithm = 'sha256') {
  if (createHash(algorithm).update(bytes).digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error('ダウンロードしたファイルのチェックサムが一致しません');
}
export function extractZip(bytes, destination, stripPrefix = '') {
  const root = resolve(destination); const files = unzipSync(bytes); let total = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error('アーカイブ内のパスが不正です');
    if (stripPrefix && !name.startsWith(stripPrefix)) continue;
    const relative = stripPrefix ? name.slice(stripPrefix.length) : name;
    if (!relative) continue;
    const path = resolve(root, relative); if (!path.startsWith(root + sep)) throw new Error('アーカイブ内のパスが不正です');
    total += data.length; if (total > 1024 * 1024 * 1024) throw new Error('展開後のファイルが大きすぎます');
    if (name.endsWith('/')) mkdirSync(path, { recursive: true }); else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }
  }
}
export function avdName(config) { const m = config.image.match(/android-(\d+)/); if (!m || !/^[a-zA-Z0-9_-]{1,40}$/.test(config.avdName)) throw new Error('Android端末名・バージョンを確認してください'); return `${config.avdName}_api${m[1]}`; }
export function shellQuote(text) { return `'${String(text).replace(/'/g, `'\\''`)}'`; }
