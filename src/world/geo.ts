import * as THREE from 'three/webgpu';

/** Accumulates vertices for one merged mesh; a whole layer of the city becomes a single draw call. */
export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  private useColour: boolean;

  constructor(useColour = false) {
    this.useColour = useColour;
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r = 1, g = 1, b = 1) {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    if (this.useColour) this.col.push(r, g, b);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  /** Triangle on a flat, upward-facing surface: winds itself so the face points up. */
  triUp(a: number, b: number, c: number) {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vz = p[c * 3 + 2] - p[a * 3 + 2];
    if (uz * vx - ux * vz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.useColour) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Flat ribbon of constant width along a polyline, with mitred joins and round ends. */
export function ribbon(b: GeoBuilder, pts: ArrayLike<number>, width: number, y: number, uvScale: number, roundEnds: boolean) {
  const n = pts.length / 2;
  if (n < 2) return;
  const half = width / 2;
  let prevL = -1, prevR = -1;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    const ax = i > 0 ? x - pts[i * 2 - 2] : pts[i * 2 + 2] - x;
    const az = i > 0 ? z - pts[i * 2 - 1] : pts[i * 2 + 3] - z;
    const bx = i < n - 1 ? pts[i * 2 + 2] - x : ax;
    const bz = i < n - 1 ? pts[i * 2 + 3] - z : az;
    const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
    // average of the two segment normals, lengthened so the ribbon keeps its width through the bend
    let nx = -az / al - bz / bl, nz = ax / al + bx / bl;
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-4) {
      nx = -az / al;
      nz = ax / al;
    } else {
      nx /= nl;
      nz /= nl;
    }
    const cos = nx * (-az / al) + nz * (ax / al);
    const m = half / Math.max(0.5, cos);
    const lx = x + nx * m, lz = z + nz * m, rx = x - nx * m, rz = z - nz * m;
    const l = b.vert(lx, y, lz, 0, 1, 0, lx / uvScale, lz / uvScale);
    const r = b.vert(rx, y, rz, 0, 1, 0, rx / uvScale, rz / uvScale);
    if (i > 0) {
      b.triUp(prevL, prevR, l);
      b.triUp(prevR, r, l);
    }
    prevL = l;
    prevR = r;
  }
  if (roundEnds) {
    disc(b, pts[0], pts[1], half, y, uvScale);
    disc(b, pts[n * 2 - 2], pts[n * 2 - 1], half, y, uvScale);
  }
}

export function disc(b: GeoBuilder, x: number, z: number, radius: number, y: number, uvScale: number, segments = 14) {
  const c = b.vert(x, y, z, 0, 1, 0, x / uvScale, z / uvScale);
  let prev = -1, first = -1;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const px = x + Math.cos(a) * radius, pz = z + Math.sin(a) * radius;
    const v = b.vert(px, y, pz, 0, 1, 0, px / uvScale, pz / uvScale);
    if (i === 0) first = v;
    else b.triUp(c, prev, v);
    prev = v;
  }
  b.triUp(c, prev, first);
}

/** Triangulated flat polygon (with optional holes) at height y. */
export function polygon(b: GeoBuilder, outer: ArrayLike<number>, holes: ArrayLike<number>[], y: number, uvScale: number, r = 1, g = 1, bl = 1) {
  const toVec = (ring: ArrayLike<number>) => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < ring.length; i += 2) out.push(new THREE.Vector2(ring[i], ring[i + 1]));
    return out;
  };
  const contour = toVec(outer);
  const holeVecs = holes.map(toVec);
  const tris = THREE.ShapeUtils.triangulateShape(contour, holeVecs);
  const all = contour.concat(...holeVecs);
  const base = b.count;
  for (const p of all) b.vert(p.x, y, p.y, 0, 1, 0, p.x / uvScale, p.y / uvScale, r, g, bl);
  for (const t of tris) b.triUp(base + t[0], base + t[1], base + t[2]);
  return { base, tris, points: all };
}
