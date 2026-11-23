import { pointInRing } from '../util.ts';

export interface Road {
  id: number;
  kind: string;
  name?: string;
  lanes: number;
  oneway: boolean;
  width: number;
  bridge: boolean;
  layer: number;
  /** flat [x0, z0, x1, z1, ...] in metres; x is east, z is south */
  pts: number[];
  /** a flyover: the deck's height above the ground at each point (absent for a road on the ground) */
  elev?: number[];
}

export interface Path {
  id: number;
  kind: string;
  width: number;
  pts: number[];
}

export interface Building {
  id: number;
  kind: string;
  name?: string;
  height: number;
  minHeight: number;
  /** true when OpenStreetMap had neither a height nor a level count and the bake had to guess */
  guessed: boolean;
  /** a tomb, gate, fort wall or other old stonework: no windows, no shopfronts */
  historic?: boolean;
  outer: number[];
  holes: number[][];
  /** edges of `outer` (edge i runs from point i to point i + 1) that carry a colonnade: Connaught Place's blocks */
  arcade?: number[];
}

export interface Area {
  id: number;
  kind: 'green' | 'water' | 'sand';
  name?: string;
  outer: number[];
}

export interface Tile {
  version: number;
  area: string;
  attribution: string;
  origin: { lat: number; lon: number };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  spawn: [number, number];
  roads: Road[];
  paths: Path[];
  buildings: Building[];
  areas: Area[];
  trees: number[];
  signals: number[];
  /** flat [x, z, ...] of OpenStreetMap barrier=bollard nodes; older tiles lack it */
  bollards?: number[];
  stats: Record<string, number>;
}

/** What a gridded area's index.json holds: the cells it was cut into, and where things are. */
export interface Grid {
  area: string;
  attribution: string;
  origin: { lat: number; lon: number };
  bounds: Tile['bounds'];
  /** metres along each side of a cell */
  cell: number;
  cols: number;
  rows: number;
  spawn: [number, number];
  /** centre of the Connaught Place central park, where the flag flies (null in the bake of a city without one) */
  plaza: [number, number];
  /** `${col}_${row}` of every cell that has anything in it */
  cells: string[];
}

export async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}tiles/${path}.json`);
  // the dev server answers a missing file with the game's own page, not a 404
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error(`the map tiles/${path}.json is missing (not baked yet?)`);
  return res.json();
}

export interface RoadHit {
  road: Road;
  x: number;
  z: number;
  /** heading of the road at that point, following the way's direction */
  heading: number;
  distance: number;
}

/** Closest point on any road in the loaded tiles that passes `accept`. */
export function nearestRoad(tiles: Tile[], x: number, z: number, accept: (r: Road) => boolean = () => true): RoadHit | null {
  let best: RoadHit | null = null;
  for (const tile of tiles) for (const road of tile.roads) {
    if (!accept(road)) continue;
    const p = road.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1];
      const dx = p[i + 2] - ax, dz = p[i + 3] - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.distance) best = { road, x: px, z: pz, heading: Math.atan2(dx, dz), distance: d };
    }
  }
  return best;
}

const boxes = new WeakMap<Area, [number, number, number, number]>();
/**
 * True where (x, z) is open water: inside a sea, lake or tank and not on a road that crosses it (the Sea Link, a
 * causeway). The car is never let in; the game holds it at the water's edge instead.
 */
export function offRoadInWater(tiles: Tile[], x: number, z: number) {
  let wet = false;
  for (const t of tiles) for (const a of t.areas) {
    if (a.kind !== 'water' || wet) continue;
    let b = boxes.get(a);
    if (!b) {
      b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < a.outer.length; i += 2) {
        b[0] = Math.min(b[0], a.outer[i]); b[1] = Math.min(b[1], a.outer[i + 1]);
        b[2] = Math.max(b[2], a.outer[i]); b[3] = Math.max(b[3], a.outer[i + 1]);
      }
      boxes.set(a, b);
    }
    if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && pointInRing(x, z, a.outer)) wet = true;
  }
  if (!wet) return false;
  const hit = nearestRoad(tiles, x, z);
  return !hit || hit.distance > hit.road.width / 2 + 1.5;
}

/** Height of the road surface at (x, z): a flyover deck's where one passes overhead within its width, otherwise the ground's 0. */
export function deckHeight(tiles: Tile[], x: number, z: number) {
  const hit = nearestRoad(tiles, x, z, (r) => !!r.elev);
  if (!hit || hit.distance > hit.road.width / 2 + 0.5) return 0;
  const p = hit.road.pts, e = hit.road.elev!;
  let best = 0, d = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1], l = dx * dx + dz * dz;
    if (!l) continue;
    const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l));
    const dd = Math.hypot(x - p[i] - dx * t, z - p[i + 1] - dz * t);
    if (dd < d) [d, best] = [dd, e[i / 2] + (e[i / 2 + 1] - e[i / 2]) * t];
  }
  return best;
}
