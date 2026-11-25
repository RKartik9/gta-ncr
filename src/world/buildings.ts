import * as THREE from 'three/webgpu';
import type { Building, Tile } from './tile.ts';
import { GeoBuilder, polygon } from './geo.ts';
import type { Chunk, Chunks } from './chunks.ts';
import { type Budget, cached, hash01, ringArea } from '../util.ts';
import { Instances, instanced } from '../render/instances.ts';
import { onNight } from '../render/sky.ts';
import { CLEARINGS } from './landmarks.ts';
import { CITY } from '../config.ts';
import { type Facade, colonialFacade, colonnadeTexture, glassFacade, lutyensFacade, officeFacade, plasterFacade, roofTexture, sandstoneFacade, shopfrontTexture } from '../render/textures.ts';

type Style = 'colonial' | 'office' | 'glass' | 'plaster' | 'lutyens' | 'sandstone' | 'shed' | 'stone';

// Lutyens' bungalow zone, between Rashtrapati Bhavan, India Gate and Khan Market, in map metres from CP (x east, z south).
const LUTYENS = { x: -700, z: 2700, r: 2300 };
// Bombay's Fort, Kala Ghoda, CST and Churchgate: Victorian Gothic in buff basalt, in Mumbai map metres.
const FORT = { x: 850, z: 4950, r: 950 };

// Wash colours of Delhi plaster walk-ups; in Bombay, sea air and monsoons leave everything greyed and streaked.
const PLASTER_TINTS: [number, number, number][] = CITY === 'mumbai' ? [
  [0.84, 0.82, 0.77], [0.9, 0.86, 0.78], [0.74, 0.75, 0.73], [0.93, 0.89, 0.81], [0.82, 0.8, 0.84], [0.78, 0.84, 0.82], [0.95, 0.93, 0.88], [0.68, 0.66, 0.62], [0.88, 0.8, 0.7],
] : [
  // ochre, salmon, pistachio, powder blue, cream, dusty pink, terracotta, lime-wash white, mint. Picked by eye in
  // sRGB and converted, since vertex colours are linear: the old linear 0.9s all came out near-white.
  0xe8c27a, 0xe6a58c, 0xb9d3a4, 0xa9c6d6, 0xf2e6c8, 0xe0b0b4, 0xd08a62, 0xf5f2ea, 0xa8d5c2,
].map((hex) => new THREE.Color(hex).toArray() as [number, number, number]);

/** Towers round Connaught Place that people know by sight: red sandstone for the LIC building, glass for Statesman House. */
const KNOWN: Record<string, Style> = {
  'Jeevan Bharti': 'sandstone', 'Statesman House': 'glass',
  'The Taj Mahal Palace': 'sandstone', 'Taj Mahal Palace': 'sandstone', 'Taj Mahal Tower': 'sandstone',
};

/** Metres a Connaught Place colonnade stands out from its wall (tools/bake/bake.mjs leaves room for exactly this), and between its columns. */
const ARCADE_DEPTH = 2.6, COLUMN_GAP = 3.6;

/** A flat four-cornered face, wound so that it faces along (nx, ny, nz). */
function quad(g: GeoBuilder, p: [number, number, number][], nx: number, ny: number, nz: number, c: [number, number, number]) {
  const [a, b, d, e] = p.map(([x, y, z]) => g.vert(x, y, z, nx, ny, nz, 0, 0, c[0], c[1], c[2]));
  const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
  const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz >= 0) {
    g.tri(a, b, d);
    g.tri(a, d, e);
  } else {
    g.tri(a, d, b);
    g.tri(a, e, d);
  }
}

/** A round column, eight-sided, standing at (x, z). */
function column(g: GeoBuilder, x: number, z: number, r: number, y0: number, y1: number, c: [number, number, number]) {
  for (let k = 0; k < 8; k++) {
    const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
    const x0 = Math.sin(a0), z0 = Math.cos(a0), x1 = Math.sin(a1), z1 = Math.cos(a1);
    const a = g.vert(x + x0 * r, y0, z + z0 * r, x0, 0, z0, 0, 0, ...c), b = g.vert(x + x1 * r, y0, z + z1 * r, x1, 0, z1, 0, 0, ...c);
    const d = g.vert(x + x1 * r, y1, z + z1 * r, x1, 0, z1, 0, 0, ...c), e = g.vert(x + x0 * r, y1, z + z0 * r, x0, 0, z0, 0, 0, ...c);
    g.tri(a, b, d);
    g.tri(a, d, e);
  }
}

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
  const facades: Record<Exclude<Style, 'shed' | 'stone'>, Facade> = cached('facades', () => ({
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
    lutyens: new GeoBuilder(true), sandstone: new GeoBuilder(true), shed: new GeoBuilder(true), stone: new GeoBuilder(true),
  };
  const shops = new GeoBuilder(true);
  const arcade = new GeoBuilder(true);
  const porch = new GeoBuilder(true);
  const roofs = new GeoBuilder(true);
  const colliders = new Map<Chunk, { v: number[]; i: number[] }>();
  const tanks: THREE.Matrix4[] = [];

  const styleOf = (b: Building, cx: number, cz: number): Style => {
    if (b.historic) return 'stone';
    if (b.name && KNOWN[b.name]) return KNOWN[b.name];
    if (b.kind === 'roof' || b.kind === 'shed' || b.kind === 'garage') return 'shed';
    const h = hash01(b.id);
    // The white Georgian blocks ring the central park; everything inside the Outer Circle is one of them.
    if (Math.hypot(cx - plaza[0], cz - plaza[1]) < 380 && b.height <= 18) return 'colonial';
    if (CITY === 'mumbai') {
      // the Fort's courts, colleges, banks and stations are Gothic stone; everywhere else Bombay is towers and weathered blocks
      if (Math.hypot(cx - FORT.x, cz - FORT.z) < FORT.r && (['government', 'public', 'civic', 'college', 'university', 'church', 'train_station', 'hospital', 'museum'].includes(b.kind) || (b.height >= 14 && b.height < 40 && h < 0.5))) return 'sandstone';
      if (b.height >= 45) return h < 0.55 ? 'glass' : 'office';
      if (['commercial', 'office', 'hotel'].includes(b.kind) && b.height >= 20) return h < 0.4 ? 'glass' : 'office';
      return 'plaster';
    }
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
      // seen from outside, such a wall runs right to left: unturned, its shop signs read backwards
      if (!outwardLeft) [u0, u1] = [u1, u0];
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
      // rubble and sandstone; the Jantar Mantar instruments are washed red
      : style === 'stone' ? (b.name?.includes('Yantra') ? [0.66 * shade, 0.3 * shade, 0.22 * shade] : [0.7 * shade, 0.54 * shade, 0.4 * shade])
      : [shade, shade, shade];
    const y0 = b.minHeight;
    const top = Math.max(b.height, y0 + 2.5);
    const facade = style === 'shed' || style === 'stone' ? null : facades[style];
    const ground = facade === null || y0 > 0 || top < 6.5 ? null : style === 'colonial' ? colonnade : style === 'office' || style === 'plaster' ? shop : null;
    const groundTop = ground ? y0 + ground.height : y0;

    const rings: [number[], boolean][] = [[b.outer, true], ...b.holes.map((r): [number[], boolean] => [r, false])];
    rings.forEach(([ring, isOuter], ri) => {
      // Shoelace sign tells which side of each edge is outside the building.
      const outwardLeft = ringArea(ring) < 0 === isOuter;
      const n = ring.length / 2;
      const colBase = colV.length / 3;
      // Connaught Place: the walls with a colonnade in front show their shops; the columns are built below
      const fronted = isOuter && style === 'colonial' && ground && b.arcade ? new Set(b.arcade) : null;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const seed = b.id * 31 + ri * 977 + i;
        if (fronted?.has(i)) wall(shops, shop, ax, az, bx, bz, y0, groundTop, outwardLeft, [1, 1, 1], seed);
        else if (ground) wall(style === 'colonial' ? arcade : shops, ground, ax, az, bx, bz, y0, groundTop, outwardLeft, [1, 1, 1], seed);
        wall(walls[style], facade, ax, az, bx, bz, groundTop, top, outwardLeft, tint, seed);
        if (isOuter) {
          colV.push(ax, 0, az, ax, top, az);
          const a = colBase + i * 2, c = colBase + j * 2;
          colI.push(a, c, a + 1, c, c + 1, a + 1);
        }
      }
      if (!fronted) return;

      // The colonnade: a flat roof standing out from the wall at first-floor height, on a row of round columns.
      const white: [number, number, number] = [0.95 * shade, 0.94 * shade, 0.9 * shade];
      const side = outwardLeft ? 1 : -1;
      /** which way edge i faces, or null if it has no length */
      const facing = (i: number): [number, number] | null => {
        const k = (i + 1) % n;
        const dx = ring[k * 2] - ring[i * 2], dz = ring[k * 2 + 1] - ring[i * 2 + 1], len = Math.hypot(dx, dz);
        return len < 0.05 ? null : [(-dz / len) * side, (dx / len) * side];
      };
      /** How far out the roof's corner is from the wall's corner where edges `e` and `other` meet: mitred if both carry the colonnade. */
      const reach = (e: number, other: number): [number, number] => {
        const a = facing(e)!, o = fronted.has(other) ? facing(other) : null;
        const d = o ? 1 + a[0] * o[0] + a[1] * o[1] : 0;
        return o && d > 0.5 ? [(a[0] + o[0]) / d, (a[1] + o[1]) / d] : a;
      };
      const under = groundTop - 0.45, over = groundTop + 0.55;
      for (const i of fronted) {
        const f = facing(i);
        if (!f) continue;
        const j = (i + 1) % n, before = (i + n - 1) % n;
        const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
        const [pax, paz] = reach(i, before), [pbx, pbz] = reach(i, j);
        const D = ARCADE_DEPTH;
        const oax = ax + pax * D, oaz = az + paz * D, obx = bx + pbx * D, obz = bz + pbz * D;
        quad(porch, [[oax, under, oaz], [obx, under, obz], [obx, over, obz], [oax, over, oaz]], f[0], 0, f[1], white);
        quad(porch, [[ax, under, az], [bx, under, bz], [obx, under, obz], [oax, under, oaz]], 0, -1, 0, [white[0] * 0.8, white[1] * 0.8, white[2] * 0.8]);
        quad(porch, [[ax, over, az], [bx, over, bz], [obx, over, obz], [oax, over, oaz]], 0, 1, 0, white);
        // the ends, where the colonnade stops, and the same line for the car to stop against
        const len = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / len, tz = (bz - az) / len;
        const ends: [number, number, number, number, number, number][] = [];
        if (!fronted.has(before)) ends.push([ax, az, oax, oaz, -tx, -tz]);
        if (!fronted.has(j)) ends.push([bx, bz, obx, obz, tx, tz]);
        for (const [wx, wz, ox, oz, ex, ez] of ends) quad(porch, [[wx, under, wz], [ox, under, oz], [ox, over, oz], [wx, over, wz]], ex, 0, ez, white);
        for (const [x0, z0, x1, z1] of [[oax, oaz, obx, obz], ...ends]) {
          const v = colV.length / 3;
          colV.push(x0, 0, z0, x0, over, z0, x1, 0, z1, x1, over, z1);
          colI.push(v, v + 2, v + 1, v + 2, v + 3, v + 1);
        }
        // columns a little inside the roof's edge, evenly spaced; the one at the far corner belongs to the next wall
        const k = (D - 0.45) / D;
        const cax = ax + pax * D * k, caz = az + paz * D * k, cbx = bx + pbx * D * k, cbz = bz + pbz * D * k;
        const count = Math.max(1, Math.round(Math.hypot(cbx - cax, cbz - caz) / COLUMN_GAP));
        for (let c = 0; c < count + (fronted.has(j) ? 0 : 1); c++) {
          column(porch, cax + ((cbx - cax) * c) / count, caz + ((cbz - caz) * c) / count, 0.36, y0, under, white);
        }
      }
    });

    const k = 0.8 + h * 0.3;
    const roof = polygon(roofs, b.outer, b.holes, top, 9, k, k, k * 0.98);

    // Black plastic water tanks on the roof: nothing says "Delhi skyline" faster. Bombay's are blue (and so are its monsoon tarps).
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
  await add(walls.stone, cached('m-stone', () => {
    // old stonework is floodlit after dark
    const m = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: true, emissive: 0x9a6a3a, emissiveIntensity: 0 });
    onNight((n) => (m.emissiveIntensity = 0.3 * n));
    return m;
  }), 'walls-stone');
  await add(shops, facadeMaterial(shop, 1, 3), 'shopfronts');
  await add(arcade, facadeMaterial(colonnade, 1, 3.5), 'colonnade');
  await add(porch, cached('m-porch', () => new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true })), 'porch');
  await add(roofs, cached('m-roof', () => new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.95, vertexColors: true })), 'roofs');

  const tankGeo = cached('g-tank', () => new THREE.CylinderGeometry(0.62, 0.66, 1.5, 12).translate(0, 0.95, 0));
  for (const [chunk, list] of chunks.bucket(tanks, (m) => [m.elements[12], m.elements[14]])) {
    const mesh = new Instances(tankGeo, cached('m-tank', () => instanced(new THREE.MeshStandardNodeMaterial({ color: CITY === 'mumbai' ? 0x2357a8 : 0x141416, roughness: 0.45 }))), list);
    mesh.name = 'water-tanks';
    mesh.castShadow = true;
    chunk.near.add(mesh);
  }

  return { colliders: [...colliders.values()].filter((c) => c.i.length).map((c) => ({ vertices: new Float32Array(c.v), indices: new Uint32Array(c.i) })) };
}
