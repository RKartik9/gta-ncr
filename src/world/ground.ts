import * as THREE from 'three/webgpu';
import type { Road, Tile } from './tile.ts';
import { GeoBuilder, polygon, ribbon } from './geo.ts';
import type { Chunks } from './chunks.ts';
import { type Budget, cached } from '../util.ts';
import { asphaltTexture, grassTexture, groundTexture, pavementTexture } from '../render/textures.ts';

const Y = { grass: 0.015, path: 0.025, pavement: 0.035, road: 0.05, marking: 0.062 };

/** Roads that carry through traffic: these get pavements, lane markings, street trees and lamps. */
export const isStreet = (r: Road) => r.kind !== 'service' && r.kind !== 'living_street';
export const isMajor = (r: Road) => r.kind.startsWith('secondary') || r.kind.startsWith('tertiary') || r.kind.startsWith('primary') || r.kind.startsWith('trunk');

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
  const at = (s: number, offset: number): [number, number] => {
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const len = cum[i] - cum[i - 1] || 1;
    const t = (s - cum[i - 1]) / len;
    const dx = (p[i * 2] - p[i * 2 - 2]) / len, dz = (p[i * 2 + 1] - p[i * 2 - 1]) / len;
    return [p[i * 2 - 2] + (p[i * 2] - p[i * 2 - 2]) * t - dz * offset, p[i * 2 - 1] + (p[i * 2 + 1] - p[i * 2 - 1]) * t + dx * offset];
  };
  for (const st of list) {
    const step = st.gap === 0 ? 2 : st.dash;
    for (let s = 0; s + step <= total; s += step + st.gap) {
      const mid = s + step / 2;
      if (gaps.some(([c, r]) => Math.abs(mid - c) < r)) continue;
      const [ax, az] = at(s, st.offset);
      const [bx, bz] = at(s + step, st.offset);
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / len) * (st.width / 2), nz = ((bx - ax) / len) * (st.width / 2);
      const v0 = b.vert(ax + nx, Y.marking, az + nz, 0, 1, 0, 0, 0);
      const v1 = b.vert(ax - nx, Y.marking, az - nz, 0, 1, 0, 1, 0);
      const v2 = b.vert(bx + nx, Y.marking, bz + nz, 0, 1, 0, 0, 1);
      const v3 = b.vert(bx - nx, Y.marking, bz - nz, 0, 1, 0, 1, 1);
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

export async function buildGround(tile: Tile, chunks: Chunks, budget: Budget) {
  const grass = new GeoBuilder();
  const water = new GeoBuilder();
  for (const a of tile.areas) {
    if (a.outer.length < 6) continue;
    polygon(a.kind === 'water' ? water : grass, a.outer, [], Y.grass, a.kind === 'water' ? 30 : 9);
    if (budget.due) await budget.wait();
  }

  const pavement = new GeoBuilder();
  const asphalt = new GeoBuilder();
  const paint = new GeoBuilder();
  const junctions = findJunctions(tile.roads);
  for (const p of tile.paths) ribbon(pavement, p.pts, p.width, Y.path, 4, false);
  for (const r of tile.roads) {
    if (isStreet(r)) ribbon(pavement, r.pts, r.width + 4.4, Y.pavement, 4, true);
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
  await add(water, cached('m-water', () => new THREE.MeshStandardMaterial({ color: 0x4a5d58, roughness: 0.15, metalness: 0.2 })), 1, 'water');
  await add(pavement, cached('m-pavement', () => new THREE.MeshStandardMaterial({ map: pavementTexture(), roughness: 0.9 })), 2, 'pavement');
  await add(asphalt, cached('m-asphalt', () => new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.82, metalness: 0 })), 3, 'asphalt');
  await add(paint, cached('m-paint', () => new THREE.MeshStandardMaterial({ color: 0xd9d6cb, roughness: 0.7 })), 4, 'markings');
}
