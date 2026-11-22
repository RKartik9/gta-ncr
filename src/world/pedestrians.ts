import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Road } from './tile.ts';
import { Instances, instanced } from '../render/instances.ts';
import { type Pose, type V3, posedFigures } from '../vehicle/rider.ts';

/** A walk cycle in this many frozen frames; each walker is drawn in whichever frame its stride has reached. */
const FRAMES = 8;
/** metres walked in one full cycle (two steps) */
const STRIDE = 1.5;
/** walkers further than this from the player are not drawn (they are small, and each one is a whole figure) */
const DRAWN = 90;
const BUCKET = 100;
/** the people, under public/models (credits in people/license.txt), and how tall each stands */
const FIGURES: [string, number][] = [
  ['rider/model.glb', 1.75], ['people/man_arab.glb', 1.76], ['people/man_guy.glb', 1.72],
  ['people/woman_casual.glb', 1.63], ['people/woman_girl.glb', 1.6], ['people/woman_office.glb', 1.66],
];

interface Side {
  /** flat [x, z, ...]: a road's centre line pushed out onto its pavement on one side */
  pts: number[];
}

interface Walker {
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
  /** knocked down by a car: thrown, then flat on the ground until `timer` runs out */
  state: 'walk' | 'down';
  timer: number;
  vy: number;
  y: number;
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

/** Walk cycle frame k: legs and arms swinging in opposite pairs, the knee folding as the foot comes through. */
function walkPose(k: number): Pose {
  const a = (k / FRAMES) * Math.PI * 2;
  const leg = (phase: number): [V3, V3] => {
    const swing = Math.sin(phase) * 0.42;
    const bend = Math.max(0, Math.sin(phase + 1.3)) * 0.75 + 0.05;
    return [[0.04, -Math.cos(swing), Math.sin(swing)], [0, -Math.cos(swing - bend), Math.sin(swing - bend)]];
  };
  const arm = (phase: number): [V3, V3] => {
    const swing = -Math.sin(phase) * 0.35;
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

/** A figure's material, remade as a node material that draws `Instances`. */
function nodeMaterial(m: THREE.Material) {
  const src = m as THREE.MeshStandardMaterial;
  return instanced(new THREE.MeshStandardNodeMaterial({
    color: src.color, map: src.map, normalMap: src.normalMap, roughness: src.roughness, metalness: src.metalness,
    roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap, side: src.side, alphaTest: src.transparent || src.alphaTest ? 0.5 : 0,
  }));
}

/** One figure's walk cycle, frozen frame by frame: an `Instances` per frame, standing on the ground at `height` metres tall. */
async function walkCycle(file: string, height: number, count: number, scene: THREE.Scene) {
  const figures = await posedFigures(Array.from({ length: FRAMES }, (_, k) => walkPose(k)), file);
  // feet on the ground (the lowest point of any frame) and brought to the height asked for
  const box = new THREE.Box3();
  for (const f of figures) box.expandByObject(f);
  const fit = new THREE.Matrix4().makeScale(...(Array(3).fill(height / (box.max.y - box.min.y)) as V3)).multiply(new THREE.Matrix4().makeTranslation(0, -box.min.y, 0));
  const materials: THREE.Material[] = [];
  for (const f of figures) f.traverse((o) => (o as THREE.Mesh).isMesh && !materials.includes((o as THREE.Mesh).material as THREE.Material) && materials.push((o as THREE.Mesh).material as THREE.Material));
  const nodes = materials.map(nodeMaterial);
  return figures.map((figure) => {
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
    const mesh = new Instances(mergeGeometries(parts, true)!, nodes, Array(count).fill(new THREE.Matrix4()), true);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.geometry.instanceCount = 0;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  });
}

/**
 * People walking the pavements near the player: men and women, each figure frozen into a walk cycle. They keep to the pavement either side of the streets, turn back at a road's end,
 * step out of the way of a car coming at them, and are knocked flat (and get up again) by one that does not stop.
 * ponytail: no crossing roads and no avoiding each other or street furniture; they walk through lamp posts.
 */
export class Pedestrians {
  private sides: Side[] = [];
  private buckets = new Map<string, number[]>();
  private walkers: Walker[] = [];
  /** per figure, its walk cycle's frames */
  private frames: Instances[][] = [];
  private ready = false;
  private started = false;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private xAxis = new THREE.Vector3(1, 0, 0);
  /** where every walker on the pavement is, for the traffic to stop for */
  readonly positions: { x: number; z: number }[] = [];

  private world: RAPIER.World;

  constructor(scene: THREE.Scene, world: RAPIER.World, count: number) {
    this.world = world;
    for (let i = 0; i < count; i++) {
      this.walkers.push({
        on: false, side: { pts: [] }, seg: 0, t: 0, dir: 1, speed: 1.3, lane: 0, x: 0, z: 0, vx: 0, vz: 0, yaw: 0, phase: 0, scale: 1, figure: 0,
        state: 'walk', timer: 0, vy: 0, y: 0,
      });
    }
    if (!count) return;
    // every figure that loads joins the crowd; one that does not is left out
    void Promise.all(FIGURES.map(([file, height]) => walkCycle(file, height, count, scene).catch((err) => {
      console.warn(`Pedestrian ${file} could not be loaded`, err);
      return null;
    }))).then((cycles) => {
      this.frames = cycles.filter((c): c is Instances[] => !!c);
      this.ready = this.frames.length > 0;
    });
  }

  /** The streets whose pavements are walked. */
  setRoads(roads: Road[]) {
    for (const r of roads) {
      if (r.pts.length < 4 || r.width < 5) continue;
      for (const sideSign of [1, -1]) {
        const pts: number[] = [];
        const off = (r.width / 2 + 1.3) * sideSign;
        for (let i = 0; i < r.pts.length; i += 2) {
          // pushed out square to the road, averaging the two segments that meet at a bend
          const pi = Math.max(0, i - 2), ni = Math.min(r.pts.length - 2, i + 2);
          const dx = r.pts[ni] - r.pts[pi], dz = r.pts[ni + 1] - r.pts[pi + 1], l = Math.hypot(dx, dz) || 1;
          pts.push(r.pts[i] - (dz / l) * off, r.pts[i + 1] + (dx / l) * off);
        }
        const n = this.sides.push({ pts }) - 1;
        for (let i = 0; i < pts.length; i += 2) {
          const k = `${Math.floor(pts[i] / BUCKET)},${Math.floor(pts[i + 1] / BUCKET)}`;
          const list = this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!;
          if (list[list.length - 1] !== n) list.push(n);
        }
      }
    }
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
      phase: Math.random(), scale: 0.95 + Math.random() * 0.1, figure: Math.floor(Math.random() * this.frames.length), state: 'walk', timer: 0, y: 0, vy: 0,
    });
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
   * Every frame. (px, pz) and (vx, vz) are the player's car and its velocity. Returns how hard the car hit
   * anyone this frame (m/s), 0 if it hit no one.
   *
   * Each walker is a point with a velocity, pushed by forces (Helbing's social force model): a pull towards
   * the pace and line they want, pushes off the people round them (stronger from those ahead, and to their
   * own left past someone coming the other way, as people keep left here), pushes off whatever solid is
   * nearest (a tree, a post, a wall, a parked car), and a jump out of the way of a car bearing down on them.
   * On top of the forces, nobody may stand inside anybody else, or inside a solid.
   */
  update(dt: number, px: number, pz: number, vx: number, vz: number): number {
    if (!this.ready || !this.sides.length) return 0;
    dt = Math.min(dt, 0.05);
    const speed = Math.hypot(vx, vz), cfx = vx / (speed || 1), cfz = vz / (speed || 1);
    let hit = 0;
    const live = this.walkers.filter((w) => w.on);
    for (const w of this.walkers) {
      if (!w.on) {
        // the first crowd appears all round the player; after that, out of sight
        this.spawn(w, px, pz, this.started ? 35 : 10);
        continue;
      }
      if (Math.hypot(w.x - px, w.z - pz) > DRAWN + 20) {
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
        if (w.timer <= 0) Object.assign(w, { state: 'walk', y: 0, vx: 0, vz: 0 });
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
      if (speed > 2.5 && dCar < 1.3) {
        hit = Math.max(hit, speed);
        Object.assign(w, { state: 'down', timer: 3.5, vx: vx * 0.7 + (across > 0 ? cfz : -cfz) * 1.5, vz: vz * 0.7 + (across > 0 ? -cfx : cfx) * 1.5, vy: Math.min(6, speed * 0.35) });
        continue;
      }
      if (speed > 3 && ahead > 0 && ahead < speed * 1.5 + 4 && Math.abs(across) < 2.4) {
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

    this.positions.length = 0;
    for (const w of live) if (w.on && w.state === 'walk') this.positions.push({ x: w.x, z: w.z });
    this.started = true;
    this.draw(px, pz);
    return hit;
  }

  private draw(px: number, pz: number) {
    const counts = this.frames.map((frames) => frames.map(() => 0));
    for (const w of this.walkers) {
      if (!w.on || Math.hypot(w.x - px, w.z - pz) > DRAWN) continue;
      const f = w.state === 'down' ? 0 : Math.floor(w.phase * FRAMES) % FRAMES;
      const mesh = this.frames[w.figure][f], i = counts[w.figure][f]++;
      this.q.setFromAxisAngle(this.up, w.yaw);
      // knocked down: laid on their back along the way they were thrown
      if (w.state === 'down') this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.xAxis, -Math.PI / 2 * Math.min(1, (3.5 - w.timer) * 3)));
      mesh.setMatrixAt(i, this.m.compose(this.p.set(w.x, 0.035 + w.y + (w.state === 'down' ? 0.15 : 0), w.z), this.q, this.s.setScalar(w.scale)));
    }
    // only the walkers in each frame are drawn, and a frame nobody is in is not drawn at all
    this.frames.forEach((frames, k) => frames.forEach((mesh, f) => {
      mesh.geometry.instanceCount = counts[k][f];
      mesh.visible = counts[k][f] > 0;
      mesh.instanceMatrix.needsUpdate = true;
    }));
  }
}
