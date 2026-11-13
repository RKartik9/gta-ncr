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
 * Shares the main thread between a long job and the picture. The job checks `due` inside its loops and awaits
 * `wait()` when it is: the job then carries on in the next frame, so no single frame is held for long.
 */
export class Budget {
  /** milliseconds the job may run before it should give the frame back */
  ms: number;
  /** the longest the job has held the main thread in one go, ms */
  worst = 0;
  private start = performance.now();

  constructor(ms: number) {
    this.ms = ms;
  }

  get due() {
    return performance.now() - this.start > this.ms;
  }

  /** The job is starting again after a pause of its own (a download, say). */
  restart() {
    this.start = performance.now();
  }

  /** The job has finished, or reached a point where it stops holding the frame. */
  done() {
    this.worst = Math.max(this.worst, performance.now() - this.start);
  }

  async wait() {
    this.done();
    await new Promise(requestAnimationFrame);
    this.restart();
  }
}

/** localStorage that never throws: blocked storage (private windows) just means nothing is remembered. */
export function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: lasts until reload
  }
}
