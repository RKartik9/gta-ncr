// Thins a heavy .glb before it goes through the garage importer: node tools/dev/slim-glb.mjs in.glb out.glb [triangles]
// Scanned and AI-generated models arrive with a million triangles; a car in this game wants about a hundred thousand.
// Every indexed triangle mesh is simplified by the same share; textures and everything else pass through untouched.
// ponytail: .glb only, and meshoptimizer comes in with @types/three rather than being listed in package.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

const [src, dst, wanted = '120000'] = process.argv.slice(2);
if (!src || !dst) throw new Error('usage: node tools/dev/slim-glb.mjs in.glb out.glb [triangles]');
const file = readFileSync(src);
if (file.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a .glb');
const jsonLength = file.readUInt32LE(12);
const json = JSON.parse(file.toString('utf8', 20, 20 + jsonLength));
const bin = file.subarray(20 + jsonLength + 8, 20 + jsonLength + 8 + file.readUInt32LE(20 + jsonLength));
if (json.extensionsRequired?.some((e) => /draco|meshopt/i.test(e))) throw new Error('compressed geometry: export it without Draco or meshopt');

const BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const size = (a) => BYTES[a.componentType] * COUNT[a.type];
/** The accessor's elements, tightly packed. */
const read = (a) => {
  const view = json.bufferViews[a.bufferView], n = size(a), stride = view.byteStride || n;
  const out = Buffer.alloc(a.count * n), from = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let i = 0; i < a.count; i++) bin.copy(out, i * n, from + i * stride, from + i * stride + n);
  return out;
};

const prims = json.meshes.flatMap((m) => m.primitives).filter((p) => (p.mode ?? 4) === 4 && p.indices !== undefined && !p.targets && json.accessors[p.attributes.POSITION].componentType === 5126);
const before = prims.reduce((n, p) => n + json.accessors[p.indices].count / 3, 0);
const share = Math.min(1, Number(wanted) / before);

await MeshoptSimplifier.ready;
const fresh = new Map(); // accessor index -> its new bytes
let after = 0;
for (const p of prims) {
  const ia = json.accessors[p.indices], raw = read(ia);
  const index = Uint32Array.from({ length: ia.count }, (_, i) => (ia.componentType === 5125 ? raw.readUInt32LE(i * 4) : ia.componentType === 5123 ? raw.readUInt16LE(i * 2) : raw[i]));
  const pa = json.accessors[p.attributes.POSITION], pos = read(pa);
  const positions = new Float32Array(pos.buffer, pos.byteOffset, pa.count * 3);
  const [slim] = MeshoptSimplifier.simplify(index, positions, 3, Math.floor((index.length * share) / 3) * 3, 0.02);
  const [remap, kept] = MeshoptSimplifier.compactMesh(slim);
  after += slim.length / 3;
  for (const i of new Set(Object.values(p.attributes))) {
    if (fresh.has(i)) throw new Error('two meshes share one set of vertices: not handled');
    const a = json.accessors[i], n = size(a), old = read(a), out = Buffer.alloc(kept * n);
    for (let v = 0; v < a.count; v++) if (remap[v] !== 0xffffffff) old.copy(out, remap[v] * n, v * n, v * n + n);
    a.count = kept;
    if (i === p.attributes.POSITION) {
      const f = new Float32Array(out.buffer, out.byteOffset, kept * 3);
      a.min = [0, 1, 2].map((k) => f.reduce((m, x, j) => (j % 3 === k ? Math.min(m, x) : m), Infinity));
      a.max = [0, 1, 2].map((k) => f.reduce((m, x, j) => (j % 3 === k ? Math.max(m, x) : m), -Infinity));
    }
    fresh.set(i, { bytes: out, vertex: true });
  }
  ia.componentType = 5125;
  ia.count = slim.length;
  delete ia.min;
  delete ia.max;
  fresh.set(p.indices, { bytes: Buffer.from(slim.buffer, slim.byteOffset, slim.byteLength), vertex: false });
}

// The file again: the views nobody rewrote are carried over, the rewritten accessors get views of their own.
const chunks = [], views = [];
let length = 0;
const push = (bytes, view) => {
  views.push({ ...view, buffer: 0, byteOffset: length, byteLength: bytes.length });
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
  bytes.copy(padded);
  chunks.push(padded);
  length += padded.length;
  return views.length - 1;
};
const carried = new Map();
const carry = (i) => {
  if (!carried.has(i)) {
    const v = json.bufferViews[i];
    carried.set(i, push(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength), v));
  }
  return carried.get(i);
};
json.accessors.forEach((a, i) => {
  const f = fresh.get(i);
  if (!f) return a.bufferView !== undefined && (a.bufferView = carry(a.bufferView));
  // a vertex attribute's elements must start on a four-byte boundary
  const n = size(a), stride = Math.ceil(n / 4) * 4;
  let bytes = f.bytes;
  if (f.vertex && stride !== n) {
    bytes = Buffer.alloc(a.count * stride);
    for (let v = 0; v < a.count; v++) f.bytes.copy(bytes, v * stride, v * n, v * n + n);
  }
  a.bufferView = push(bytes, f.vertex ? { target: 34962, ...(stride !== n && { byteStride: stride }) } : { target: 34963 });
  delete a.byteOffset;
});
for (const image of json.images ?? []) if (image.bufferView !== undefined) image.bufferView = carry(image.bufferView);
json.bufferViews = views;
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
console.log(`${Math.round(before)} triangles -> ${after}, ${(file.length / 1e6).toFixed(1)} MB -> ${(out.length / 1e6).toFixed(1)} MB`);
