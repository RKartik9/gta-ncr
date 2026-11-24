// Re-encodes every texture in a .glb as WebP, no bigger than [max] pixels a side: node tools/dev/webp-glb.mjs in.glb out.glb [max]
// Sketchfab models ship 4K PNGs; a car on screen wants a fraction of that, and WebP is a fifth the bytes.
// ponytail: needs cwebp and macOS's sips on the PATH (brew install webp).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [src, dst, max = '2048'] = process.argv.slice(2);
if (!src || !dst) throw new Error('usage: node tools/dev/webp-glb.mjs in.glb out.glb [max]');
const file = readFileSync(src);
if (file.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a .glb');
const jsonLength = file.readUInt32LE(12);
const json = JSON.parse(file.toString('utf8', 20, 20 + jsonLength));
const bin = file.subarray(20 + jsonLength + 8, 20 + jsonLength + 8 + file.readUInt32LE(20 + jsonLength));

const dir = mkdtempSync(join(tmpdir(), 'webp-glb-'));
const webp = new Map(); // bufferView index -> its WebP bytes
for (const [i, image] of (json.images ?? []).entries()) {
  if (image.bufferView === undefined || image.mimeType === 'image/webp') continue;
  const v = json.bufferViews[image.bufferView], from = v.byteOffset ?? 0;
  const inPath = join(dir, `${i}.img`), outPath = join(dir, `${i}.webp`);
  writeFileSync(inPath, bin.subarray(from, from + v.byteLength));
  const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', inPath], { encoding: 'utf8' });
  const [w, h] = [/pixelWidth: (\d+)/, /pixelHeight: (\d+)/].map((r) => Number(r.exec(dims)?.[1] ?? 0));
  const scale = Math.min(1, Number(max) / Math.max(w, h, 1));
  const resize = scale < 1 ? ['-resize', String(Math.round(w * scale)), String(Math.round(h * scale))] : [];
  execFileSync('cwebp', ['-quiet', '-q', '85', '-alpha_q', '90', ...resize, inPath, '-o', outPath]);
  const bytes = readFileSync(outPath);
  if (bytes.length >= v.byteLength && scale === 1) continue; // already small: leave it be
  webp.set(image.bufferView, bytes);
  image.mimeType = 'image/webp';
}
rmSync(dir, { recursive: true });

// The textures point at the WebP through the extension; three.js reads it.
for (const t of json.textures ?? []) {
  if (t.source === undefined || json.images[t.source].mimeType !== 'image/webp') continue;
  t.extensions = { ...t.extensions, EXT_texture_webp: { source: t.source } };
  delete t.source;
}
json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), 'EXT_texture_webp'])];
json.extensionsRequired = [...new Set([...(json.extensionsRequired ?? []), 'EXT_texture_webp'])];

// The binary again, every view carried over or swapped for its WebP.
const chunks = [];
let length = 0;
json.bufferViews = json.bufferViews.map((v, i) => {
  const from = v.byteOffset ?? 0;
  const bytes = webp.get(i) ?? bin.subarray(from, from + v.byteLength);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
  bytes.copy(padded);
  chunks.push(padded);
  const out = { ...v, buffer: 0, byteOffset: length, byteLength: bytes.length };
  length += padded.length;
  return out;
});
json.buffers = [{ byteLength: length }];

const text = Buffer.from(JSON.stringify(json));
const head = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
text.copy(head);
const out = Buffer.alloc(12 + 8 + head.length + 8 + length);
out.write('glTF', 0, 'latin1');
out.writeUInt32LE(2, 4);
out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(head.length, 12);
out.write('JSON', 16, 'latin1');
head.copy(out, 20);
out.writeUInt32LE(length, 20 + head.length);
out.write('BIN\0', 24 + head.length, 'latin1');
Buffer.concat(chunks).copy(out, 28 + head.length);
writeFileSync(dst, out);
console.log(`${webp.size} textures to WebP, ${(file.length / 1e6).toFixed(1)} MB -> ${(out.length / 1e6).toFixed(1)} MB`);
