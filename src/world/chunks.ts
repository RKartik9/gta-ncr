import * as THREE from 'three/webgpu';
import type { GeoBuilder } from './geo.ts';

/** Metres along each side of a chunk: the unit of scenery the renderer draws or skips. */
export const CHUNK = 200;

export interface Chunk {
  /** corner of the chunk's square, map metres */
  x: number;
  z: number;
  /** drawn out to the draw distance: ground, buildings, tree crowns, lamp posts */
  far: THREE.Group;
  /** drawn only close by: leaf sprays, street furniture, signals */
  near: THREE.Group;
}

/**
 * One map cell's scenery, filed by chunk. A cell is a kilometre across: drawn as one lump, all of it goes to the
 * graphics card every frame even when only a corner is in view. In chunks, only those near the car are drawn,
 * and of those the renderer skips the ones off screen or outside the shadow.
 */
export class Chunks {
  readonly group = new THREE.Group();
  readonly list: Chunk[] = [];
  private byKey = new Map<string, Chunk>();

  /** The chunk whose square holds (x, z). */
  at(x: number, z: number): Chunk {
    const i = Math.floor(x / CHUNK), j = Math.floor(z / CHUNK);
    const key = `${i},${j}`;
    let chunk = this.byKey.get(key);
    if (!chunk) {
      // neither group is in the scene until `cull` puts it there
      chunk = { x: i * CHUNK, z: j * CHUNK, far: new THREE.Group(), near: new THREE.Group() };
      this.byKey.set(key, chunk);
      this.list.push(chunk);
    }
    return chunk;
  }

  /** Things with a place on the map, sorted into the chunks they stand in. */
  bucket<T>(items: T[], where: (item: T) => [number, number]) {
    const out = new Map<Chunk, T[]>();
    for (const item of items) {
      const [x, z] = where(item);
      const chunk = this.at(x, z);
      const list = out.get(chunk);
      if (list) list.push(item);
      else out.set(chunk, [item]);
    }
    return out;
  }

  /** A merged layer of the city (roads, one style of wall, roofs), cut into a mesh per chunk. */
  addLayer(b: GeoBuilder, material: THREE.Material, name: string, castShadow: boolean) {
    for (const part of b.buildChunks(CHUNK)) {
      const mesh = new THREE.Mesh(part.geometry, material);
      mesh.name = name;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      // any point inside the square finds the chunk; the corner itself can round down into the next one over
      this.at(part.x + CHUNK / 2, part.z + CHUNK / 2).far.add(mesh);
    }
  }

  /** Nothing in a cell moves by itself: work out where each piece sits once, rather than again every frame. */
  freeze() {
    for (const c of this.list) for (const g of [c.far, c.near]) g.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
  }

  /**
   * Puts the chunks within `draw` metres of (x, z) in the scene, and their close-up detail within `detail`.
   * The rest are taken out altogether: even a hidden object costs a little every frame, and a city has thousands.
   */
  cull(x: number, z: number, draw: number, detail: number) {
    for (const c of this.list) {
      const d = Math.hypot(Math.max(c.x - x, 0, x - c.x - CHUNK), Math.max(c.z - z, 0, z - c.z - CHUNK));
      this.show(c.far, d < draw);
      this.show(c.near, d < detail);
    }
  }

  private show(g: THREE.Group, on: boolean) {
    if (on === (g.parent !== null)) return;
    if (on) this.group.add(g);
    else this.group.remove(g);
  }

  /** Every mesh of the cell, in the scene or not. */
  traverse(fn: (o: THREE.Object3D) => void) {
    for (const c of this.list) {
      c.far.traverse(fn);
      c.near.traverse(fn);
    }
  }
}
