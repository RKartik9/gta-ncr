import * as THREE from 'three/webgpu';
import type { Road, Tile } from './tile.ts';
import { GeoBuilder, polygon, ribbon } from './geo.ts';
import type { Chunks } from './chunks.ts';
import { type Budget, cached } from '../util.ts';
import { asphaltTexture, grassTexture, groundTexture, pavementTexture } from '../render/textures.ts';

const Y = { grass: 0.015, path: 0.025, pavement: 0.035, road: 0.05, marking: 0.062 };
/** The tarmac is drawn this far above the flat ground the physics knows; the car is drawn raised by as much, or its tyres sink into the road. */
export const ROAD_HEIGHT = Y.road;

/** Roads that carry through traffic: these get pavements, lane markings, street trees and lamps. */
export const isStreet = (r: Road) => r.kind !== 'service' && r.kind !== 'living_street';
/** a road up on a flyover deck: no pavement, kerbside trees, lamps or people, and no traffic */
export const isRaised = (r: Road) => !!r.elev;
export const isMajor = (r: Road) => r.kind.startsWith('secondary') || r.kind.startsWith('tertiary') || r.kind.startsWith('primary') || r.kind.startsWith('trunk') || r.kind.startsWith('motorway');
/** Streets with a pavement, kerbside trees, bins and people on foot: not an expressway such as the Sea Link or the Coastal Road, out over the water. */
export const hasPavement = (r: Road) => isStreet(r) && !r.kind.startsWith('motorway') && !r.elev;

const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;

/** Points where three or more street arms meet. Lane markings stop short of these. */
function findJunctions(roads: Road[]) {
  const arms = new Map<string, { n: number; width: number }>();
  for (const r of roads) {
    if (!isStreet(r)) continue;
    const n = r.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const k = key(r.pts[i * 2], r.pts[i * 2 + 1]);
      const e = arms.get(k) ?? { n: 0, width: 0 };
      e.n += i === 0 || i === n - 1 ? 1 : 2;
      e.width = Math.max(e.width, r.width);
      arms.set(k, e);
    }
  }
  return arms;
}

interface Stripe {
  offset: number;
  dash: number;
  gap: number;
  width: number;
}

function stripes(road: Road): Stripe[] {
  if (!isMajor(road)) return road.kind === 'residential' && road.width >= 6.5 && road.name ? [{ offset: 0, dash: 3, gap: 6, width: 0.12 }] : [];
  const out: Stripe[] = [];
  const half = road.width / 2;
  const lanes = Math.max(1, Math.round(road.lanes));
  const laneWidth = (road.width - 0.6) / lanes;
  for (let i = 1; i < lanes; i++) {
    const offset = -half + 0.3 + laneWidth * i;
    // the centre of a two-way road is a solid line; the rest are lane dashes
    const centre = !road.oneway && Math.abs(offset) < 0.2;
    out.push(centre ? { offset, dash: 4, gap: 0, width: 0.2 } : { offset, dash: 3, gap: 4.5, width: 0.13 });
  }
  out.push({ offset: -half + 0.25, dash: 4, gap: 0, width: 0.13 }, { offset: half - 0.25, dash: 4, gap: 0, width: 0.13 });
  return out;
}

function paintStripes(b: GeoBuilder, road: Road, junctions: Map<string, { n: number; width: number }>) {
  const list = stripes(road);
  if (!list.length) return;
  const p = road.pts;
  const n = p.length / 2;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]));
  const total = cum[n - 1];
  const gaps: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const j = junctions.get(key(p[i * 2], p[i * 2 + 1]));
    if (j && j.n >= 3) gaps.push([cum[i], j.width / 2 + 2.5]);
  }
  const lift = road.elev;
  const at = (s: number, offset: number): [number, number, number] => {
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const len = cum[i] - cum[i - 1] || 1;
    const t = (s - cum[i - 1]) / len;
    const dx = (p[i * 2] - p[i * 2 - 2]) / len, dz = (p[i * 2 + 1] - p[i * 2 - 1]) / len;
    // on a flyover the paint rides on the deck
    const y = Y.marking + (lift ? lift[i - 1] + (lift[i] - lift[i - 1]) * t : 0);
    return [p[i * 2 - 2] + (p[i * 2] - p[i * 2 - 2]) * t - dz * offset, p[i * 2 - 1] + (p[i * 2 + 1] - p[i * 2 - 1]) * t + dx * offset, y];
  };
  for (const st of list) {
    const step = st.gap === 0 ? 2 : st.dash;
    for (let s = 0; s + step <= total; s += step + st.gap) {
      const mid = s + step / 2;
      if (gaps.some(([c, r]) => Math.abs(mid - c) < r)) continue;
      const [ax, az, ay] = at(s, st.offset);
      const [bx, bz, by] = at(s + step, st.offset);
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / len) * (st.width / 2), nz = ((bx - ax) / len) * (st.width / 2);
      const v0 = b.vert(ax + nx, ay, az + nz, 0, 1, 0, 0, 0);
      const v1 = b.vert(ax - nx, ay, az - nz, 0, 1, 0, 1, 0);
      const v2 = b.vert(bx + nx, by, bz + nz, 0, 1, 0, 0, 1);
      const v3 = b.vert(bx - nx, by, bz - nz, 0, 1, 0, 1, 1);
      b.triUp(v0, v1, v2);
      b.triUp(v1, v3, v2);
    }
  }
}

/** The bare plain under the whole map; it runs well past the edge so the horizon is never an edge. */
export function buildBasePlane(bounds: Tile['bounds']) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const pad = 2500;
  const base = new GeoBuilder();
  const corners = [
    [minX - pad, minZ - pad], [maxX + pad, minZ - pad], [minX - pad, maxZ + pad], [maxX + pad, maxZ + pad],
  ].map(([x, z]) => base.vert(x, 0, z, 0, 1, 0, x / 14, z / 14));
  base.triUp(corners[0], corners[1], corners[2]);
  base.triUp(corners[1], corners[3], corners[2]);
  const baseMesh = new THREE.Mesh(base.build(), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96, metalness: 0 }));
  baseMesh.receiveShadow = true;
  baseMesh.name = 'base-plane';
  return baseMesh;
}

/** Deck depth under the road surface, parapet height above it, and the spacing of the piers, in metres. */
const DECK = 1.2, PARAPET = 0.9, PIER_EVERY = 28;

/**
 * A flyover: its road surface at the heights the bake gave, a concrete slab under it with a parapet either side,
 * and a pier every 28 m where it stands high enough to drive under. The surface goes into `deck` (also the physics'
 * road up there), the parapets into `parapets` (walls the car is kept on by).
 */
function buildFlyover(r: Road, deck: GeoBuilder, concrete: GeoBuilder, parapets: GeoBuilder, piers: { x: number; z: number; r: number; h: number }[]) {
  const e = ribbon(deck, r.pts, r.width, Y.road, 17, false, r.elev);
  const h = r.elev!;
  const quad = (g: GeoBuilder, a: number[], b: number[], c: number[], d: number[]) => {
    const v = [a, b, c, d].map(([x, y, z]) => g.vert(x, y, z, 0, 1, 0, x / 4, y / 4));
    g.tri(v[0], v[1], v[2]);
    g.tri(v[0], v[2], v[3]);
  };
  let carry = PIER_EVERY / 2;
  for (let i = 0; i + 1 < h.length; i++) {
    const [l0x, l0z, r0x, r0z] = e.slice(i * 4, i * 4 + 4), [l1x, l1z, r1x, r1z] = e.slice(i * 4 + 4, i * 4 + 8);
    const y0 = h[i] + Y.road, y1 = h[i + 1] + Y.road;
    // the slab's two faces and its underside, then the parapets standing on its edges
    quad(concrete, [l0x, y0 - DECK, l0z], [l1x, y1 - DECK, l1z], [l1x, y1 + PARAPET, l1z], [l0x, y0 + PARAPET, l0z]);
    quad(concrete, [r0x, y0 - DECK, r0z], [r1x, y1 - DECK, r1z], [r1x, y1 + PARAPET, r1z], [r0x, y0 + PARAPET, r0z]);
    quad(concrete, [l0x, y0 - DECK, l0z], [r0x, y0 - DECK, r0z], [r1x, y1 - DECK, r1z], [l1x, y1 - DECK, l1z]);
    if (Math.min(y0, y1) > 1) {
      quad(parapets, [l0x, y0, l0z], [l1x, y1, l1z], [l1x, y1 + PARAPET, l1z], [l0x, y0 + PARAPET, l0z]);
      quad(parapets, [r0x, y0, r0z], [r1x, y1, r1z], [r1x, y1 + PARAPET, r1z], [r0x, y0 + PARAPET, r0z]);
    }
    const ax = r.pts[i * 2], az = r.pts[i * 2 + 1], bx = r.pts[i * 2 + 2], bz = r.pts[i * 2 + 3];
    const len = Math.hypot(bx - ax, bz - az);
    for (let s = carry; s < len; s += PIER_EVERY) {
      const t = s / len, y = y0 + (y1 - y0) * t - DECK;
      if (y < 3.5) continue;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, w = 0.8;
      for (const [dx0, dz0, dx1, dz1] of [[-w, -w, w, -w], [w, -w, w, w], [w, w, -w, w], [-w, w, -w, -w]]) quad(concrete, [x + dx0, 0, z + dz0], [x + dx1, 0, z + dz1], [x + dx1, y, z + dz1], [x + dx0, y, z + dz0]);
      piers.push({ x, z, r: w, h: y });
    }
    carry = ((carry - len) % PIER_EVERY + PIER_EVERY) % PIER_EVERY;
  }
}

export async function buildGround(tile: Tile, chunks: Chunks, budget: Budget) {
  const grass = new GeoBuilder();
  const water = new GeoBuilder();
  const sand = new GeoBuilder();
  for (const a of tile.areas) {
    if (a.outer.length < 6) continue;
    polygon(a.kind === 'water' ? water : a.kind === 'sand' ? sand : grass, a.outer, [], Y.grass, a.kind === 'water' ? 30 : 9);
    if (budget.due) await budget.wait();
  }

  const pavement = new GeoBuilder();
  const asphalt = new GeoBuilder();
  const paint = new GeoBuilder();
  const junctions = findJunctions(tile.roads);
  for (const p of tile.paths) ribbon(pavement, p.pts, p.width, Y.path, 4, false);
  const deck = new GeoBuilder();
  const concrete = new GeoBuilder();
  const parapets = new GeoBuilder();
  const piers: { x: number; z: number; r: number; h: number }[] = [];
  for (const r of tile.roads) {
    if (r.elev) {
      buildFlyover(r, deck, concrete, parapets, piers);
      paintStripes(paint, r, junctions);
      continue;
    }
    if (hasPavement(r)) ribbon(pavement, r.pts, r.width + 4.4, Y.pavement, 4, true);
    ribbon(asphalt, r.pts, r.width, Y.road, 17, true);
    paintStripes(paint, r, junctions);
    if (budget.due) await budget.wait();
  }

  const add = async (b: GeoBuilder, material: THREE.Material, offset: number, name: string) => {
    if (!b.count) return;
    // Coplanar layers a few centimetres apart: the offset stops them flickering at a distance.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -offset;
    material.polygonOffsetUnits = -offset * 4;
    chunks.addLayer(b, material, name, false);
    if (budget.due) await budget.wait();
  };
  await add(grass, cached('m-grass', () => new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 0.95 })), 1, 'grass');
  await add(sand, cached('m-sand', () => new THREE.MeshStandardMaterial({ map: groundTexture(), color: 0xe8d4a6, roughness: 1 })), 1, 'sand');
  await add(water, cached('m-water', () => new THREE.MeshStandardMaterial({ color: 0x24525e, roughness: 0.5, metalness: 0 })), 1, 'water');
  await add(pavement, cached('m-pavement', () => new THREE.MeshStandardMaterial({ map: pavementTexture(), roughness: 0.9 })), 2, 'pavement');
  await add(asphalt, cached('m-asphalt', () => new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.82, metalness: 0 })), 3, 'asphalt');
  await add(deck, cached('m-asphalt', () => new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.82, metalness: 0 })), 3, 'flyover-deck');
  if (concrete.count) chunks.addLayer(concrete, cached('m-concrete', () => new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.9, side: THREE.DoubleSide })), 'flyover', true);
  await add(paint, cached('m-paint', () => new THREE.MeshStandardMaterial({ color: 0xd9d6cb, roughness: 0.7 })), 4, 'markings');
  // what the physics needs of the flyovers: the road surface up there, its parapets, and the piers
  const mesh = (b: GeoBuilder) => ({ vertices: new Float32Array(b.pos), indices: new Uint32Array(b.idx) });
  return { deck: mesh(deck), parapets: mesh(parapets), piers };
}
