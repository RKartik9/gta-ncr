import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Tile } from './tile.ts';
import { isMajor, isStreet } from './ground.ts';
import { cached, cullable, mulberry32, pointInRing, ringArea } from '../util.ts';
import { barkTexture, flagTexture, leafCardTexture, leafTexture } from '../render/textures.ts';
import { onNight } from '../render/sky.ts';

/** Lumpy canopy built from a few displaced spheres, darker underneath to fake self-shadowing. */
function canopyGeometry(seed: number, blobs: [number, number, number, number, number][]) {
  const parts = blobs.map(([x, y, z, r, squash], n) => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, n === 0 ? 2 : 1);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position;
    const s = seed * 3.1 + n * 1.7;
    for (let i = 0; i < p.count; i++) {
      const dx = p.getX(i), dy = p.getY(i), dz = p.getZ(i);
      // smooth lumps: a function of direction, so neighbouring vertices move together
      const k = r * (1 + 0.17 * Math.sin(dx * 6 + s) + 0.13 * Math.sin(dy * 8 + s * 2) + 0.12 * Math.sin(dz * 7 + s * 3));
      p.setXYZ(i, dx * k + x, dy * k * squash + y, dz * k + z);
    }
    g.computeVertexNormals();
    return g;
  });
  const g = mergeGeometries(parts)!;
  const p = g.attributes.position;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const col = new Float32Array(p.count * 3);
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min.y) / (max.y - min.y);
    const k = 0.32 + 0.68 * t;
    col.set([k, k, k], i * 3);
    uv.set([(p.getX(i) + p.getY(i) * 0.5) * 0.35, (p.getZ(i) + p.getY(i) * 0.5) * 0.35], i * 2);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Leaf cards scattered over the surface of the crown's blobs: small crossed sprays that break up the silhouette.
 * Their normals point out from the blob, so the crown is lit like a soft ball rather than a heap of flat cards.
 */
function cardGeometry(seed: number, blobs: [number, number, number, number, number][], count: number) {
  const rnd = mulberry32(seed * 101);
  const weights = blobs.map(([, , , r]) => r * r);
  const total = weights.reduce((a, b) => a + b, 0);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (const [, y, , r, sq] of blobs) {
    minY = Math.min(minY, y - r * sq);
    maxY = Math.max(maxY, y + r * sq);
  }
  const d = new THREE.Vector3(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    let pick = rnd() * total, b = 0;
    while (pick > weights[b] && b < blobs.length - 1) pick -= weights[b++];
    const [bx, by, bz, r, sq] = blobs[b];
    do d.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    while (d.lengthSq() > 1 || d.lengthSq() < 0.01);
    d.normalize();
    const reach = r * (0.78 + rnd() * 0.3);
    p.set(bx + d.x * reach, by + d.y * reach * sq, bz + d.z * reach);
    // a card faces roughly outward, tipped at random so the crown has depth from every side
    n.copy(d).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.2)).normalize();
    t1.set(0, 1, 0).cross(n);
    if (t1.lengthSq() < 0.01) t1.set(1, 0, 0);
    t1.normalize();
    t2.crossVectors(n, t1);
    const size = (2.3 + rnd() * 1.1) * Math.sqrt(r / 2.4);
    const base = pos.length / 3;
    const k = 0.42 + 0.58 * ((p.y - minY) / (maxY - minY)); // darker underneath, as in the core
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(p.x + (t1.x * u + t2.x * v) * size / 2, p.y + (t1.y * u + t2.y * v) * size / 2, p.z + (t1.z * u + t2.z * v) * size / 2);
      nor.push(d.x, d.y, d.z);
      uv.push((u + 1) / 2, (v + 1) / 2);
      col.push(k, k, k);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** The core sits a little inside the cards, so leaves stand proud of it. */
const shrink = (blobs: [number, number, number, number, number][]) => blobs.map(([x, y, z, r, sq]): [number, number, number, number, number] => [x, y, z, r * 0.84, sq]);

/** Distance from a point to the nearest edge of a closed ring. */
function edgeDistance(x: number, z: number, ring: number[]) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const ax = ring[i], az = ring[i + 1], dx = ring[j] - ax, dz = ring[j + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

interface TreeSpot {
  x: number;
  z: number;
  scale: number;
  tall: boolean;
}

function placeTrees(tile: Tile, density: number): TreeSpot[] {
  const rnd = mulberry32(2024);
  const spots: TreeSpot[] = [];
  // Buildings filed by 50 m square (padded by the 1.5 m clearance), so each candidate spot checks only its neighbours.
  const buildingsAt = new Map<string, number[]>();
  tile.buildings.forEach((b, n) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < b.outer.length; i += 2) {
      minX = Math.min(minX, b.outer[i]);
      maxX = Math.max(maxX, b.outer[i]);
      minZ = Math.min(minZ, b.outer[i + 1]);
      maxZ = Math.max(maxZ, b.outer[i + 1]);
    }
    fileBox(buildingsAt, minX - 1.5, minZ - 1.5, maxX + 1.5, maxZ + 1.5, n);
  });
  const roads = roadIndex(tile);
  const blocked = (x: number, z: number) => {
    for (const n of buildingsAt.get(bucketKey(x, z)) ?? []) {
      const ring = tile.buildings[n].outer;
      if (pointInRing(x, z, ring) || pointInRing(x + 1.2, z, ring) || pointInRing(x - 1.2, z, ring) || pointInRing(x, z + 1.2, ring) || pointInRing(x, z - 1.2, ring)) return true;
    }
    return roads(x, z, 0.9);
  };
  const tryAdd = (x: number, z: number, tall: boolean) => {
    // a cell's roads run on past its edge, and so do their avenue trees
    const { minX, maxX, minZ, maxZ } = tile.bounds;
    if (x < minX - 400 || x > maxX + 400 || z < minZ - 400 || z > maxZ + 400 || blocked(x, z)) return;
    spots.push({ x, z, scale: 0.75 + rnd() * 0.6, tall });
  };

  for (let i = 0; i < tile.trees.length; i += 2) tryAdd(tile.trees[i], tile.trees[i + 1], false);

  // Avenue trees: Lutyens' Delhi is planted road by road, a single species per avenue.
  for (const r of tile.roads) {
    if (!isStreet(r)) continue;
    const tall = isMajor(r) && rnd() < 0.2;
    const spacing = (isMajor(r) ? 12 : 17) / density;
    let carry = rnd() * spacing;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i], az = r.pts[i + 1];
      const dx = r.pts[i + 2] - ax, dz = r.pts[i + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      for (let s = carry; s < len; s += spacing) {
        for (const side of [-1, 1]) {
          if (rnd() < 0.25) continue;
          const off = (r.width / 2 + 1.5 + rnd() * 0.5) * side;
          tryAdd(ax + (dx / len) * s - (dz / len) * off, az + (dz / len) * s + (dx / len) * off, tall);
        }
      }
      carry = (carry - len) % spacing;
      if (carry < 0) carry += spacing;
    }
  }

  // Parks: clumps round the edge, lawns in the middle.
  for (const a of tile.areas) {
    if (a.kind !== 'green') continue;
    const area = Math.abs(ringArea(a.outer));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < a.outer.length; i += 2) {
      minX = Math.min(minX, a.outer[i]);
      maxX = Math.max(maxX, a.outer[i]);
      minZ = Math.min(minZ, a.outer[i + 1]);
      maxZ = Math.max(maxZ, a.outer[i + 1]);
    }
    // Big lawns (Kartavya Path, the India Gate hexagon) are open grass: their trees stand only round the edge.
    const open = area > 15000;
    const want = Math.min(160, Math.round((area / 260) * density * (open ? 0.4 : 1)));
    for (let i = 0, tries = 0; i < want && tries < want * 8; tries++) {
      const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ);
      if (!pointInRing(x, z, a.outer)) continue;
      if (open && edgeDistance(x, z, a.outer) > 14) continue;
      tryAdd(x, z, rnd() < 0.15);
      i++;
    }
  }
  return spots;
}

function buildTrees(spots: TreeSpot[]) {
  const group = new THREE.Group();
  group.name = 'trees';
  const leaf = cached('m-leaf', () => new THREE.MeshStandardMaterial({ map: leafTexture(), roughness: 0.88, vertexColors: true }));
  const cards = cached('m-leaf-card', () => new THREE.MeshStandardMaterial({ map: leafCardTexture(), alphaTest: 0.4, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8, vertexColors: true }));
  const bark = cached('m-bark', () => new THREE.MeshStandardMaterial({ map: barkTexture(), roughness: 0.95 }));
  const rnd = mulberry32(77);
  const crown = (seed: number, blobs: [number, number, number, number, number][], count: number) => ({
    canopy: canopyGeometry(seed, shrink(blobs)),
    cards: cardGeometry(seed, blobs, count),
  });
  const kinds = cached('tree-kinds', () => [
    // neem and peepal: a broad, irregular crown
    { tall: false, ...crown(1, [[0, 6.4, 0, 3.1, 0.8], [2.1, 5.5, 0.6, 2.2, 0.8], [-1.9, 5.7, -0.9, 2.3, 0.8], [0.3, 5.3, -2, 2, 0.75], [-0.4, 7.6, 0.7, 2, 0.8]], 90), trunk: new THREE.CylinderGeometry(0.22, 0.34, 5, 7).translate(0, 2.5, 0), colour: [0.33, 0.47, 0.2] },
    // ashoka: the tall narrow column seen along boundary walls
    { tall: true, ...crown(2, [[0, 4.2, 0, 1.5, 1.5], [0, 7, 0, 1.3, 1.6], [0, 9.6, 0, 0.9, 1.6]], 50), trunk: new THREE.CylinderGeometry(0.14, 0.2, 3, 6).translate(0, 1.5, 0), colour: [0.2, 0.36, 0.16] },
  ]);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  for (const kind of kinds) {
    const list = spots.filter((s) => s.tall === kind.tall);
    if (!list.length) continue;
    const canopy = new THREE.InstancedMesh(kind.canopy, leaf, list.length);
    const sprays = new THREE.InstancedMesh(kind.cards, cards, list.length);
    const trunk = new THREE.InstancedMesh(kind.trunk, bark, list.length);
    list.forEach((s, i) => {
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      m.compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(s.scale, s.scale * (0.9 + rnd() * 0.25), s.scale));
      canopy.setMatrixAt(i, m);
      sprays.setMatrixAt(i, m);
      trunk.setMatrixAt(i, m);
      const v = 0.8 + rnd() * 0.5;
      c.setRGB(kind.colour[0] * v * (0.9 + rnd() * 0.3), kind.colour[1] * v, kind.colour[2] * v);
      // the textures carry their own green now, so the tint only nudges each tree's shade
      c.lerp(new THREE.Color(1, 1, 1), 0.55).multiplyScalar(1.15);
      canopy.setColorAt(i, c);
      sprays.setColorAt(i, c);
    });
    for (const mesh of [canopy, sprays, trunk]) {
      // the solid core casts the crown's shadow; alpha-cut cards in every shadow cascade cost more than they add
      mesh.castShadow = mesh !== sprays;
      mesh.receiveShadow = true;
      cullable(mesh);
      group.add(mesh);
    }
  }
  return group;
}

/** Soft round falloff for the pool of light a lamp throws on the road. */
function poolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LAMP_HEAD = new THREE.Vector3(0, 8.38, 2.1);
const SODIUM = 0xffb46b;

function buildLamps(tile: Tile) {
  const geo = cached('g-lamp', () => mergeGeometries([
    new THREE.CylinderGeometry(0.07, 0.11, 8.5, 8).translate(0, 4.25, 0),
    new THREE.BoxGeometry(0.08, 0.08, 2.2).translate(0, 8.4, 1),
    new THREE.BoxGeometry(0.34, 0.12, 0.8).translate(LAMP_HEAD.x, LAMP_HEAD.y, LAMP_HEAD.z),
  ])!);
  const matrices: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const r of tile.roads) {
    if (!isMajor(r)) continue;
    let carry = 9, side = 1;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i], az = r.pts[i + 1];
      const dx = r.pts[i + 2] - ax, dz = r.pts[i + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      for (let s = carry; s < len; s += 34) {
        const off = (r.width / 2 + 0.6) * side;
        // the arm reaches back over the carriageway
        q.setFromAxisAngle(up, Math.atan2(dx, dz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
        matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(ax + (dx / len) * s - (dz / len) * off, 0, az + (dz / len) * s + (dx / len) * off), q, new THREE.Vector3(1, 1, 1)));
        side = -side;
      }
      carry = (((carry - len) % 34) + 34) % 34;
    }
  }
  const group = new THREE.Group();
  group.name = 'street-lamps';
  const mesh = new THREE.InstancedMesh(geo, cached('m-lamp', () => new THREE.MeshStandardMaterial({ color: 0x74797c, roughness: 0.45, metalness: 0.85 })), matrices.length);
  mesh.castShadow = true;

  // the lamp itself: a glowing lens under the housing
  const lensMat = cached('m-lens', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x2a2620, emissive: SODIUM, emissiveIntensity: 0, roughness: 0.3 });
    onNight((n) => (m.emissiveIntensity = 14 * n));
    return m;
  });
  const lens = new THREE.InstancedMesh(cached('g-lens', () => new THREE.BoxGeometry(0.26, 0.02, 0.6).translate(LAMP_HEAD.x, LAMP_HEAD.y - 0.07, LAMP_HEAD.z)), lensMat, matrices.length);

  // the pool of light it throws on the road: cheap enough to draw under every lamp in the city
  const poolMat = cached('m-pool', () => {
    const m = new THREE.MeshBasicMaterial({ map: poolTexture(), color: SODIUM, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -8;
    m.polygonOffsetUnits = -32;
    onNight((n) => (m.opacity = 0.55 * n));
    return m;
  });
  const pool = new THREE.InstancedMesh(cached('g-pool', () => new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2).translate(LAMP_HEAD.x, 0.08, LAMP_HEAD.z)), poolMat, matrices.length);
  pool.renderOrder = 2;

  const heads: THREE.Vector3[] = [];
  const poles: Solid[] = [];
  matrices.forEach((m, i) => {
    poles.push({ x: m.elements[12], z: m.elements[14], r: 0.12, h: 8.5 });
    mesh.setMatrixAt(i, m);
    lens.setMatrixAt(i, m);
    pool.setMatrixAt(i, m);
    heads.push(LAMP_HEAD.clone().applyMatrix4(m));
  });
  for (const m of [mesh, lens, pool]) {
    cullable(m);
    group.add(m);
  }
  return { group, heads, poles };
}

/**
 * Real light from the lamps nearest the car, so the car and the kerbs are lit and not just the road.
 * ponytail: a fixed pool keeps forward-lighting cost flat; move to TiledLightsNode on WebGPU if more are wanted.
 */
export class LampLights {
  private lights: THREE.SpotLight[] = [];
  /** lamp heads in the map cells currently loaded */
  heads: THREE.Vector3[];
  private timer = 0;
  private intensity = 0;

  constructor(scene: THREE.Scene, heads: THREE.Vector3[], count: number) {
    this.heads = heads;
    for (let i = 0; i < count; i++) {
      const l = new THREE.SpotLight(SODIUM, 0, 32, 1.05, 0.65, 1.6);
      l.position.set(0, -1000, 0);
      scene.add(l, l.target);
      this.lights.push(l);
    }
    onNight((n) => {
      this.intensity = 130 * THREE.MathUtils.smoothstep(n, 0.3, 0.9);
      for (const l of this.lights) l.intensity = this.intensity;
    });
  }

  update(dt: number, car: THREE.Vector3) {
    this.timer -= dt;
    if (this.timer > 0 || this.heads.length < this.lights.length || this.intensity === 0) return;
    this.timer = 0.25;
    const near = this.heads
      .map((h) => ({ h, d: (h.x - car.x) ** 2 + (h.z - car.z) ** 2 }))
      .sort((a, b) => a.d - b.d);
    this.lights.forEach((l, i) => {
      const h = near[i].h;
      l.position.copy(h);
      l.target.position.set(h.x, 0, h.z);
    });
  }
}

/** Signal poles stand a little off the junction node OpenStreetMap gives. */
const signalSpots = (tile: Tile) => Array.from({ length: tile.signals.length / 2 }, (_, i): [number, number] => [tile.signals[i * 2] + 3.5, tile.signals[i * 2 + 1] + 3.5]);

const BUCKET = 50;
const bucketKey = (x: number, z: number) => `${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`;

/** Files `item` under every 50 m square the box touches. */
function fileBox(map: Map<string, number[]>, minX: number, minZ: number, maxX: number, maxZ: number, item: number) {
  for (let bx = Math.floor(minX / BUCKET); bx <= Math.floor(maxX / BUCKET); bx++) {
    for (let bz = Math.floor(minZ / BUCKET); bz <= Math.floor(maxZ / BUCKET); bz++) {
      const k = `${bx},${bz}`;
      const list = map.get(k);
      if (list) list.push(item);
      else map.set(k, [item]);
    }
  }
}

/** The widest margin anyone asks `roadIndex` about; segments are filed this far beyond their edges. */
const ROAD_REACH = 1;

/**
 * "Is this spot within `margin` of a carriageway's edge?" (negative: that far inside it), answered from the
 * road segments filed under the spot's 50 m square rather than every segment in the cell.
 */
function roadIndex(tile: Tile) {
  const segs: number[] = [];
  const at = new Map<string, number[]>();
  for (const r of tile.roads) {
    const p = r.pts, half = r.width / 2;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const n = segs.push(p[i], p[i + 1], p[i + 2], p[i + 3], half) - 5;
      const pad = half + ROAD_REACH;
      fileBox(at, Math.min(p[i], p[i + 2]) - pad, Math.min(p[i + 1], p[i + 3]) - pad, Math.max(p[i], p[i + 2]) + pad, Math.max(p[i + 1], p[i + 3]) + pad, n);
    }
  }
  return (x: number, z: number, margin: number) => {
    for (const i of at.get(bucketKey(x, z)) ?? []) {
      const ax = segs[i], az = segs[i + 1], dx = segs[i + 2] - ax, dz = segs[i + 3] - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) < segs[i + 4] + margin) return true;
    }
    return false;
  };
}

function buildSignals(tile: Tile) {
  const group = new THREE.Group();
  group.name = 'signals';
  const n = tile.signals.length / 2;
  if (!n) return group;
  const pole = new THREE.InstancedMesh(
    cached('g-signal', () => mergeGeometries([new THREE.CylinderGeometry(0.08, 0.1, 5.2, 8).translate(0, 2.6, 0), new THREE.BoxGeometry(0.42, 1.25, 0.3).translate(0, 4.7, 0.2)])!),
    cached('m-signal', () => new THREE.MeshStandardMaterial({ color: 0x1d1f1e, roughness: 0.6, metalness: 0.4 })),
    n,
  );
  const lamps = [0xff2a1c, 0xffb21c, 0x24e06a].map((colour, k) => {
    const on = k === 0;
    const mesh = new THREE.InstancedMesh(
      cached(`g-signal-lamp-${k}`, () => new THREE.CircleGeometry(0.13, 12).translate(0, 5.08 - k * 0.38, 0.36)),
      cached(`m-signal-lamp-${k}`, () => new THREE.MeshStandardMaterial({ color: on ? colour : 0x111111, emissive: colour, emissiveIntensity: on ? 6 : 0.15, roughness: 0.3 })),
      n,
    );
    return mesh;
  });
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const rnd = mulberry32(5);
  for (let i = 0; i < n; i++) {
    q.setFromAxisAngle(up, Math.floor(rnd() * 4) * (Math.PI / 2));
    const [sx, sz] = signalSpots(tile)[i];
    const m = new THREE.Matrix4().compose(new THREE.Vector3(sx, 0, sz), q, new THREE.Vector3(1, 1, 1));
    pole.setMatrixAt(i, m);
    lamps.forEach((l) => l.setMatrixAt(i, m));
  }
  pole.castShadow = true;
  for (const mesh of [pole, ...lamps]) {
    cullable(mesh);
    group.add(mesh);
  }
  return group;
}

/** The 63 m flagpole in Central Park: the landmark you see from every radial road. */
function buildFlag(plaza: [number, number]) {
  const group = new THREE.Group();
  group.name = 'central-park-flag';
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.55, 63, 12).translate(0, 31.5, 0), new THREE.MeshStandardMaterial({ color: 0xd8dadc, roughness: 0.35, metalness: 0.9 }));
  pole.castShadow = true;
  const cloth = new THREE.PlaneGeometry(27, 18, 24, 8);
  const p = cloth.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + 13.5;
    p.setZ(i, Math.sin(x * 0.55) * 0.9 * (x / 27) + Math.sin(x * 0.21 + p.getY(i) * 0.3) * 0.8 * (x / 27));
    p.setX(i, x + 0.3);
    p.setY(i, p.getY(i) + 53.5 - (x / 27) * 1.2);
  }
  cloth.computeVertexNormals();
  const flag = new THREE.Mesh(cloth, new THREE.MeshStandardMaterial({ map: flagTexture(), roughness: 0.85, side: THREE.DoubleSide }));
  flag.castShadow = true;
  group.add(pole, flag);
  group.position.set(plaza[0], 0, plaza[1]);
  group.rotation.y = 0.5;
  return group;
}

/** Something the car hits and stops against: an upright cylinder standing on the ground. */
export interface Solid {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** A kind of street furniture the car can knock flying: one instanced mesh, one physics body per instance. */
export interface Loose {
  mesh: THREE.InstancedMesh;
  /** where each instance stands at the start */
  poses: THREE.Matrix4[];
  /** half extents for a box, or [radius, half height] for a cylinder; centred on the body */
  shape: 'box' | 'cylinder';
  half: [number, number, number];
  /** how far the centre sits above the ground */
  lift: number;
  mass: number;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2c21b';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#16140f';
  for (let x = -64; x < 256; x += 48) {
    g.beginPath();
    g.moveTo(x, 64);
    g.lineTo(x + 24, 64);
    g.lineTo(x + 88, 0);
    g.lineTo(x + 64, 0);
    g.fill();
  }
  g.fillStyle = '#16140f';
  g.font = 'bold 15px Arial, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = '#c4141b';
  g.fillRect(84, 22, 88, 20);
  g.fillStyle = '#fff';
  g.fillText('DELHI POLICE', 128, 38);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Street furniture that moves when hit: Delhi Police barricades parked at the kerb of main roads,
 * green municipal bins on the pavements, and bollards where OpenStreetMap has them.
 */
function buildLoose(tile: Tile, onRoad: (x: number, z: number, margin: number) => boolean): Loose[] {
  const rnd = mulberry32(909);
  const up = new THREE.Vector3(0, 1, 0);
  const barricades: THREE.Matrix4[] = [];
  const bins: THREE.Matrix4[] = [];
  const autos: THREE.Matrix4[] = [];
  const along = (r: Tile['roads'][number], spacing: number, offset: (side: number) => number, out: THREE.Matrix4[], lift: number, chance: number, margin: number, turn = Math.PI / 2) => {
    let carry = rnd() * spacing, side = 1;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i], az = r.pts[i + 1];
      const dx = r.pts[i + 2] - ax, dz = r.pts[i + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      for (let s = carry; s < len; s += spacing) {
        side = -side;
        if (rnd() > chance) continue;
        const off = offset(side);
        const x = ax + (dx / len) * s - (dz / len) * off, z = az + (dz / len) * s + (dx / len) * off;
        // never inside another road: a side street would be blocked
        if (onRoad(x, z, margin)) continue;
        const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(dx, dz) + turn + (rnd() - 0.5) * 0.2);
        out.push(new THREE.Matrix4().compose(new THREE.Vector3(x, lift, z), q, new THREE.Vector3(1, 1, 1)));
      }
      carry = (((carry - len) % spacing) + spacing) % spacing;
    }
  };
  for (const r of tile.roads) {
    if (isMajor(r)) along(r, 140, (side) => (r.width / 2 - 0.5) * side, barricades, 0.55, 0.7, -0.7);
    if (isStreet(r)) along(r, 60, (side) => (r.width / 2 + 0.8) * side, bins, 0.5, 0.8, 0.3);
    // auto-rickshaws waiting at the kerb
    if (isStreet(r) && r.width >= 6) along(r, 110, (side) => (r.width / 2 - 1) * side, autos, 0.85, 0.35, -1.1, 0);
  }

  const bollards = (tile.bollards ?? []).reduce<THREE.Matrix4[]>((out, _v, i, a) => {
    if (i % 2 === 0) out.push(new THREE.Matrix4().makeTranslation(a[i], 0.45, a[i + 1]));
    return out;
  }, []);

  const steel = cached('m-steel', () => new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.6 }));
  const barricadeGeo = cached('g-barricade', () => mergeGeometries([
    new THREE.BoxGeometry(2.0, 0.42, 0.05).translate(0, 0.28, 0),
    new THREE.BoxGeometry(2.0, 0.08, 0.06).translate(0, -0.07, 0),
    new THREE.BoxGeometry(0.06, 1.1, 0.06).translate(-0.95, 0, 0),
    new THREE.BoxGeometry(0.06, 1.1, 0.06).translate(0.95, 0, 0),
    new THREE.BoxGeometry(0.1, 0.04, 0.7).translate(-0.95, -0.53, 0),
    new THREE.BoxGeometry(0.1, 0.04, 0.7).translate(0.95, -0.53, 0),
  ], true)!);
  const stripes = cached('m-stripes', () => new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.6 }));
  const barricadeMats = [stripes, steel, steel, steel, steel, steel];
  const binGeo = cached('g-bin', () => new THREE.CylinderGeometry(0.3, 0.26, 1, 14));
  const binMat = cached('m-bin', () => new THREE.MeshStandardMaterial({ color: 0x2d7a3a, roughness: 0.55 }));
  const bollardGeo = cached('g-bollard', () => new THREE.CylinderGeometry(0.11, 0.13, 0.9, 10));
  const bollardMat = cached('m-bollard', () => new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.5, metalness: 0.4 }));

  const make = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], poses: THREE.Matrix4[], rest: Omit<Loose, 'mesh' | 'poses'>): Loose => {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, poses.length));
    mesh.count = poses.length;
    poses.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    cullable(mesh);
    return { mesh, poses, ...rest };
  };
  // green CNG body, yellow canvas hood: the Delhi auto
  const autoGeo = cached('g-auto', () => mergeGeometries([
    new THREE.BoxGeometry(1.3, 0.7, 2.5).translate(0, -0.3, 0),
    new THREE.BoxGeometry(1.0, 0.8, 0.5).translate(0, 0.1, 1.05),
    new THREE.BoxGeometry(1.4, 0.08, 2.0).translate(0, 0.82, -0.2),
    new THREE.BoxGeometry(1.4, 1.0, 0.08).translate(0, 0.33, -1.2),
    new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12).rotateZ(Math.PI / 2).translate(0, -0.63, 1.1),
    new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12).rotateZ(Math.PI / 2).translate(0.6, -0.63, -0.9),
    new THREE.CylinderGeometry(0.22, 0.22, 0.14, 12).rotateZ(Math.PI / 2).translate(-0.6, -0.63, -0.9),
    new THREE.BoxGeometry(0.05, 1.0, 0.05).translate(0.62, 0.33, 0.78),
    new THREE.BoxGeometry(0.05, 1.0, 0.05).translate(-0.62, 0.33, 0.78),
  ], true)!);
  const autoGreen = cached('m-auto-green', () => new THREE.MeshStandardMaterial({ color: 0x1f7a3c, roughness: 0.35, metalness: 0.3 }));
  const autoYellow = cached('m-auto-yellow', () => new THREE.MeshStandardMaterial({ color: 0xe6b81e, roughness: 0.7 }));
  const black = cached('m-black', () => new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  const autoMats = [autoGreen, autoGreen, autoYellow, autoYellow, black, black, black, black, black];
  return [
    make(autoGeo, autoMats, autos, { shape: 'box', half: [0.7, 0.85, 1.3], lift: 0.85, mass: 350 }),
    make(barricadeGeo, barricadeMats, barricades, { shape: 'box', half: [1.0, 0.55, 0.35], lift: 0.55, mass: 45 }),
    make(binGeo, binMat, bins, { shape: 'cylinder', half: [0.3, 0.5, 0.3], lift: 0.5, mass: 14 }),
    make(bollardGeo, bollardMat, bollards, { shape: 'cylinder', half: [0.13, 0.45, 0.13], lift: 0.45, mass: 30 }),
  ];
}

/** `plaza` is where the CP flagpole stands; only the cell that holds it builds it. */
export function buildProps(tile: Tile, plaza: [number, number], treeDensity: number) {
  const { minX, maxX, minZ, maxZ } = tile.bounds;
  const hasFlag = plaza[0] >= minX && plaza[0] < maxX && plaza[1] >= minZ && plaza[1] < maxZ;
  const group = new THREE.Group();
  group.name = 'props';
  const spots = placeTrees(tile, treeDensity);
  const lamps = buildLamps(tile);
  const loose = buildLoose(tile, roadIndex(tile));
  group.add(buildTrees(spots), lamps.group, buildSignals(tile), ...loose.map((l) => l.mesh));
  if (hasFlag) group.add(buildFlag(plaza));
  const solids: Solid[] = [
    ...spots.map((s) => ({ x: s.x, z: s.z, r: (s.tall ? 0.18 : 0.3) * s.scale, h: s.tall ? 3 : 5 })),
    ...lamps.poles,
    ...signalSpots(tile).map(([x, z]) => ({ x, z, r: 0.1, h: 5.2 })),
    ...(hasFlag ? [{ x: plaza[0], z: plaza[1], r: 0.55, h: 63 }] : []),
  ];
  return { group, treeCount: spots.length, lampHeads: lamps.heads, solids, loose };
}
