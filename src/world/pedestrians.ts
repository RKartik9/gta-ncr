import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Road } from './tile.ts';
import { attribute, luminance, materialColor, mix, normalLocal, positionLocal, step, textureLoad, uint, uvec2, vertexIndex } from 'three/tsl';
import { Instances, instanced } from '../render/instances.ts';
import { type Pose, type V3, posedFigures } from '../vehicle/rider.ts';
import { shout } from '../hud/shouts.ts';

/** A walk cycle in this many frozen frames; each walker is drawn in whichever frame its stride has reached. One more, after them, is standing. */
const FRAMES = 16;
/** metres walked in one full cycle (two steps) */
const STRIDE = 1.5;
/** walkers further than this from the player are not drawn (they are small, and each one is a whole figure) */
const DRAWN = 90;
const BUCKET = 100;
/** the people, under public/models (credits in people/license.txt), and how tall each stands */
export const FIGURES: [string, number][] = [
  ['rider/model.glb', 1.75], ['people/man_arab.glb', 1.76], ['people/man_guy.glb', 1.72],
  ['people/woman_casual.glb', 1.63], ['people/woman_girl.glb', 1.6], ['people/woman_office.glb', 1.66],
];

interface Side {
  /** flat [x, z, ...]: a road's centre line pushed out onto its pavement on one side */
  pts: number[];
  /** the pavement across the road, point for point; and the road's width */
  partner?: Side;
  width: number;
}

/** A vehicle on the road, for judging a gap to cross in. */
type Mover = { x: number; z: number; vx: number; vz: number };

export interface Walker {
  on: boolean;
  side: Side;
  /** where along the pavement they have got to: which segment of the side, how far along it, and which way they walk */
  seg: number;
  t: number;
  dir: 1 | -1;
  /** the pace they like, m/s */
  speed: number;
  /** how far to their own left of the pavement's line they like to walk: people spread across it */
  lane: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  /** how far through the walk cycle, 0 to 1 */
  phase: number;
  scale: number;
  /** which of the loaded figures this is */
  figure: number;
  /** what they are wearing */
  top: THREE.Color;
  bottom: THREE.Color;
  /**
   * walk: along the pavement. idle: stopped a while (a shop window, a phone). wait: at the kerb for a gap in the
   * traffic. cross: over the road to the pavement opposite. down: knocked down by a car, flat until `timer` runs out.
   * flee: running from trouble at (tx, tz) until `timer` runs out. taken: in a fight or knocked off their feet, and
   * for as long as that lasts someone else's to move and draw (character/combat.ts).
   */
  state: 'walk' | 'down' | 'idle' | 'wait' | 'cross' | 'flee' | 'taken';
  /** 0 to 1: the timid run from a fight, most stop and look, the bold hit back or join in */
  nerve: number;
  timer: number;
  /** seconds until they next make up their mind what to do */
  decide: number;
  /** where a crossing ends */
  tx: number;
  tz: number;
  /** seconds left of hurrying: a car coming, or a horn */
  hurry: number;
  vy: number;
  y: number;
  /** seconds until they will say anything to the player again */
  quiet: number;
  /** seconds until they turn on the driver who nearly ran them down; 0 if nobody did */
  grudge: number;
  /** where they stood at the start of the frame, for sweeping the way they went for walls */
  ox: number;
  oz: number;
}

/** body radius, metres: two people closer than twice this are touching */
const RADIUS = 0.27;
/** Social forces (Helbing's model): how hard people push off one another and off obstacles, and how quickly it fades with distance. */
const PUSH = 2.2, RANGE = 0.32, WALL_PUSH = 3.5, WALL_RANGE = 0.18;
/** seconds to get back to the pace and heading they want */
const RELAX = 0.5;
/** How far ahead along the pavement they aim. */
const LOOK = 2.5;
/** what a walker can bump into in the physics world: everything but the ground */
const QUERY_GROUPS = (0x0020 << 16) | (0xffff & ~0x0002);

/**
 * Walk cycle frame k: legs and arms swinging in opposite pairs, the knee folding as the foot comes through.
 * `stride` 0 is standing still: legs straight, arms hanging.
 */
export function walkPose(k: number, stride = 1): Pose {
  const a = (k / FRAMES) * Math.PI * 2;
  const leg = (phase: number): [V3, V3] => {
    const swing = Math.sin(phase) * 0.42 * stride;
    const bend = Math.max(0, Math.sin(phase + 1.3)) * 0.75 * stride + 0.05;
    return [[0.04, -Math.cos(swing), Math.sin(swing)], [0, -Math.cos(swing - bend), Math.sin(swing - bend)]];
  };
  const arm = (phase: number): [V3, V3] => {
    const swing = -Math.sin(phase) * 0.35 * stride;
    return [[0.16, -Math.cos(swing), Math.sin(swing)], [0.04, -Math.cos(swing + 0.35), Math.sin(swing + 0.35)]];
  };
  const [lu, ll] = leg(a), [ru, rl] = leg(a + Math.PI), [la, lf] = arm(a), [ra, rf] = arm(a + Math.PI);
  return {
    Hips: [0, 1, 0], Spine: [0, 1, 0.02], Spine1: [0, 1, 0.02], Spine2: [0, 1, 0], Neck: [0, 1, 0.08], Head: [0, 1, 0],
    LeftUpLeg: lu, LeftLeg: ll, LeftFoot: [0.03, -0.3, 1],
    RightUpLeg: [-ru[0], ru[1], ru[2]], RightLeg: [-rl[0], rl[1], rl[2]], RightFoot: [-0.03, -0.3, 1],
    LeftArm: la, LeftForeArm: lf, RightArm: [-ra[0], ra[1], ra[2]], RightForeArm: [-rf[0], rf[1], rf[2]],
  };
}

/** Frame k of `of` of a run: a long stride, the heel coming up behind, elbows bent and pumping. */
export function runPose(k: number, of: number): Pose {
  const a = (k / of) * Math.PI * 2;
  const leg = (phase: number): [V3, V3] => {
    const swing = Math.sin(phase) * 0.8 + 0.15, bend = Math.max(0, Math.sin(phase + 1.3)) * 1.5 + 0.25;
    return [[0.04, -Math.cos(swing), Math.sin(swing)], [0, -Math.cos(swing - bend), Math.sin(swing - bend)]];
  };
  const arm = (phase: number): [V3, V3] => {
    const swing = -Math.sin(phase) * 0.8;
    return [[0.14, -Math.cos(swing), Math.sin(swing)], [-0.05, -Math.cos(swing + 1.5), Math.sin(swing + 1.5)]];
  };
  const [lu, ll] = leg(a), [ru, rl] = leg(a + Math.PI), [la, lf] = arm(a), [ra, rf] = arm(a + Math.PI);
  return {
    Hips: [0, 1, 0.1], Spine: [0, 1, 0.18], Spine1: [0, 1, 0.2], Spine2: [0, 1, 0.2], Neck: [0, 1, 0.1], Head: [0, 1, -0.05],
    LeftUpLeg: lu, LeftLeg: ll, LeftFoot: [0.03, -0.5, 1],
    RightUpLeg: [-ru[0], ru[1], ru[2]], RightLeg: [-rl[0], rl[1], rl[2]], RightFoot: [-0.03, -0.5, 1],
    LeftArm: la, LeftForeArm: lf, RightArm: [-ra[0], ra[1], ra[2]], RightForeArm: [-rf[0], rf[1], rf[2]],
  };
}

/** Each figure's frames: the walk (0 to FRAMES - 1), standing (STAND), then a run (RUN_FRAMES). */
const STAND = FRAMES, RUN_FRAMES = 8, RUN = STAND + 1;
const framePoses = (): Pose[] => [
  ...Array.from({ length: FRAMES }, (_, k) => walkPose(k)), walkPose(0, 0),
  ...Array.from({ length: RUN_FRAMES }, (_, k) => runPose(k, RUN_FRAMES)),
];

/**
 * A figure's material, remade as a node material that draws `Instances`. The clothes are dyed per person: the
 * texture's light and shade kept, its colour swapped for the copy's own (top: its colour, bottom: its spare numbers),
 * so six figures make a street of different people.
 */
function nodeMaterial(m: THREE.Material, pose: () => void) {
  const src = m as THREE.MeshStandardMaterial;
  const node = new THREE.MeshStandardNodeMaterial({
    color: src.color, map: src.map, normalMap: src.normalMap, roughness: src.roughness, metalness: src.metalness,
    roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap, side: src.side, alphaTest: src.transparent || src.alphaTest ? 0.5 : 0,
  });
  const dye = src.name.includes('Outfit_Top') ? 'icol' : src.name.includes('Outfit_Bottom') ? 'iext' : null;
  if (dye) {
    // black means keep the clothes as made: a fighter handed back to the pavement looks as they did in the fight
    const tint = attribute(dye, 'vec3');
    node.colorNode = mix(materialColor, luminance(materialColor).mul(1.7).mul(tint).min(1), step(0.001, tint.x.add(tint.y).add(tint.z)).mul(0.85));
  }
  return instanced(node, false, pose);
}

// What Delhi wears: white and pastel kurtas and shirts, saffron, maroon, mustard, a pink or green saree, black and navy;
// below, jeans, black and khaki trousers, white pyjama, a brown salwar.
const TOPS = [0xf2efe6, 0xf2efe6, 0x9cc3e0, 0x7a1f2b, 0xe8892b, 0xd9a521, 0xd6578a, 0x2f7a4a, 0x1d1f22, 0x24345e, 0x8a8f96, 0xc9c0e8, 0xb34428];
const BOTTOMS = [0x2a3a5a, 0x2a3a5a, 0x1c1c1e, 0x8a7a5a, 0x5a5e66, 0xeeeae0, 0x6a4a32, 0x3d4a2e];
const pick = (list: number[]) => new THREE.Color(list[Math.floor(Math.random() * list.length)]);

/** Texels a row in a figure's pose texture. */
const POSE_WIDTH = 2048;

/**
 * One figure's walk cycle, frozen frame by frame, standing on the ground at `height` metres tall: a single
 * `Instances` for the whole crowd of that figure. Every frame has the same vertices in the same order, only placed
 * differently, so where each vertex is in each frame goes in a texture and each copy's vertex shader reads the
 * frame that copy is in (attribute `iframe`). One mesh per frame instead meant nearly every walker was a mesh of
 * its own, ten or so draws (one per material) in each of the four passes: a thousand draws, the most of any frame.
 */
async function walkCycle(file: string, height: number, count: number, scene: THREE.Scene) {
  const figures = await posedFigures(framePoses(), file);
  // feet on the ground (the lowest point of the walk) and brought to the height asked for; not by the gestures,
  // whose hands over the head would have made everyone shorter
  const box = new THREE.Box3();
  for (const f of figures.slice(0, STAND + 1)) box.expandByObject(f);
  const fit = new THREE.Matrix4().makeScale(...(Array(3).fill(height / (box.max.y - box.min.y)) as V3)).multiply(new THREE.Matrix4().makeTranslation(0, -box.min.y, 0));
  const materials: THREE.Material[] = [];
  for (const f of figures) f.traverse((o) => (o as THREE.Mesh).isMesh && !materials.includes((o as THREE.Mesh).material as THREE.Material) && materials.push((o as THREE.Mesh).material as THREE.Material));
  const shapes = figures.map((figure) => {
    const parts = materials.map((mat) => {
      const list: THREE.BufferGeometry[] = [];
      figure.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.material !== mat) return;
        let g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).applyMatrix4(fit);
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        if (g.index) g = g.toNonIndexed();
        list.push(g);
      });
      return mergeGeometries(list)!;
    });
    return mergeGeometries(parts, true)!;
  });
  const verts = shapes[0].attributes.position.count;
  if (shapes.some((s) => s.attributes.position.count !== verts)) throw new Error('its frames do not have the same vertices');
  const rows = Math.ceil((shapes.length * verts) / POSE_WIDTH);
  const where = new Float32Array(POSE_WIDTH * rows * 4), facing = new Float32Array(POSE_WIDTH * rows * 4);
  shapes.forEach((shape, f) => {
    const p = shape.attributes.position.array, n = shape.attributes.normal.array;
    for (let v = 0; v < verts; v++) {
      const o = (f * verts + v) * 4;
      where.set([p[v * 3], p[v * 3 + 1], p[v * 3 + 2], 1], o);
      facing.set([n[v * 3], n[v * 3 + 1], n[v * 3 + 2], 0], o);
    }
  });
  const texture = (data: Float32Array) => {
    const t = new THREE.DataTexture(data, POSE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    return t;
  };
  const whereTex = texture(where), facingTex = texture(facing);
  const pose = () => {
    const i = attribute('iframe', 'float').toUint().mul(uint(verts)).add(vertexIndex);
    const at = uvec2(i.mod(uint(POSE_WIDTH)), i.div(uint(POSE_WIDTH)));
    positionLocal.assign(textureLoad(whereTex, at).xyz);
    normalLocal.assign(textureLoad(facingTex, at).xyz);
  };
  const mesh = new Instances(shapes[0], materials.map((m) => nodeMaterial(m, pose)), Array(count).fill(new THREE.Matrix4()), true);
  for (const s of shapes.slice(1)) s.dispose();
  mesh.geometry.setAttribute('iframe', new THREE.InstancedBufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage));
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.geometry.instanceCount = 0;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}

/**
 * People walking the pavements near the player: men and women, each figure frozen into a walk cycle. They keep to the pavement either side of the streets, turn back at a road's end,
 * step out of the way of a car coming at them, and are knocked flat (and get up again) by one that does not stop.
 * Now and then one stops a while, or waits at the kerb for a gap in the traffic and crosses (and runs if a car comes).
 * ponytail: they cross anywhere, never at a zebra or with the signals; add that if the map ever carries crossings.
 */
export class Pedestrians {
  private sides: Side[] = [];
  private buckets = new Map<string, number[]>();
  private walkers: Walker[] = [];
  /** per figure, everyone walking in it, each in their own frame of its walk cycle */
  private frames: Instances[] = [];
  /** per figure, the file it came from and how tall it stands */
  private kinds: [string, number][] = [];
  /** asked when the player's car runs someone down at (vx, vz) m/s: true if they are taken to be thrown for real */
  onStruck?: (w: Walker, vx: number, vz: number) => boolean;
  private ready = false;
  private clock = 0;
  /** for sweeping each step for walls; Rapier only reads its origin and direction */
  private ray = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 } } as RAPIER.Ray;
  /** seconds of panic left after the last shot, and where the shooting was: the whole street runs until it is over */
  panic = 0;
  /** whether the player is on foot (main.ts), and with a rifle in hand: then they are someone to talk to, or run from */
  playerOnFoot = false;
  playerArmed = false;
  private panicX = 0;
  private panicZ = 0;
  private started = false;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private xAxis = new THREE.Vector3(1, 0, 0);
  /** where every walker on the pavement or crossing is, for the traffic to stop for */
  readonly positions: { x: number; z: number }[] = [];
  /** the traffic, for judging a gap to cross in */
  vehicles: Mover[] = [];

  private world: RAPIER.World;

  constructor(scene: THREE.Scene, world: RAPIER.World, count: number) {
    this.world = world;
    for (let i = 0; i < count; i++) {
      this.walkers.push({
        on: false, side: { pts: [], width: 0 }, seg: 0, decide: 0, tx: 0, tz: 0, hurry: 0, t: 0, dir: 1, speed: 1.3, lane: 0, x: 0, z: 0, vx: 0, vz: 0, yaw: 0, phase: 0, scale: 1, figure: 0, top: new THREE.Color(1, 1, 1), bottom: new THREE.Color(1, 1, 1),
        state: 'walk', timer: 0, vy: 0, y: 0, nerve: 0.5, quiet: 0, grudge: 0, ox: 0, oz: 0,
      });
    }
    if (!count) return;
    // every figure that loads joins the crowd; one that does not is left out
    void Promise.all(FIGURES.map(([file, height]) => walkCycle(file, height, count, scene).catch((err) => {
      console.warn(`Pedestrian ${file} could not be loaded`, err);
      return null;
    }))).then((cycles) => {
      this.frames = cycles.filter((c): c is Instances => !!c);
      this.kinds = FIGURES.filter((_, i) => cycles[i]);
      this.ready = this.frames.length > 0;
    });
  }

  /** The streets whose pavements are walked. */
  setRoads(roads: Road[]) {
    for (const r of roads) {
      if (r.pts.length < 4 || r.width < 5) continue;
      const pair: Side[] = [];
      for (const sideSign of [1, -1]) {
        const pts: number[] = [];
        const off = (r.width / 2 + 1.3) * sideSign;
        for (let i = 0; i < r.pts.length; i += 2) {
          // pushed out square to the road, averaging the two segments that meet at a bend
          const pi = Math.max(0, i - 2), ni = Math.min(r.pts.length - 2, i + 2);
          const dx = r.pts[ni] - r.pts[pi], dz = r.pts[ni + 1] - r.pts[pi + 1], l = Math.hypot(dx, dz) || 1;
          pts.push(r.pts[i] - (dz / l) * off, r.pts[i + 1] + (dx / l) * off);
        }
        const n = this.sides.push({ pts, width: r.width }) - 1;
        pair.push(this.sides[n]);
        for (let i = 0; i < pts.length; i += 2) {
          const k = `${Math.floor(pts[i] / BUCKET)},${Math.floor(pts[i + 1] / BUCKET)}`;
          const list = this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!;
          if (list[list.length - 1] !== n) list.push(n);
        }
      }
      [pair[0].partner, pair[1].partner] = [pair[1], pair[0]];
    }
  }

  /**
   * Whether the way from `w` to where their crossing ends is clear: nothing on it, and nothing that will be on it
   * within `seconds`. (px, pz, pvx, pvz) is the player's car.
   */
  private clear(w: Walker, seconds: number, player: Mover) {
    const ax = w.x, az = w.z, bx = w.tx - ax, bz = w.tz - az, bl2 = bx * bx + bz * bz || 1;
    const near = (x: number, z: number) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / bl2));
      return Math.hypot(x - ax - bx * t, z - az - bz * t);
    };
    for (const v of [player, ...this.vehicles]) {
      if (Math.hypot(v.x - ax, v.z - az) > 80) continue;
      for (let t = 0; t <= seconds; t += 0.5) if (near(v.x + v.vx * t, v.z + v.vz * t) < 3.5) return false;
    }
    return true;
  }

  /** The player sounded the horn from (px, pz): whoever is in the road in front of them hurries out of it. */
  hornFrom(px: number, pz: number, fx: number, fz: number) {
    for (const w of this.walkers) {
      if (!w.on || (w.state !== 'cross' && w.state !== 'wait')) continue;
      const rx = w.x - px, rz = w.z - pz, along = rx * fx + rz * fz;
      if (along < 0 || along > 30) continue;
      if (w.state === 'cross') w.hurry = 3;
      else w.timer = 0; // at the kerb: a step back, and wait for a proper gap
    }
  }

  /** The player's car at (px, pz) moving (vx, vz) runs `w` down if it is on them: returns how hard, 0 if it is not. */
  private struck(w: Walker, px: number, pz: number, vx: number, vz: number) {
    const speed = Math.hypot(vx, vz);
    if (speed <= 2.5 || Math.hypot(w.x - px, w.z - pz) >= 1.3) return 0;
    if (this.onStruck?.(w, vx, vz)) {
      w.state = 'taken';
      return speed;
    }
    const cfx = vx / speed, cfz = vz / speed, across = (w.x - px) * cfz - (w.z - pz) * cfx;
    Object.assign(w, { state: 'down', timer: 3.5, vx: vx * 0.7 + (across > 0 ? cfz : -cfz) * 1.5, vz: vz * 0.7 + (across > 0 ? -cfx : cfx) * 1.5, vy: Math.min(6, speed * 0.35) });
    return speed;
  }

  private spawn(w: Walker, px: number, pz: number, near: number) {
    const angle = Math.random() * Math.PI * 2, r = near + Math.random() * (DRAWN - near);
    const list = this.buckets.get(`${Math.floor((px + Math.sin(angle) * r) / BUCKET)},${Math.floor((pz + Math.cos(angle) * r) / BUCKET)}`);
    if (!list) return;
    const side = this.sides[list[Math.floor(Math.random() * list.length)]];
    const seg = Math.floor(Math.random() * (side.pts.length / 2 - 1));
    const dir = Math.random() < 0.5 ? 1 : -1;
    const at = this.along(side, seg, 0, dir, Math.random() * this.segLength(side, seg));
    const lane = 0.15 + Math.random() * 0.55;
    const x = at.x + at.fz * lane, z = at.z - at.fx * lane;
    if (Math.hypot(x - px, z - pz) < near) return;
    // not on top of someone already there
    if (this.walkers.some((o) => o.on && Math.hypot(o.x - x, o.z - z) < 1)) return;
    const speed = 1.05 + Math.random() * 0.5;
    Object.assign(w, {
      on: true, side, seg: at.seg, t: at.t, dir, speed, lane, x, z, vx: at.fx * speed, vz: at.fz * speed, yaw: Math.atan2(at.fx, at.fz),
      phase: Math.random(), scale: 0.95 + Math.random() * 0.1, figure: Math.floor(Math.random() * this.frames.length), top: pick(TOPS), bottom: pick(BOTTOMS), state: 'walk', timer: 0, y: 0, vy: 0,
      decide: 3 + Math.random() * 15, hurry: 0, nerve: Math.random(), quiet: 0, grudge: 0, ox: x, oz: z,
    });
  }

  /** Puts `w` back on the pavement nearest to where they stand, walking; nowhere near one, they are gone. */
  private attach(w: Walker) {
    let best: Side | null = null, seg = 0, d = Infinity;
    const bx = Math.floor(w.x / BUCKET), bz = Math.floor(w.z / BUCKET);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const n of this.buckets.get(`${bx + i},${bz + j}`) ?? []) {
        const pts = this.sides[n].pts;
        for (let k = 0; k < pts.length; k += 2) {
          const dk = Math.hypot(pts[k] - w.x, pts[k + 1] - w.z);
          if (dk < d) [best, seg, d] = [this.sides[n], k / 2, dk];
        }
      }
    }
    if (!best) {
      w.on = false;
      return;
    }
    Object.assign(w, { state: 'walk', side: best, seg: Math.min(seg, best.pts.length / 2 - 2), t: 0, dir: Math.random() < 0.5 ? 1 : -1, decide: 8 + Math.random() * 12, hurry: 0, y: 0, vy: 0 });
  }

  isWoman(w: Walker) {
    return this.kinds[w.figure]?.[0].includes('woman') ?? false;
  }

  /** The figure file `w` is drawn from, and how tall they stand. */
  kindOf(w: Walker): [string, number] {
    const [file, height] = this.kinds[w.figure];
    return [file, height * w.scale];
  }

  /** Whoever a fist or a stick `r` metres across lands on at (x, y, z), or null. */
  strikeAt(x: number, y: number, z: number, r: number): Walker | null {
    let best: Walker | null = null, d = RADIUS + r;
    for (const w of this.walkers) {
      if (!w.on || w.state === 'taken' || w.state === 'down' || y < 0 || y > 1.85 * w.scale) continue;
      const dw = Math.hypot(w.x - x, w.z - z);
      if (dw < d) [best, d] = [w, dw];
    }
    return best;
  }

  /** `w` is in a fight or off their feet: left alone here until given back. */
  take(w: Walker) {
    w.state = 'taken';
  }

  /** `w` is handed back at (x, z): to walk off along the nearest pavement, or first to run from trouble at `from`. */
  give(w: Walker, x: number, z: number, yaw: number, from?: { x: number; z: number }) {
    Object.assign(w, { x, z, yaw, vx: 0, vz: 0, y: 0, vy: 0 });
    if (from) Object.assign(w, { state: 'flee', tx: from.x, tz: from.z, timer: 6 + Math.random() * 4 });
    else this.attach(w);
  }

  /** Someone new on foot at (x, z), such as a driver who has got out: joins the crowd if there is room in it. */
  adopt(file: string, x: number, z: number, yaw: number, from?: { x: number; z: number }) {
    const w = this.walkers.find((o) => !o.on), figure = this.kinds.findIndex(([f]) => f === file);
    if (!w || figure < 0) return false;
    Object.assign(w, { on: true, figure, scale: 1, speed: 1.3, lane: 0.3, phase: 0, nerve: 0.9 });
    w.top.setRGB(0, 0, 0);
    w.bottom.setRGB(0, 0, 0);
    this.give(w, x, z, yaw, from);
    return true;
  }

  /** `w` is dead: gone from the street for good, and the slot free for someone new somewhere else. */
  forget(w: Walker) {
    Object.assign(w, { on: false, state: 'walk' });
  }

  /** Knocked flat by a blow, the old way: for when there is no body free to fall for real. */
  knock(w: Walker, vx: number, vz: number) {
    Object.assign(w, { state: 'down', timer: 3.5, vx, vz, vy: 1.5 });
  }

  /**
   * A fight has broken out at (x, z). Everyone within `r` metres takes it as they are made: the timid run, most stop
   * and look, and the boldest are offered to `join` (which says whether it took them). Returns those who ran.
   */
  scare(x: number, z: number, r: number, join: (w: Walker) => boolean) {
    const ran: Walker[] = [];
    for (const w of this.walkers) {
      if (!w.on || w.state === 'taken' || w.state === 'down' || w.state === 'flee') continue;
      const d = Math.hypot(w.x - x, w.z - z);
      if (d > r) continue;
      if (w.nerve > 0.85 && join(w)) continue;
      if (w.nerve < 0.45 || d < 2.5) ran.push(Object.assign(w, { state: 'flee', tx: x, tz: z, timer: 5 + Math.random() * 5 }));
      else if (w.state === 'walk' || w.state === 'idle') {
        // they stop to watch, and egg it on
        Object.assign(w, { state: 'idle', timer: 4 + Math.random() * 5, vx: 0, vz: 0, yaw: Math.atan2(x - w.x, z - w.z) });
        shout(w, this.isWoman(w), 'gawk', 0.35);
      }
    }
    return ran;
  }

  /**
   * Gunfire at (x, z): no gawking, no joining in. Everyone in sight runs, and keeps running in a blind scatter,
   * newcomers too, until a minute after the last shot. Returns those who only now started to run.
   */
  gunfire(x: number, z: number) {
    Object.assign(this, { panic: 60, panicX: x, panicZ: z });
    const ran: Walker[] = [];
    for (const w of this.walkers) {
      if (!w.on || w.state === 'taken' || w.state === 'down') continue;
      if (w.state !== 'flee') ran.push(w);
      Object.assign(w, { state: 'flee', tx: x, tz: z, timer: 2 + Math.random() * 3 });
    }
    return ran;
  }

  /** Someone still running from the shooting within `r` metres of (x, z), picked at random: for a scream heard and seen. */
  panicking(x: number, z: number, r = 30) {
    for (let k = 0; k < 8; k++) {
      const w = this.walkers[Math.floor(Math.random() * this.walkers.length)];
      if (w?.on && w.state === 'flee' && Math.hypot(w.x - x, w.z - z) < r) return w;
    }
    return null;
  }

  private segLength(side: Side, seg: number) {
    const p = side.pts, i = seg * 2;
    return Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  }

  /**
   * The point `ahead` metres further along a side from (seg, t), walking `dir`, and the way the pavement runs
   * there (fx, fz, the way they walk). Turns back at the ends of the road.
   */
  private along(side: Side, seg: number, t: number, dir: 1 | -1, ahead: number) {
    const p = side.pts, last = p.length / 2 - 2;
    let s = seg, u = t + ahead * dir;
    for (let k = 0; k < 20; k++) {
      const len = this.segLength(side, s);
      if (u > len && s < last) [u, s] = [u - len, s + 1];
      else if (u < 0 && s > 0) [s, u] = [s - 1, u + this.segLength(side, s - 1)];
      else break;
    }
    const len = this.segLength(side, s) || 1;
    u = Math.max(0, Math.min(len, u));
    const i = s * 2, dx = (p[i + 2] - p[i]) / len, dz = (p[i + 3] - p[i + 1]) / len;
    return { seg: s, t: u, x: p[i] + dx * u, z: p[i + 1] + dz * u, fx: dx * dir, fz: dz * dir };
  }

  /**
   * Every frame. (px, pz) and (vx, vz) are the player's car and its velocity; (ox, oz) is where the player is,
   * which is somewhere else when they are out of the car. Returns how hard the car hit anyone this frame (m/s),
   * 0 if it hit no one.
   *
   * Each walker is a point with a velocity, pushed by forces (Helbing's social force model): a pull towards
   * the pace and line they want, pushes off the people round them (stronger from those ahead, and to their
   * own left past someone coming the other way, as people keep left here), pushes off whatever solid is
   * nearest (a tree, a post, a wall, a parked car), and a jump out of the way of a car bearing down on them.
   * On top of the forces, nobody may stand inside anybody else, or inside a solid.
   */
  update(dt: number, px: number, pz: number, vx: number, vz: number, ox = px, oz = pz): number {
    if (!this.ready || !this.sides.length) return 0;
    dt = Math.min(dt, 0.05);
    const speed = Math.hypot(vx, vz), cfx = vx / (speed || 1), cfz = vz / (speed || 1);
    let hit = 0;
    this.panic = Math.max(0, this.panic - dt);
    this.clock += dt;
    const live = this.walkers.filter((w) => w.on && w.state !== 'taken');
    for (const w of live) [w.ox, w.oz] = [w.x, w.z];
    for (const w of this.walkers) {
      if (w.state === 'taken' && w.on) continue;
      if (!w.on) {
        // the first crowd appears all round the player; after that, out of sight
        this.spawn(w, ox, oz, this.started ? 35 : 10);
        continue;
      }
      if (Math.hypot(w.x - ox, w.z - oz) > DRAWN + 20) {
        w.on = false;
        continue;
      }
      if (w.state === 'down') {
        // thrown: carried by their own speed, slowing on the ground, then up again
        w.timer -= dt;
        w.x += w.vx * dt;
        w.z += w.vz * dt;
        w.vy -= 9.81 * dt;
        w.y = Math.max(0, w.y + w.vy * dt);
        if (w.y === 0) {
          w.vx *= Math.max(0, 1 - 4 * dt);
          w.vz *= Math.max(0, 1 - 4 * dt);
        }
        if (w.timer <= 0) {
          // up again, and furious with whoever did it
          Object.assign(w, { state: 'idle', timer: 2.5, y: 0, vx: 0, vz: 0, yaw: Math.atan2(ox - w.x, oz - w.z) });
          shout(w, this.isWoman(w), 'angry');
        }
        continue;
      }

      if (this.panic > 0 && w.state !== 'flee' && Math.hypot(w.x - this.panicX, w.z - this.panicZ) < DRAWN + 60) {
        Object.assign(w, { state: 'flee', tx: this.panicX, tz: this.panicZ, timer: 2 + Math.random() * 3 });
      }
      if (w.state === 'flee') {
        const struck = this.struck(w, px, pz, vx, vz);
        if (struck) {
          hit = Math.max(hit, struck);
          continue;
        }
        // straight away from the trouble, as fast as they can go, sliding along whatever is in the way
        const dx = w.x - w.tx, dz = w.z - w.tz, d = Math.hypot(dx, dz) || 1, pace = 4.2;
        w.vx = (dx / d) * pace;
        w.vz = (dz / d) * pace;
        const solid = this.world.projectPoint({ x: w.x, y: 0.9, z: w.z }, false, undefined, QUERY_GROUPS);
        if (solid && !solid.isInside) {
          let nx = w.x - solid.point.x, nz = w.z - solid.point.z;
          const gap = Math.hypot(nx, nz);
          if (gap < 0.6 && gap > 1e-4) {
            nx /= gap;
            nz /= gap;
            const into = w.vx * nx + w.vz * nz;
            if (into < 0) [w.vx, w.vz] = [w.vx - into * nx, w.vz - into * nz];
            if (gap < RADIUS) [w.x, w.z] = [w.x + nx * (RADIUS - gap), w.z + nz * (RADIUS - gap)];
          }
        }
        w.x += w.vx * dt;
        w.z += w.vz * dt;
        const turn = Math.atan2(Math.sin(Math.atan2(w.vx, w.vz) - w.yaw), Math.cos(Math.atan2(w.vx, w.vz) - w.yaw));
        w.yaw += Math.max(-8 * dt, Math.min(8 * dt, turn));
        w.phase = (w.phase + (pace * dt) / (STRIDE * 1.7)) % 1;
        // far enough, or long enough: back to the nearest pavement and on with the day
        if ((w.timer -= dt) > 0 && d < 45) continue;
        if (this.panic <= 0) this.attach(w);
        else {
          // still panicking: off again a few seconds, roughly away from the shooting but never in a straight line
          const away = Math.atan2(w.x - this.panicX, w.z - this.panicZ) + (Math.random() - 0.5) * 2.4;
          Object.assign(w, { tx: w.x - Math.sin(away) * 5, tz: w.z - Math.cos(away) * 5, timer: 2 + Math.random() * 4 });
        }
        continue;
      }

      // nearly run down: once the car is past, they round on it, swearing
      if (w.grudge > 0 && (w.grudge -= dt) <= 0) {
        Object.assign(w, { state: 'idle', timer: 2 + Math.random() * 1.5, vx: 0, vz: 0, yaw: Math.atan2(px - w.x, pz - w.z) });
        shout(w, this.isWoman(w), 'angry', 0.8);
      }
      // the player on foot, close by: walked into, they swear at him; walked past, now and then a remark; and a
      // rifle in his hands, they back off from him
      w.quiet -= dt;
      const near = this.playerOnFoot && w.quiet <= 0 ? Math.hypot(w.x - ox, w.z - oz) : Infinity;
      if (near < 2.5) {
        w.quiet = 15 + Math.random() * 20;
        const toPlayer = Math.atan2(ox - w.x, oz - w.z);
        if (this.playerArmed) {
          Object.assign(w, { state: 'flee', tx: ox, tz: oz, timer: 2.5 + Math.random() * 2 });
          shout(w, this.isWoman(w), 'armed', 0.7);
          continue;
        }
        if (near < 0.75) {
          Object.assign(w, { state: 'idle', timer: 1.5 + Math.random(), vx: 0, vz: 0, yaw: toPlayer });
          shout(w, this.isWoman(w), 'bump');
        } else if (Math.random() < 0.35) {
          if (w.state === 'idle') w.yaw = toPlayer;
          shout(w, this.isWoman(w), 'passby');
        }
      }
      // Now and then they make up their minds: stop a while, or cross over to the other side.
      w.hurry -= dt;
      if (w.state === 'walk' && (w.decide -= dt) <= 0) {
        w.decide = 6 + Math.random() * 16;
        const r = Math.random();
        if (r < 0.2) Object.assign(w, { state: 'idle', timer: 2 + Math.random() * 7, vx: 0, vz: 0 });
        else if (r < 0.45 && w.side.partner && w.side.width < 24) {
          // square across the road from where they stand
          const there = this.along(w.side.partner, w.seg, 0, 1, w.t);
          Object.assign(w, { state: 'wait', timer: 0, tx: there.x, tz: there.z, vx: 0, vz: 0 });
        }
      }
      if (w.state === 'idle' || w.state === 'wait' || w.state === 'cross') {
        const struck = this.struck(w, px, pz, vx, vz);
        if (struck) {
          hit = Math.max(hit, struck);
          continue;
        }
        let face = w.yaw;
        if (w.state === 'idle') {
          if ((w.timer -= dt) <= 0) w.state = 'walk';
        } else if (w.state === 'wait') {
          // a gap: nothing coming for a good few seconds; after a long wait, any gap will do
          w.timer += dt;
          face = Math.atan2(w.tx - w.x, w.tz - w.z);
          if (this.clear(w, w.timer > 7 ? 1.5 : 4, { x: px, z: pz, vx, vz })) w.state = 'cross';
          else if (w.timer > 18) w.state = 'walk'; // gave up
        } else {
          const dx = w.tx - w.x, dz = w.tz - w.z, d = Math.hypot(dx, dz);
          if (d < 0.4) {
            // over: on along the far pavement, whichever way
            Object.assign(w, { state: 'walk', side: w.side.partner!, dir: Math.random() < 0.5 ? 1 : -1, decide: 8 + Math.random() * 16 });
          } else {
            // a brisk walk across, a run if something is coming
            if (!this.clear(w, 2, { x: px, z: pz, vx, vz })) w.hurry = Math.max(w.hurry, 0.5);
            const pace = w.speed * (w.hurry > 0 ? 2.2 : 1.15);
            w.vx = (dx / d) * pace;
            w.vz = (dz / d) * pace;
            w.x += w.vx * dt;
            w.z += w.vz * dt;
            face = Math.atan2(dx, dz);
            w.phase = (w.phase + (pace * dt) / STRIDE) % 1;
          }
        }
        if (w.state !== 'cross') {
          w.vx = w.vz = 0;
          w.phase = Math.round(w.phase * 2) / 2 % 1; // standing: feet together
        }
        const dy = Math.atan2(Math.sin(face - w.yaw), Math.cos(face - w.yaw));
        w.yaw += Math.max(-5 * dt, Math.min(5 * dt, dy));
        continue;
      }

      // where they are along the pavement, from where they actually stand
      const here = this.along(w.side, w.seg, w.t, 1, 0);
      const dirX = here.fx, dirZ = here.fz;
      w.t = Math.max(0, Math.min(this.segLength(w.side, w.seg), (w.x - w.side.pts[w.seg * 2]) * dirX + (w.z - w.side.pts[w.seg * 2 + 1]) * dirZ));
      const fwd = this.along(w.side, w.seg, w.t, w.dir, 0.01);
      Object.assign(w, { seg: fwd.seg, t: fwd.t });
      const end = this.along(w.side, w.seg, w.t, w.dir, 0.6);
      if (Math.hypot(end.x - fwd.x, end.z - fwd.z) < 0.3) w.dir = -w.dir as 1 | -1; // the road ends here: turn round
      const aim = this.along(w.side, w.seg, w.t, w.dir, LOOK);
      // their own line: a little to their left of the pavement's middle
      const tx = aim.x + aim.fz * w.lane, tz = aim.z - aim.fx * w.lane;
      let ex = tx - w.x, ez = tz - w.z;
      const el = Math.hypot(ex, ez) || 1;
      ex /= el;
      ez /= el;
      let fx = (ex * w.speed - w.vx) / RELAX, fz = (ez * w.speed - w.vz) / RELAX;
      let limit = w.speed * 1.4;

      // the people round them
      for (const o of live) {
        if (o === w || o.state === 'down') continue;
        let nx = w.x - o.x, nz = w.z - o.z;
        const d = Math.hypot(nx, nz);
        if (d > 3 || d < 1e-4) continue;
        nx /= d;
        nz /= d;
        // what is ahead matters far more than what is behind
        const facing = (1 - (nx * ex + nz * ez)) / 2;
        const f = PUSH * Math.exp((2 * RADIUS - d) / RANGE) * (0.3 + 0.7 * facing);
        fx += nx * f;
        fz += nz * f;
        // someone coming the other way, in front: both step to their own left
        const ol = Math.hypot(o.vx, o.vz) || 1;
        if (d < 4 && facing > 0.6 && (o.vx * ex + o.vz * ez) / ol < -0.5) {
          fx += ez * 0.9;
          fz += -ex * 0.9;
        }
      }

      // the nearest solid: a trunk, a post, a bin, a wall, a car
      const hitSolid = this.world.projectPoint({ x: w.x, y: 0.9, z: w.z }, false, undefined, QUERY_GROUPS);
      if (hitSolid) {
        let nx = w.x - hitSolid.point.x, nz = w.z - hitSolid.point.z;
        let d = Math.hypot(nx, nz);
        if (hitSolid.isInside) [nx, nz, d] = [-nx, -nz, -d];
        if (Math.abs(d) < 1.5 && Math.abs(d) > 1e-4) {
          nx /= Math.abs(d);
          nz /= Math.abs(d);
          const f = WALL_PUSH * Math.exp((RADIUS - d) / WALL_RANGE);
          fx += nx * Math.min(f, 20);
          fz += nz * Math.min(f, 20);
          // and never inside it
          if (d < RADIUS) {
            w.x += nx * (RADIUS - d);
            w.z += nz * (RADIUS - d);
          }
        }
      }

      // a car bearing down on them: a quick jump out of its line, or too late
      const rx = w.x - px, rz = w.z - pz, dCar = Math.hypot(rx, rz);
      const ahead = rx * cfx + rz * cfz, across = rx * cfz - rz * cfx;
      const struck = dCar < 1.3 ? this.struck(w, px, pz, vx, vz) : 0;
      if (struck) {
        hit = Math.max(hit, struck);
        continue;
      }
      if (speed > 3 && ahead > 0 && ahead < speed * 1.5 + 4 && Math.abs(across) < 2.4) {
        if (w.grudge <= 0) w.grudge = 0.9;
        const away = across >= 0 ? 1 : -1;
        fx += cfz * away * 14;
        fz += -cfx * away * 14;
        limit = 4;
      }

      // move: forces, capped at a brisk walk (a run when a car is coming)
      const fl = Math.hypot(fx, fz);
      if (fl > 12) [fx, fz] = [(fx * 12) / fl, (fz * 12) / fl];
      w.vx += fx * dt;
      w.vz += fz * dt;
      const v = Math.hypot(w.vx, w.vz);
      if (v > limit) [w.vx, w.vz] = [(w.vx * limit) / v, (w.vz * limit) / v];
      w.x += w.vx * dt;
      w.z += w.vz * dt;
      // face the way they are going, turning at a person's pace; legs keep time with the ground covered
      if (v > 0.15) {
        let dy = Math.atan2(w.vx, w.vz) - w.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        w.yaw += Math.max(-5 * dt, Math.min(5 * dt, dy));
        w.phase = (w.phase + (v * dt) / STRIDE) % 1;
      } else w.phase = Math.round(w.phase * 2) / 2 % 1; // standing: feet together
    }

    // nobody stands inside anybody else: pairs that overlap are pushed apart, half each
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < live.length; a++) {
        const p = live[a];
        if (p.state === 'down') continue;
        for (let b = a + 1; b < live.length; b++) {
          const q = live[b];
          if (q.state === 'down') continue;
          const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
          if (d >= 2 * RADIUS || d < 1e-5) continue;
          const push = (2 * RADIUS - d) / 2 / d;
          p.x -= dx * push;
          p.z -= dz * push;
          q.x += dx * push;
          q.z += dz * push;
        }
      }
    }

    // Nothing takes anyone through a wall: whatever moved them this frame (their own feet, a car, the crowd's
    // shoving), the way from where they stood to where they are now is swept, stopping a body's width short of
    // anything solid and sliding along it. The walls are thin shells, not solids: once through one, someone was
    // inside a building for good, and the push off the nearest wall then held them in.
    for (const w of live) this.sweep(w);

    this.positions.length = 0;
    for (const w of live) if (w.on && (w.state === 'walk' || w.state === 'cross' || w.state === 'flee')) this.positions.push({ x: w.x, z: w.z });
    this.started = true;
    this.draw(ox, oz);
    return hit;
  }

  private sweep(w: Walker) {
    const dx = w.x - w.ox, dz = w.z - w.oz, len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    const ux = dx / len, uz = dz / len;
    const hit = this.cast(w.ox, w.oz, ux, uz, len + RADIUS);
    if (!hit) return;
    let nx = hit.normal.x, nz = hit.normal.z;
    const nl = Math.hypot(nx, nz) || 1;
    [nx, nz] = [nx / nl, nz / nl];
    const go = Math.max(0, hit.timeOfImpact - RADIUS), into = ux * nx + uz * nz;
    w.x = w.ox + ux * go;
    w.z = w.oz + uz * go;
    // what is left of the step goes along the wall, if that way is clear too
    const rest = len - go, sx = (ux - into * nx) * rest, sz = (uz - into * nz) * rest, sl = Math.hypot(sx, sz);
    if (sl > 1e-4 && !this.cast(w.x, w.z, sx / sl, sz / sl, sl + RADIUS)) [w.x, w.z] = [w.x + sx, w.z + sz];
    // and no speed left going into it
    const vin = w.vx * nx + w.vz * nz;
    if (vin < 0) [w.vx, w.vz] = [w.vx - vin * nx, w.vz - vin * nz];
  }

  private cast(x: number, z: number, dx: number, dz: number, reach: number) {
    this.ray.origin = { x, y: 0.9, z };
    this.ray.dir = { x: dx, y: 0, z: dz };
    return this.world.castRayAndGetNormal(this.ray, reach, true, undefined, QUERY_GROUPS);
  }

  private draw(px: number, pz: number) {
    const counts = this.frames.map(() => 0);
    for (const w of this.walkers) {
      if (!w.on || w.state === 'taken' || Math.hypot(w.x - px, w.z - pz) > DRAWN) continue;
      const f = w.state === 'down' ? 0
        : w.state === 'idle' || w.state === 'wait' ? STAND
        : w.state === 'flee' ? RUN + (Math.floor(w.phase * RUN_FRAMES) % RUN_FRAMES)
        : Math.floor(w.phase * FRAMES) % FRAMES;
      const mesh = this.frames[w.figure], i = counts[w.figure]++;
      mesh.geometry.attributes.iframe.setX(i, f);
      this.q.setFromAxisAngle(this.up, w.yaw);
      // knocked down: laid on their back along the way they were thrown
      if (w.state === 'down') this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.xAxis, -Math.PI / 2 * Math.min(1, (3.5 - w.timer) * 3)));
      mesh.setMatrixAt(i, this.m.compose(this.p.set(w.x, 0.035 + w.y + (w.state === 'down' ? 0.15 : 0), w.z), this.q, this.s.setScalar(w.scale)));
      mesh.setColorAt(i, w.top);
      mesh.setExtraAt(i, w.bottom.r, w.bottom.g, w.bottom.b);
    }
    // only as many copies as there are walkers in that figure are drawn, and a figure nobody is in is not drawn at all
    this.frames.forEach((mesh, k) => {
      mesh.geometry.instanceCount = counts[k];
      mesh.visible = counts[k] > 0;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.iframe.needsUpdate = true;
    });
  }
}
