import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { type Grid, type Tile, loadJson } from './tile.ts';
import { buildGround } from './ground.ts';
import { buildBuildings } from './buildings.ts';
import { buildProps } from './props.ts';
import { addProps } from './physics.ts';
import { isShared } from '../util.ts';

/** Cells whose nearest edge is closer than this are loaded... */
const LOAD = 650;
/** ...and dropped again once they are this far away. The gap stops a cell flickering in and out at a border. */
const UNLOAD = 1300;

interface Cell {
  key: string;
  tile: Tile;
  group: THREE.Group;
  physics: ReturnType<typeof addProps>;
  lampHeads: THREE.Vector3[];
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Keeps the map cells round the car loaded, and only those: scenery, physics and minimap piece.
 * Cells are built one at a time, a stage per frame, so driving into new ground does not stall the picture.
 * ponytail: building runs on the main thread; move the geometry work to a worker if a dense cell still hitches.
 */
export class Streamer {
  readonly cells = new Map<string, Cell>();
  /** every loaded cell's map data, for road lookups */
  tiles: Tile[] = [];
  /** called after a cell arrives or leaves */
  onChange: (added: Cell | null, removedKey: string | null) => void = () => {};
  private pending = new Set<string>();
  private queue = Promise.resolve();
  private known: Set<string>;
  private grid: Grid;
  private dir: string;
  private scene: THREE.Scene;
  private world: RAPIER.World;
  private treeDensity: number;

  constructor(grid: Grid, dir: string, scene: THREE.Scene, world: RAPIER.World, treeDensity: number) {
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
    for (const [key, cell] of this.cells) if (this.distance(key, x, z) > UNLOAD) this.unload(cell);
    const want = [...this.known]
      .filter((k) => !this.cells.has(k) && !this.pending.has(k) && this.distance(k, x, z) < LOAD)
      .sort((a, b) => this.distance(a, x, z) - this.distance(b, x, z));
    for (const key of want) {
      this.pending.add(key);
      this.queue = this.queue.then(() => this.load(key)).catch((err) => console.warn(`map cell ${key} failed to load`, err));
    }
    return this.queue;
  }

  private async load(key: string) {
    const tile = await loadJson<Tile>(`${this.dir}/${key}`);
    const group = new THREE.Group();
    group.name = `cell-${key}`;
    group.add(buildGround(tile));
    await nextFrame();
    const city = buildBuildings(tile, this.grid.plaza);
    group.add(city.group);
    await nextFrame();
    const props = buildProps(tile, this.grid.plaza, this.treeDensity);
    group.add(props.group);
    await nextFrame();
    const physics = addProps(this.world, props.solids, props.loose, city.collider);
    const cell: Cell = { key, tile, group, physics, lampHeads: props.lampHeads };
    this.pending.delete(key);
    this.cells.set(key, cell);
    this.tiles = [...this.cells.values()].map((c) => c.tile);
    this.scene.add(group);
    this.onChange(cell, null);
  }

  private unload(cell: Cell) {
    this.cells.delete(cell.key);
    this.tiles = [...this.cells.values()].map((c) => c.tile);
    this.scene.remove(cell.group);
    cell.physics.dispose();
    cell.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
      if (!isShared(mesh.geometry)) mesh.geometry.dispose();
    });
    this.onChange(null, cell.key);
  }

  /** Every physics step: copy knocked-over furniture back into the picture. */
  sync() {
    for (const c of this.cells.values()) c.physics.sync();
  }

  get awake() {
    let n = 0;
    for (const c of this.cells.values()) n += c.physics.awake;
    return n;
  }

  get lampHeads() {
    return [...this.cells.values()].flatMap((c) => c.lampHeads);
  }
}
