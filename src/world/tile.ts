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
}

export interface Area {
  id: number;
  kind: 'green' | 'water';
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
  /** centre of the Connaught Place central park, where the flag flies */
  plaza: [number, number];
  /** `${col}_${row}` of every cell that has anything in it */
  cells: string[];
}

export async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}tiles/${path}.json`);
  if (!res.ok) throw new Error(`tiles/${path}: HTTP ${res.status}`);
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
