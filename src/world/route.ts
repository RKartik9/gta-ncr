import type { Road } from './tile.ts';

/** A point on a road segment: which segment, and how far along it. */
interface Snap {
  /** the segment runs from a to b; a one-way segment may only be driven that way */
  a: number;
  b: number;
  oneway: boolean;
  /** 0 at a, 1 at b */
  t: number;
  x: number;
  z: number;
  distance: number;
}

const BUCKET = 100;

/**
 * Every drivable road in the map as a graph, for the GPS. OpenStreetMap ways share their junction nodes,
 * so two roads meet wherever they have a point in common. One-way streets are followed one way only.
 */
export class RoadGraph {
  private ids = new Map<string, number>();
  private xs: number[] = [];
  private zs: number[] = [];
  private adj: number[][] = []; // flat [to, metres, to, metres, ...] per node
  private segs: [number, number, boolean][] = [];
  private buckets = new Map<string, number[]>();

  constructor(roads: Road[]) {
    const node = (x: number, z: number) => {
      const key = `${x},${z}`;
      let id = this.ids.get(key);
      if (id === undefined) {
        id = this.xs.length;
        this.ids.set(key, id);
        this.xs.push(x);
        this.zs.push(z);
        this.adj.push([]);
      }
      return id;
    };
    for (const r of roads) {
      for (let i = 0; i + 3 < r.pts.length; i += 2) {
        const a = node(r.pts[i], r.pts[i + 1]), b = node(r.pts[i + 2], r.pts[i + 3]);
        if (a === b) continue;
        const w = Math.hypot(this.xs[b] - this.xs[a], this.zs[b] - this.zs[a]);
        this.adj[a].push(b, w);
        if (!r.oneway) this.adj[b].push(a, w);
        const s = this.segs.push([a, b, r.oneway]) - 1;
        // file the segment under every bucket its box touches, for quick nearest-road lookups
        for (let bx = Math.floor(Math.min(this.xs[a], this.xs[b]) / BUCKET); bx <= Math.floor(Math.max(this.xs[a], this.xs[b]) / BUCKET); bx++) {
          for (let bz = Math.floor(Math.min(this.zs[a], this.zs[b]) / BUCKET); bz <= Math.floor(Math.max(this.zs[a], this.zs[b]) / BUCKET); bz++) {
            const k = `${bx},${bz}`;
            const list = this.buckets.get(k);
            if (list) list.push(s);
            else this.buckets.set(k, [s]);
          }
        }
      }
    }
  }

  /** Closest point on any road, searching outward ring by ring. */
  nearest(x: number, z: number): Snap | null {
    const cx = Math.floor(x / BUCKET), cz = Math.floor(z / BUCKET);
    let best: Snap | null = null;
    for (let ring = 0; ring < 30; ring++) {
      for (let bx = cx - ring; bx <= cx + ring; bx++) {
        for (let bz = cz - ring; bz <= cz + ring; bz++) {
          if (Math.max(Math.abs(bx - cx), Math.abs(bz - cz)) !== ring) continue;
          for (const s of this.buckets.get(`${bx},${bz}`) ?? []) {
            const [a, b, oneway] = this.segs[s];
            const ax = this.xs[a], az = this.zs[a], dx = this.xs[b] - ax, dz = this.zs[b] - az;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
            const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
            if (!best || d < best.distance) best = { a, b, oneway, t, x: px, z: pz, distance: d };
          }
        }
      }
      // anything in a further ring is at least `ring` buckets away
      const found = best as Snap | null;
      if (found && found.distance < ring * BUCKET) break;
    }
    return best;
  }

  /**
   * Shortest drive from one point to another, as a flat [x, z, ...] polyline that starts and ends on the road.
   * One-way streets are respected all the way, including the stretch the car starts on and the one it ends on.
   */
  route(fromX: number, fromZ: number, toX: number, toZ: number): number[] | null {
    const s = this.nearest(fromX, fromZ), g = this.nearest(toX, toZ);
    if (!s || !g) return null;
    // start and goal on the same piece of road, and allowed to drive straight there
    if (s.a === g.a && s.b === g.b && (!s.oneway || g.t >= s.t)) return [s.x, s.z, g.x, g.z];
    const n = this.xs.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = new Heap();
    // leave the start segment forwards, or backwards too where it is two-way
    for (const v of s.oneway ? [s.b] : [s.a, s.b]) {
      const d = Math.hypot(this.xs[v] - s.x, this.zs[v] - s.z);
      if (d < dist[v]) {
        dist[v] = d;
        heap.push(v, d);
      }
    }
    // reaching either end of the goal's segment finishes the trip along it
    // enter the goal segment from its start, or from its end too where it is two-way
    const tail = new Map((g.oneway ? [g.a] : [g.a, g.b]).map((v) => [v, Math.hypot(this.xs[v] - g.x, this.zs[v] - g.z)]));
    let end = -1, best = Infinity;
    while (heap.size) {
      const [u, du] = heap.pop();
      if (du > dist[u]) continue;
      if (du >= best) break;
      const t = tail.get(u);
      if (t !== undefined && du + t < best) {
        best = du + t;
        end = u;
      }
      const edges = this.adj[u];
      for (let i = 0; i < edges.length; i += 2) {
        const v = edges[i], dv = du + edges[i + 1];
        if (dv < dist[v]) {
          dist[v] = dv;
          prev[v] = u;
          heap.push(v, dv);
        }
      }
    }
    if (end < 0) return null;
    // walk back from the goal, then turn it round
    const back: [number, number][] = [[g.x, g.z]];
    for (let v = end; v >= 0; v = prev[v]) back.push([this.xs[v], this.zs[v]]);
    back.push([s.x, s.z]);
    return back.reverse().flat();
  }
}

/** Length of a flat [x, z, ...] polyline in metres. */
export function pathLength(p: number[]) {
  let len = 0;
  for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return len;
}

/** Distance from a point to a flat [x, z, ...] polyline. */
export function distanceToPath(p: number[], x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/** Binary min-heap of (node, cost). */
class Heap {
  private nodes: number[] = [];
  private costs: number[] = [];
  get size() {
    return this.nodes.length;
  }
  push(node: number, cost: number) {
    const { nodes, costs } = this;
    let i = nodes.length;
    nodes.push(node);
    costs.push(cost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (costs[p] <= cost) break;
      nodes[i] = nodes[p];
      costs[i] = costs[p];
      i = p;
    }
    nodes[i] = node;
    costs[i] = cost;
  }
  pop(): [number, number] {
    const { nodes, costs } = this;
    const top: [number, number] = [nodes[0], costs[0]];
    const node = nodes.pop()!, cost = costs.pop()!;
    if (nodes.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mc = cost;
        if (l < nodes.length && costs[l] < mc) [m, mc] = [l, costs[l]];
        if (r < nodes.length && costs[r] < mc) [m, mc] = [r, costs[r]];
        if (m === i) break;
        nodes[i] = nodes[m];
        costs[i] = costs[m];
        i = m;
      }
      nodes[i] = node;
      costs[i] = cost;
    }
    return top;
  }
}
