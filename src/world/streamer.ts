import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { type Grid, type Tile, loadJson } from './tile.ts';
import { buildGround } from './ground.ts';
import { buildBuildings } from './buildings.ts';
import { buildProps } from './props.ts';
import { addProps, syncProps } from './physics.ts';
import { Chunks } from './chunks.ts';
import { Instances } from '../render/instances.ts';
import { Budget, isShared } from '../util.ts';


interface Cell {
  key: string;
  tile: Tile;
  chunks: Chunks;
  physics: ReturnType<typeof addProps>[];
  lampHeads: THREE.Vector3[];
}

/** A cell is built this far beyond what is drawn, so it is finished before the car can see it. */
const LOAD_AHEAD = 250;

/**
 * Keeps the map cells round the car loaded, and only those: scenery, physics and minimap piece.
 * Cells are built one at a time and a few milliseconds a frame, so driving into new ground does not stall the
 * picture; of what is loaded, only the chunks near the car are drawn.
 * ponytail: building runs on the main thread; move the geometry work to a worker if a dense cell still hitches.
 */
export class Streamer {
  readonly cells = new Map<string, Cell>();
  /** every loaded cell's map data, for road lookups */
  tiles: Tile[] = [];
  /** called after a cell arrives or leaves */
  onChange: (added: Cell | null, removedKey: string | null) => void = () => {};
  /** how long building may hold each frame: generous behind the loading screen, tight while driving */
  readonly budget = new Budget(40);
  private pending = new Set<string>();
  private queue = Promise.resolve();
  private known: Set<string>;
  private grid: Grid;
  private dir: string;
  private scene: THREE.Scene;
  private world: RAPIER.World;
  private treeDensity: number;
  /** metres from the car within which scenery is drawn, and within which its close-up detail is */
  private drawDistance: number;
  private detailDistance: number;
  /** cells whose nearest edge is closer than this are loaded, and dropped again well beyond it (so a cell does not flicker at a border) */
  private loadDistance: number;

  constructor(grid: Grid, dir: string, scene: THREE.Scene, world: RAPIER.World, treeDensity: number, drawDistance: number, detailDistance: number) {
    this.drawDistance = drawDistance;
    this.detailDistance = Math.min(detailDistance, drawDistance);
    this.loadDistance = drawDistance + LOAD_AHEAD;
    this.grid = grid;
    this.dir = dir;
    this.scene = scene;
    this.world = world;
    this.treeDensity = treeDensity;
    this.known = new Set(grid.cells);
  }

  private rect(key: string) {
    const [i, j] = key.split('_').map(Number);
    const { minX, minZ } = this.grid.bounds, s = this.grid.cell;
    return { minX: minX + i * s, maxX: minX + (i + 1) * s, minZ: minZ + j * s, maxZ: minZ + (j + 1) * s };
  }

  private distance(key: string, x: number, z: number) {
    const r = this.rect(key);
    return Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));
  }

  /** Starts loading what is near (x, z) and drops what is far. Returns when everything near is in. */
  update(x: number, z: number) {
    for (const [key, cell] of this.cells) {
      // kept loaded well past where it would be loaded again, so a border does not flicker
      if (this.distance(key, x, z) > this.loadDistance + 500) this.unload(cell);
    }
    const want = [...this.known]
      .filter((k) => !this.cells.has(k) && !this.pending.has(k) && this.distance(k, x, z) < this.loadDistance)
      .sort((a, b) => this.distance(a, x, z) - this.distance(b, x, z));
    for (const key of want) {
      this.pending.add(key);
      this.queue = this.queue.then(() => this.load(key)).catch((err) => console.warn(`map cell ${key} failed to load`, err));
    }
    return this.queue;
  }

  /** Every frame: draw only the chunks near (x, z). The rest stay loaded, ready for when the car gets there. */
  cull(x: number, z: number) {
    for (const cell of this.cells.values()) cell.chunks.cull(x, z, this.drawDistance, this.detailDistance);
  }

  private async load(key: string) {
    const budget = this.budget;
    const tile = await loadJson<Tile>(`${this.dir}/${key}`);
    budget.restart();
    const chunks = new Chunks();
    chunks.group.name = `cell-${key}`;
    await buildGround(tile, chunks, budget);
    const city = await buildBuildings(tile, this.grid.plaza, chunks, budget);
    const props = await buildProps(tile, this.grid.plaza, this.treeDensity, chunks, budget);
    // the solid world goes in a piece at a time as well: one cell is thousands of bodies
    const physics: Cell['physics'] = [];
    for (const walls of city.colliders) {
      if (budget.due) await budget.wait();
      physics.push(addProps(this.world, [], [], walls));
    }
    for (let i = 0; i < props.solids.length; i += 100) {
      if (budget.due) await budget.wait();
      physics.push(addProps(this.world, props.solids.slice(i, i + 100), []));
    }
    for (const loose of props.loose) {
      if (budget.due) await budget.wait();
      physics.push(addProps(this.world, [], [loose]));
    }
    chunks.freeze();
    await budget.wait();
    const cell: Cell = { key, tile, chunks, physics, lampHeads: props.lampHeads };
    this.pending.delete(key);
    this.cells.set(key, cell);
    this.tiles = [...this.cells.values()].map((c) => c.tile);
    this.scene.add(chunks.group);
    this.onChange(cell, null);
    budget.done();
  }

  private unload(cell: Cell) {
    this.cells.delete(cell.key);
    this.tiles = [...this.cells.values()].map((c) => c.tile);
    this.scene.remove(cell.chunks.group);
    for (const p of cell.physics) p.dispose();
    cell.chunks.traverse((o) => {
      if (o instanceof Instances) o.dispose();
      else if ((o as THREE.Mesh).isMesh && !isShared((o as THREE.Mesh).geometry)) (o as THREE.Mesh).geometry.dispose();
    });
    this.onChange(null, cell.key);
  }

  /** Every physics step: copy knocked-over furniture back into the picture. */
  sync() {
    syncProps(this.world);
  }

  get awake() {
    let n = 0;
    for (const c of this.cells.values()) for (const p of c.physics) n += p.awake;
    return n;
  }

  get lampHeads() {
    return [...this.cells.values()].flatMap((c) => c.lampHeads);
  }
}
