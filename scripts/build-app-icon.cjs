const { nativeImage, app } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');

// Encode the existing header image as Windows ICO frames; no new artwork is drawn.
const root = resolve(__dirname, '..');
const source = 'extension/furoneko70furoneko70.png';
const image = nativeImage.createFromPath(resolve(root, source));
if (image.isEmpty()) throw new Error('猫アイコンを読み込めません');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map(size => image.resize({ width: size, height: size, quality: 'best' }).toPNG());
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
}
const target = resolve(root, 'apps/desktop/assets'); mkdirSync(target, { recursive: true });
const ico = Buffer.concat([header, ...frames]);
writeFileSync(resolve(target, 'app.ico'), ico);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
writeFileSync(resolve(target, 'app-icon-source.json'), JSON.stringify({ source, sourceSha256: hash(readFileSync(resolve(root, source))), iconSha256: hash(ico), sizes }, null, 2) + '\n');
console.log(`猫アイコンを${sizes.length}サイズのWindows ICOへ変換しました。`);
app.exit(0);
