/** Small deterministic random generator, so the city looks the same on every load. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash01(n: number) {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent smoothing factor. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Signed area of a flat [x0, z0, x1, z1, ...] ring. */
export function ringArea(r: ArrayLike<number>) {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
}

export function pointInRing(x: number, z: number, r: ArrayLike<number>) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    if (r[i + 1] > z !== r[j + 1] > z && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
  }
  return inside;
}

const cache = new Map<string, unknown>();
const shared = new WeakSet<object>();
/**
 * Made once, shared by every map cell: textures, materials and prop geometry.
 * Unloading a cell must leave these alone; `isShared` tells it which.
 */
export function cached<T extends object>(key: string, make: () => T): T {
  let v = cache.get(key) as T | undefined;
  if (!v) {
    v = make();
    cache.set(key, v);
    shared.add(v);
  }
  return v;
}
export const isShared = (o: object) => shared.has(o);

/**
 * Lets the renderer skip an instanced mesh that is off screen or outside a shadow cascade, which with several
 * map cells loaded is most of them. Bounds cover every instance, padded for furniture that gets knocked about.
 */
export function cullable(mesh: { computeBoundingSphere(): void; boundingSphere: { radius: number } | null; frustumCulled: boolean }) {
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) mesh.boundingSphere.radius += 25;
  mesh.frustumCulled = true;
}
