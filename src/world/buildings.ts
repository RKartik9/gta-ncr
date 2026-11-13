import * as THREE from 'three/webgpu';
import type { Building, Tile } from './tile.ts';
import { GeoBuilder, polygon } from './geo.ts';
import type { Chunk, Chunks } from './chunks.ts';
import { type Budget, cached, hash01, ringArea } from '../util.ts';
import { Instances, instanced } from '../render/instances.ts';
import { onNight } from '../render/sky.ts';
import { CLEARINGS } from './landmarks.ts';
import { type Facade, colonialFacade, colonnadeTexture, glassFacade, lutyensFacade, officeFacade, plasterFacade, roofTexture, sandstoneFacade, shopfrontTexture } from '../render/textures.ts';

type Style = 'colonial' | 'office' | 'glass' | 'plaster' | 'lutyens' | 'sandstone' | 'shed';

// Lutyens' bungalow zone, between Rashtrapati Bhavan, India Gate and Khan Market, in map metres from CP (x east, z south).
const LUTYENS = { x: -700, z: 2700, r: 2300 };

// Wash colours of Delhi plaster walk-ups.
const PLASTER_TINTS: [number, number, number][] = [
  [1, 0.97, 0.9], [0.98, 0.9, 0.78], [0.95, 0.84, 0.78], [0.86, 0.92, 0.94], [0.93, 0.93, 0.85], [0.99, 0.93, 0.7], [0.88, 0.95, 0.86], [0.9, 0.88, 0.86],
];

function centroid(ring: number[]): [number, number] {
  let x = 0, z = 0;
  for (let i = 0; i < ring.length; i += 2) {
    x += ring[i];
    z += ring[i + 1];
  }
  return [x / (ring.length / 2), z / (ring.length / 2)];
}

export interface BuiltCity {
  /** wall triangles for the physics world, a set per chunk so no single one takes long to add */
  colliders: { vertices: Float32Array; indices: Uint32Array }[];
}

export async function buildBuildings(tile: Tile, plaza: [number, number], chunks: Chunks, budget: Budget): Promise<BuiltCity> {
  const facades: Record<Exclude<Style, 'shed'>, Facade> = cached('facades', () => ({
    colonial: colonialFacade(),
    office: officeFacade(),
    glass: glassFacade(),
    plaster: plasterFacade(),
    lutyens: lutyensFacade(),
    sandstone: sandstoneFacade(),
  }));
  const shop = cached('shopfronts', shopfrontTexture);
  const colonnade = cached('colonnade', colonnadeTexture);

  const walls: Record<Style, GeoBuilder> = {
    colonial: new GeoBuilder(true), office: new GeoBuilder(true), glass: new GeoBuilder(true), plaster: new GeoBuilder(true),
    lutyens: new GeoBuilder(true), sandstone: new GeoBuilder(true), shed: new GeoBuilder(true),
  };
  const shops = new GeoBuilder(true);
  const arcade = new GeoBuilder(true);
  const roofs = new GeoBuilder(true);
  const colliders = new Map<Chunk, { v: number[]; i: number[] }>();
  const tanks: THREE.Matrix4[] = [];

  const styleOf = (b: Building, cx: number, cz: number): Style => {
    if (b.kind === 'roof' || b.kind === 'shed' || b.kind === 'garage') return 'shed';
    const h = hash01(b.id);
    // The white Georgian blocks ring the central park; everything inside the Outer Circle is one of them.
    if (Math.hypot(cx - plaza[0], cz - plaza[1]) < 380 && b.height <= 18) return 'colonial';
    // New Delhi proper: sandstone government blocks and low white bungalows; its markets stay ordinary shop-houses
    if (Math.hypot(cx - LUTYENS.x, cz - LUTYENS.z) < LUTYENS.r && !['commercial', 'retail', 'apartments', 'hotel'].includes(b.kind)) {
      return b.height >= 16 || ['government', 'public', 'civic'].includes(b.kind) ? 'sandstone' : 'lutyens';
    }
    if (b.height >= 42) return h < 0.6 ? 'glass' : 'office';
    if (['commercial', 'office', 'retail', 'hotel', 'government', 'public', 'civic'].includes(b.kind) || b.height >= 24) return h < 0.2 ? 'glass' : 'office';
    return 'plaster';
  };

  /** One vertical quad, with the texture snapped to whole bays and floors so no window is cut in half. */
  const wall = (
    g: GeoBuilder, f: Facade | null, ax: number, az: number, bx: number, bz: number, y0: number, y1: number,
    outwardLeft: boolean, tint: [number, number, number], seed: number,
  ) => {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.05 || y1 - y0 < 0.05) return;
    let nx = -dz / len, nz = dx / len;
    if (!outwardLeft) {
      nx = -nx;
      nz = -nz;
    }
    let u0 = 0, u1 = 1, v1 = 1;
    if (f) {
      const bay = f.width / f.bays;
      if (len < bay * 0.6) u1 = 0.008; // too narrow for a window: plain wall
      else {
        const bays = Math.max(1, Math.round(len / bay));
        u0 = Math.floor(hash01(seed) * f.bays) / f.bays;
        u1 = u0 + bays / f.bays;
      }
      v1 = f.floors === 1 ? 1 : Math.max(1, Math.round((y1 - y0) / (f.height / f.floors))) / f.floors;
    }
    const [r, gr, bl] = tint;
    const a = g.vert(ax, y0, az, nx, 0, nz, u0, 0, r, gr, bl);
    const b = g.vert(bx, y0, bz, nx, 0, nz, u1, 0, r, gr, bl);
    const c = g.vert(bx, y1, bz, nx, 0, nz, u1, v1, r, gr, bl);
    const d = g.vert(ax, y1, az, nx, 0, nz, u0, v1, r, gr, bl);
    if (outwardLeft) {
      g.tri(a, b, c);
      g.tri(a, c, d);
    } else {
      g.tri(a, c, b);
      g.tri(a, d, c);
    }
  };

  for (const b of tile.buildings) {
    if (budget.due) await budget.wait();
    const [cx, cz] = centroid(b.outer);
    if (CLEARINGS.some(([x, z, r]) => Math.hypot(cx - x, cz - z) < r)) continue;
    const chunk = chunks.at(cx, cz);
    let col = colliders.get(chunk);
    if (!col) colliders.set(chunk, (col = { v: [], i: [] }));
    const colV = col.v, colI = col.i;
    const style = styleOf(b, cx, cz);
    const h = hash01(b.id * 7 + 1);
    const shade = 0.86 + h * 0.18;
    const tint: [number, number, number] =
      style === 'plaster' ? (PLASTER_TINTS[Math.floor(hash01(b.id * 3) * PLASTER_TINTS.length)].map((c) => c * shade) as [number, number, number])
      : style === 'shed' ? [0.55 * shade, 0.57 * shade, 0.6 * shade]
      : [shade, shade, shade];
    const y0 = b.minHeight;
    const top = Math.max(b.height, y0 + 2.5);
    const facade = style === 'shed' ? null : facades[style];
    const ground = style === 'shed' || y0 > 0 || top < 6.5 ? null : style === 'colonial' ? colonnade : style === 'office' || style === 'plaster' ? shop : null;
    const groundTop = ground ? y0 + ground.height : y0;

    const rings: [number[], boolean][] = [[b.outer, true], ...b.holes.map((r): [number[], boolean] => [r, false])];
    rings.forEach(([ring, isOuter], ri) => {
      // Shoelace sign tells which side of each edge is outside the building.
      const outwardLeft = ringArea(ring) < 0 === isOuter;
      const n = ring.length / 2;
      const colBase = colV.length / 3;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const seed = b.id * 31 + ri * 977 + i;
        if (ground) wall(style === 'colonial' ? arcade : shops, ground, ax, az, bx, bz, y0, groundTop, outwardLeft, [1, 1, 1], seed);
        wall(walls[style], facade, ax, az, bx, bz, groundTop, top, outwardLeft, tint, seed);
        if (isOuter) {
          colV.push(ax, 0, az, ax, top, az);
          const a = colBase + i * 2, c = colBase + j * 2;
          colI.push(a, c, a + 1, c, c + 1, a + 1);
        }
      }
    });

    const k = 0.8 + h * 0.3;
    const roof = polygon(roofs, b.outer, b.holes, top, 9, k, k, k * 0.98);

    // Black plastic water tanks on the roof: nothing says "Delhi skyline" faster.
    if ((style === 'plaster' || style === 'office') && top < 32 && Math.abs(ringArea(b.outer)) > 70) {
      const count = 1 + Math.floor(hash01(b.id * 13) * 2.4);
      for (let t = 0; t < count && t < roof.tris.length; t++) {
        const tri = roof.tris[Math.floor(hash01(b.id * 17 + t) * roof.tris.length)];
        const p = tri.map((i) => roof.points[i]);
        const tx = (p[0].x + p[1].x + p[2].x) / 3, tz = (p[0].y + p[1].y + p[2].y) / 3;
        const s = 0.8 + hash01(b.id * 19 + t) * 0.5;
        tanks.push(new THREE.Matrix4().compose(new THREE.Vector3(tx, top, tz), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
      }
    }
  }

  const add = async (g: GeoBuilder, material: THREE.Material, name: string) => {
    if (!g.count) return;
    chunks.addLayer(g, material, name, true);
    if (budget.due) await budget.wait();
  };
  const facadeMaterial = (f: Facade, envMapIntensity = 1, glow = 2.2) => cached(`m-facade-${f.map.uuid}`, () => {
    const m = new THREE.MeshStandardMaterial({
      map: f.map, roughnessMap: f.orm, metalnessMap: f.orm, roughness: 1, metalness: 1, vertexColors: true, envMapIntensity,
      emissive: 0xffffff, emissiveMap: f.glow, emissiveIntensity: 0,
    });
    onNight((n) => (m.emissiveIntensity = glow * n));
    return m;
  });
  await add(walls.colonial, facadeMaterial(facades.colonial, 1, 1.3), 'walls-colonial');
  await add(walls.office, facadeMaterial(facades.office), 'walls-office');
  await add(walls.glass, facadeMaterial(facades.glass, 1.3, 1.6), 'walls-glass');
  await add(walls.plaster, facadeMaterial(facades.plaster, 1, 1.8), 'walls-plaster');
  await add(walls.lutyens, facadeMaterial(facades.lutyens, 1, 1.2), 'walls-lutyens');
  await add(walls.sandstone, facadeMaterial(facades.sandstone, 1, 1.4), 'walls-sandstone');
  await add(walls.shed, cached('m-shed', () => new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.5, vertexColors: true })), 'walls-shed');
  await add(shops, facadeMaterial(shop, 1, 3), 'shopfronts');
  await add(arcade, facadeMaterial(colonnade, 1, 3.5), 'colonnade');
  await add(roofs, cached('m-roof', () => new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.95, vertexColors: true })), 'roofs');

  const tankGeo = cached('g-tank', () => new THREE.CylinderGeometry(0.62, 0.66, 1.5, 12).translate(0, 0.95, 0));
  for (const [chunk, list] of chunks.bucket(tanks, (m) => [m.elements[12], m.elements[14]])) {
    const mesh = new Instances(tankGeo, cached('m-tank', () => instanced(new THREE.MeshStandardNodeMaterial({ color: 0x141416, roughness: 0.45 }))), list);
    mesh.name = 'water-tanks';
    mesh.castShadow = true;
    chunk.near.add(mesh);
  }

  return { colliders: [...colliders.values()].filter((c) => c.i.length).map((c) => ({ vertices: new Float32Array(c.v), indices: new Uint32Array(c.i) })) };
}
