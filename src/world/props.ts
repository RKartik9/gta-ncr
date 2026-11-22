import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Tile } from './tile.ts';
import { isMajor, isStreet } from './ground.ts';
import type { Chunks } from './chunks.ts';
import { type Budget, cached, mulberry32, pointInRing, ringArea } from '../util.ts';
import { Instances, instanced } from '../render/instances.ts';
import { barkTexture, flagTexture, leafCardTexture, leafTexture } from '../render/textures.ts';
import { onNight } from '../render/sky.ts';
import { attribute, color, float, mix, texture, uniform, vec4 } from 'three/tsl';

/** A material for `Instances`: everything that stands in the street is drawn as many copies of one shape. */
const std = (p: ConstructorParameters<typeof THREE.MeshStandardNodeMaterial>[0], tinted = false) => instanced(new THREE.MeshStandardNodeMaterial(p), tinted);

/** Lumpy canopy built from a few displaced spheres, darker underneath to fake self-shadowing. */
function canopyGeometry(seed: number, blobs: [number, number, number, number, number][]) {
  const parts = blobs.map(([x, y, z, r, squash], n) => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1); // ponytail: detail 2 on the main blob cost ~1M triangles a city; the leaf cards hide the facets
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

async function placeTrees(tile: Tile, density: number, budget: Budget): Promise<TreeSpot[]> {
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
    return roads(x, z, 1);
  };
  const tryAdd = (x: number, z: number, tall: boolean) => {
    // Each cell plants only its own ground. A cell's roads run on past its edge, so the avenue along a road
    // that crosses the border is still planted, once, by whichever cell the tree stands in; planting past the
    // edge doubled trees there and put them on the neighbour's roads, which this cell cannot see.
    if (!inside(tile, x, z) || blocked(x, z)) return;
    spots.push({ x, z, scale: 0.75 + rnd() * 0.6, tall });
  };

  for (let i = 0; i < tile.trees.length; i += 2) tryAdd(tile.trees[i], tile.trees[i + 1], false);

  // Avenue trees: Lutyens' Delhi is planted road by road, a single species per avenue.
  for (const r of tile.roads) {
    if (!isStreet(r)) continue;
    if (budget.due) await budget.wait();
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
    if (budget.due) await budget.wait();
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

function buildTrees(spots: TreeSpot[], chunks: Chunks) {
  const leaf = cached('m-leaf', () => std({ map: leafTexture(), roughness: 0.88, vertexColors: true }, true));
  const cards = cached('m-leaf-card', () => std({ map: leafCardTexture(), alphaTest: 0.4, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8, vertexColors: true }, true));
  const bark = cached('m-bark', () => std({ map: barkTexture(), roughness: 0.95 }));
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
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  for (const [chunk, here] of chunks.bucket(spots, (s) => [s.x, s.z])) for (const kind of kinds) {
    const list = here.filter((s) => s.tall === kind.tall);
    if (!list.length) continue;
    const poses = list.map((s) => {
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      return new THREE.Matrix4().compose(new THREE.Vector3(s.x, 0, s.z), q, new THREE.Vector3(s.scale, s.scale * (0.9 + rnd() * 0.25), s.scale));
    });
    const canopy = new Instances(kind.canopy, leaf, poses);
    const sprays = new Instances(kind.cards, cards, poses);
    const trunk = new Instances(kind.trunk, bark, poses);
    list.forEach((_s, i) => {
      const v = 0.8 + rnd() * 0.5;
      c.setRGB(kind.colour[0] * v * (0.9 + rnd() * 0.3), kind.colour[1] * v, kind.colour[2] * v);
      // the textures carry their own green now, so the tint only nudges each tree's shade
      c.lerp(new THREE.Color(1, 1, 1), 0.55).multiplyScalar(1.15);
      canopy.setColorAt(i, c);
      sprays.setColorAt(i, c);
    });
    for (const mesh of [canopy, sprays, trunk]) {
      // the solid core casts the crown's shadow; alpha-cut cards in every shadow cascade cost more than they add,
      // and a trunk's shadow is lost under its own crown's
      mesh.castShadow = mesh === canopy;
      mesh.receiveShadow = true;
      // from far off the solid crown is enough; the leaf sprays are thousands of see-through cards
      (mesh === sprays ? chunk.near : chunk.far).add(mesh);
    }
  }
}

/** Soft round falloff for the pool of light a lamp throws on the road. */
export function poolTexture() {
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

/** A soft round glow: a bright core fading out. For the halo round a lit lamp. */
const glowTexture = () => cached('t-glow', () => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.12, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
});

/** Glows are drawn without fog, additively and over everything behind them: a lit lamp shows down the whole street. */
const glowMaterial = () => {
  const m = instanced(new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  return m;
};

/** 0 by day, 1 at night, for the glows' shaders */
const nightLevel = uniform(0);
onNight((n) => (nightLevel.value = n));

const LAMP_HEAD = new THREE.Vector3(0, 8.38, 2.1);
const SODIUM = 0xffb46b;

function buildLamps(tile: Tile, onRoad: ReturnType<typeof roadIndex>, chunks: Chunks) {
  // pole, arm and housing, then the lens as a second material: one mesh, so the lot falls over together
  const geo = cached('g-lamp', () => mergeGeometries([
    mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.11, 8.5, 8).translate(0, 4.25, 0),
      new THREE.BoxGeometry(0.08, 0.08, 2.2).translate(0, 8.4, 1),
      new THREE.BoxGeometry(0.34, 0.12, 0.8).translate(LAMP_HEAD.x, LAMP_HEAD.y, LAMP_HEAD.z),
    ])!,
    new THREE.BoxGeometry(0.26, 0.02, 0.6).translate(LAMP_HEAD.x, LAMP_HEAD.y - 0.07, LAMP_HEAD.z),
  ], true)!);
  const matrices: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const r of tile.roads) {
    // main roads every 34 m, alternating sides; ordinary streets every 45 m, so no street is left dark
    if (!isStreet(r) || r.kind === 'path') continue;
    const every = isMajor(r) ? 34 : 45;
    let carry = 9, side = 1;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i], az = r.pts[i + 1];
      const dx = r.pts[i + 2] - ax, dz = r.pts[i + 3] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      for (let s = carry; s < len; s += every) {
        const off = (r.width / 2 + 0.6) * side;
        const x = ax + (dx / len) * s - (dz / len) * off, z = az + (dz / len) * s + (dx / len) * off;
        side = -side;
        // at a junction the kerb of this road is the middle of the one crossing it: no pole there
        if (!inside(tile, x, z) || onRoad(x, z, 0.3)) continue;
        // the arm reaches back over the carriageway
        q.setFromAxisAngle(up, Math.atan2(dx, dz) + (side < 0 ? Math.PI / 2 : -Math.PI / 2)); // `side` was flipped above: it is the other kerb's sign
        matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, 1, 1)));
      }
      carry = (((carry - len) % every) + every) % every;
    }
  }
  // the lamp itself: a glowing lens under the housing
  const lensMat = cached('m-lens', () => {
    const m = std({ color: 0x2a2620, emissive: SODIUM, emissiveIntensity: 0, roughness: 0.3 });
    onNight((n) => (m.emissiveIntensity = 30 * n));
    return m;
  });

  // the pool of light it throws on the road: cheap enough to draw under every lamp in the city
  const poolMat = cached('m-pool', () => {
    const m = instanced(new THREE.MeshBasicNodeMaterial({ map: poolTexture(), color: SODIUM, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    m.polygonOffset = true;
    m.polygonOffsetFactor = -8;
    m.polygonOffsetUnits = -32;
    onNight((n) => {
      m.opacity = 0.85 * n;
      m.visible = n > 0.01; // by day there is nothing to draw, and every lamp in view would still be a draw call
    });
    return m;
  });

  // the halo round the lit lamp, seen from every side and from down the street: two crossed upright cards
  const haloMat = cached('m-lamp-halo', () => {
    const m = glowMaterial();
    m.colorNode = vec4(color(SODIUM), texture(glowTexture()).a.mul(nightLevel).mul(0.9));
    onNight((n) => (m.visible = n > 0.01));
    return m;
  });
  const haloGeo = cached('g-lamp-halo', () => {
    const at = LAMP_HEAD.clone().add(new THREE.Vector3(0, -0.2, 0));
    return mergeGeometries([0, Math.PI / 2].map((a) => new THREE.PlaneGeometry(3.2, 3.2).rotateY(a).translate(at.x, at.y, at.z)))!;
  });

  const heads: THREE.Vector3[] = [];
  const loose: Loose[] = [];
  const mats = [cached('m-lamp', () => std({ color: 0x74797c, roughness: 0.45, metalness: 0.85 })), lensMat];
  for (const [chunk, poses] of chunks.bucket(matrices, (m) => [m.elements[12], m.elements[14]])) {
    const mesh = new Instances(geo, mats, poses, true);
    mesh.castShadow = true;
    const halo = new Instances(haloGeo, haloMat, poses, true);
    halo.renderOrder = 3;
    const pool = new Instances(cached('g-pool', () => new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2).translate(LAMP_HEAD.x, 0.08, LAMP_HEAD.z)), poolMat, poses, true);
    pool.renderOrder = 2;
    const mine = poses.map((m) => LAMP_HEAD.clone().applyMatrix4(m));
    heads.push(...mine);
    chunk.far.add(mesh, pool, halo);
    // a pole stands until something hits it hard enough; once it goes over, it no longer lights the road
    loose.push({
      mesh, poses, shape: 'cylinder', half: [0.11, 4.25, 0.11], lift: 4.25, drop: 4.25, mass: 95,
      onTopple: (i) => {
        for (const m of [pool, halo]) {
          m.setMatrixAt(i, GONE);
          m.instanceMatrix.needsUpdate = true;
        }
        mine[i].set(1e9, 0, 1e9); // out of reach of `LampLights`
      },
    });
  }
  return { heads, loose };
}

const GONE = new THREE.Matrix4().makeScale(0, 0, 0);

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
  private best: THREE.Vector3[] = [];
  private dist: number[] = [];

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
    // nearest few by insertion into a short list: no sorting thousands of lamps four times a second
    const k = this.lights.length, best = this.best, dist = this.dist;
    best.length = dist.length = 0;
    for (const h of this.heads) {
      const d = (h.x - car.x) ** 2 + (h.z - car.z) ** 2;
      if (best.length === k && d >= dist[k - 1]) continue;
      let i = Math.min(best.length, k - 1);
      while (i > 0 && dist[i - 1] > d) {
        best[i] = best[i - 1];
        dist[i] = dist[i - 1];
        i--;
      }
      best[i] = h;
      dist[i] = d;
    }
    this.lights.forEach((l, i) => {
      const h = best[i];
      l.position.copy(h);
      l.target.position.set(h.x, 0, h.z);
    });
  }
}

/**
 * OpenStreetMap puts a signal on the junction node, in the middle of the road. The pole goes on the nearest
 * corner clear of every carriageway; a junction with no clear corner close by gets none.
 */
function signalSpots(tile: Tile, onRoad: ReturnType<typeof roadIndex>) {
  const out: [number, number, number][] = [];
  for (let i = 0; i < tile.signals.length; i += 2) {
    const sx = tile.signals[i], sz = tile.signals[i + 1];
    if (!inside(tile, sx, sz)) continue;
    search: for (let d = 3.5; d <= 16; d += 1.5) {
      for (let a = 0; a < 8; a++) {
        const x = sx + Math.cos(Math.PI / 4 + (a * Math.PI) / 4) * d, z = sz + Math.sin(Math.PI / 4 + (a * Math.PI) / 4) * d;
        if (!onRoad(x, z, 0.6)) {
          out.push([x, z, Math.atan2(sx - x, sz - z)]); // lights face the junction
          break search;
        }
      }
    }
  }
  return out;
}

/** Each cell owns what stands on its own ground, so nothing is built twice where cells meet. */
const inside = (tile: Tile, x: number, z: number) => x >= tile.bounds.minX && x < tile.bounds.maxX && z >= tile.bounds.minZ && z < tile.bounds.maxZ;

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

const RED = new THREE.Color(1, 0, 0);
/** Every signal mesh loaded, with where each copy stands and which way it faces, for the traffic to light by its phases. */
export const signalMeshes = new Set<{ mesh: Instances; halo: Instances; spots: [number, number, number][]; phase?: number[] }>();

function buildSignals(spots: [number, number, number][], chunks: Chunks): Loose[] {
  // the pole and head, then the three lamps, each its own material: one mesh, so the lot falls over together
  const geo = cached('g-signal', () => mergeGeometries([
    mergeGeometries([new THREE.CylinderGeometry(0.08, 0.1, 5.2, 8).translate(0, 2.6, 0), new THREE.BoxGeometry(0.42, 1.25, 0.3).translate(0, 4.7, 0.2)])!,
    ...[0, 1, 2].map((k) => new THREE.CircleGeometry(0.13, 12).translate(0, 5.08 - k * 0.38, 0.36)),
  ], true)!);
  const mats = [
    cached('m-signal', () => std({ color: 0x1d1f1e, roughness: 0.6, metalness: 0.4 })),
    // each copy's tint says which of its lamps is lit (red, amber, green), so every signal shows its own phase
    ...[0xff2a1c, 0xffb21c, 0x24e06a].map((colour, k) => cached(`m-signal-lamp-${k}`, () => {
      const m = std({ roughness: 0.3 });
      const on = attribute('icol', 'vec3')[(['x', 'y', 'z'] as const)[k]];
      m.colorNode = vec4(mix(color(0x111111), color(colour), on), 1);
      m.emissiveNode = color(colour).mul(mix(float(0.15), float(6), on));
      return m;
    })),
  ];
  // a glow in front of each lamp, lit with it: faint by day, bright at night, and drawn as far as the street is
  const haloGeo = cached('g-signal-halo', () => mergeGeometries([0, 1, 2].map((k) => new THREE.PlaneGeometry(1.5, 1.5).translate(0, 5.08 - k * 0.38, 0.4)), true)!);
  const haloMats = [0xff2a1c, 0xffb21c, 0x24e06a].map((colour, k) => cached(`m-signal-halo-${k}`, () => {
    const m = glowMaterial();
    const on = attribute('icol', 'vec3')[(['x', 'y', 'z'] as const)[k]];
    m.colorNode = vec4(color(colour), texture(glowTexture()).a.mul(on).mul(mix(float(0.25), float(1), nightLevel)));
    return m;
  }));
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const loose: Loose[] = [];
  for (const [chunk, here] of chunks.bucket(spots, ([x, z]) => [x, z])) {
    const poses = here.map(([sx, sz, facing]) => {
      q.setFromAxisAngle(up, facing);
      return new THREE.Matrix4().compose(new THREE.Vector3(sx, 0, sz), q, new THREE.Vector3(1, 1, 1));
    });
    const mesh = new Instances(geo, mats, poses, true);
    const halo = new Instances(haloGeo, haloMats, poses, true);
    halo.renderOrder = 3;
    here.forEach((_, i) => {
      mesh.setColorAt(i, RED);
      halo.setColorAt(i, RED);
    });
    signalMeshes.add({ mesh, halo, spots: here });
    mesh.castShadow = true;
    chunk.near.add(mesh);
    chunk.far.add(halo);
    // a signal knocked over goes dark
    const onTopple = (i: number) => {
      halo.setMatrixAt(i, GONE);
      halo.instanceMatrix.needsUpdate = true;
    };
    loose.push({ mesh, poses, shape: 'cylinder', half: [0.1, 2.6, 0.1], lift: 2.6, drop: 2.6, mass: 70, onTopple });
  }
  return loose;
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
  mesh: Instances;
  /** where each instance stands at the start */
  poses: THREE.Matrix4[];
  /** half extents for a box, or [radius, half height] for a cylinder; centred on the body */
  shape: 'box' | 'cylinder';
  half: [number, number, number];
  /** how far the centre sits above the ground */
  lift: number;
  /** how far the mesh's own origin sits below that centre: a pole is modelled from its foot */
  drop?: number;
  mass: number;
  /** called once, when instance `i` has been knocked well off upright */
  onTopple?: (i: number) => void;
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
function buildLoose(tile: Tile, onRoad: (x: number, z: number, margin: number) => boolean, chunks: Chunks): Loose[] {
  const rnd = mulberry32(909);
  const up = new THREE.Vector3(0, 1, 0);
  const barricades: THREE.Matrix4[] = [];
  const bins: THREE.Matrix4[] = [];
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
        // never inside another road (a side street would be blocked), and placed once, by the cell it stands in
        if (!inside(tile, x, z) || onRoad(x, z, margin)) continue;
        const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(dx, dz) + turn + (rnd() - 0.5) * 0.2);
        out.push(new THREE.Matrix4().compose(new THREE.Vector3(x, lift, z), q, new THREE.Vector3(1, 1, 1)));
      }
      carry = (((carry - len) % spacing) + spacing) % spacing;
    }
  };
  for (const r of tile.roads) {
    if (isMajor(r)) along(r, 140, (side) => (r.width / 2 - 0.5) * side, barricades, 0.55, 0.7, -0.7);
    if (isStreet(r)) along(r, 60, (side) => (r.width / 2 + 0.8) * side, bins, 0.5, 0.8, 0.3);
  }

  const bollards = (tile.bollards ?? []).reduce<THREE.Matrix4[]>((out, _v, i, a) => {
    if (i % 2 === 0) out.push(new THREE.Matrix4().makeTranslation(a[i], 0.45, a[i + 1]));
    return out;
  }, []);

  const steel = cached('m-steel', () => std({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.6 }));
  // parts that share a material are merged first: each material group is a draw call of its own
  const barricadeGeo = cached('g-barricade', () => mergeGeometries([
    new THREE.BoxGeometry(2.0, 0.42, 0.05).translate(0, 0.28, 0),
    mergeGeometries([
      new THREE.BoxGeometry(2.0, 0.08, 0.06).translate(0, -0.07, 0),
      new THREE.BoxGeometry(0.06, 1.1, 0.06).translate(-0.95, 0, 0),
      new THREE.BoxGeometry(0.06, 1.1, 0.06).translate(0.95, 0, 0),
      new THREE.BoxGeometry(0.1, 0.04, 0.7).translate(-0.95, -0.53, 0),
      new THREE.BoxGeometry(0.1, 0.04, 0.7).translate(0.95, -0.53, 0),
    ])!,
  ], true)!);
  const stripes = cached('m-stripes', () => std({ map: stripeTexture(), roughness: 0.6 }));
  const barricadeMats = [stripes, steel];
  const binGeo = cached('g-bin', () => new THREE.CylinderGeometry(0.3, 0.26, 1, 14));
  const binMat = cached('m-bin', () => std({ color: 0x2d7a3a, roughness: 0.55 }));
  const bollardGeo = cached('g-bollard', () => new THREE.CylinderGeometry(0.11, 0.13, 0.9, 10));
  const bollardMat = cached('m-bollard', () => std({ color: 0x24262a, roughness: 0.5, metalness: 0.4 }));

  const make = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], all: THREE.Matrix4[], rest: Omit<Loose, 'mesh' | 'poses'>): Loose[] =>
    [...chunks.bucket(all, (m) => [m.elements[12], m.elements[14]])].map(([chunk, poses]) => {
      const mesh = new Instances(geo, mat, poses, true);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      chunk.near.add(mesh);
      return { mesh, poses, ...rest };
    });
  return [
    ...make(barricadeGeo, barricadeMats, barricades, { shape: 'box', half: [1.0, 0.55, 0.35], lift: 0.55, mass: 45 }),
    ...make(binGeo, binMat, bins, { shape: 'cylinder', half: [0.3, 0.5, 0.3], lift: 0.5, mass: 14 }),
    ...make(bollardGeo, bollardMat, bollards, { shape: 'cylinder', half: [0.13, 0.45, 0.13], lift: 0.45, mass: 30 }),
  ];
}

/** `plaza` is where the CP flagpole stands; only the cell that holds it builds it. */
export async function buildProps(tile: Tile, plaza: [number, number], treeDensity: number, chunks: Chunks, budget: Budget) {
  const { minX, maxX, minZ, maxZ } = tile.bounds;
  const hasFlag = plaza[0] >= minX && plaza[0] < maxX && plaza[1] >= minZ && plaza[1] < maxZ;
  const spots = await placeTrees(tile, treeDensity, budget);
  buildTrees(spots, chunks);
  if (budget.due) await budget.wait();
  const roads = roadIndex(tile);
  const lamps = buildLamps(tile, roads, chunks);
  if (budget.due) await budget.wait();
  const signals = buildSignals(signalSpots(tile, roads), chunks);
  const loose = [...buildLoose(tile, roads, chunks), ...lamps.loose, ...signals];
  if (hasFlag) chunks.at(plaza[0], plaza[1]).far.add(buildFlag(plaza));
  // trees and the flagpole stop the car dead; everything else gives way
  const solids: Solid[] = [
    ...spots.map((s) => ({ x: s.x, z: s.z, r: (s.tall ? 0.18 : 0.3) * s.scale, h: s.tall ? 3 : 5 })),
    ...(hasFlag ? [{ x: plaza[0], z: plaza[1], r: 0.55, h: 63 }] : []),
  ];
  return { treeCount: spots.length, lampHeads: lamps.heads, solids, loose };
}
