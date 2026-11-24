import * as THREE from 'three/webgpu';
import { attribute, instancedDynamicBufferAttribute, length, smoothstep, uniform, uv } from 'three/tsl';
import { onNight } from './sky.ts';
import { ROAD_HEIGHT } from '../world/ground.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';

/** Stretches of rubber kept on the road; the oldest are laid over once these run out. */
const MARKS = 2048;
/** metres between the ends of one stretch */
const MARK_STEP = 0.22;
/** seconds a mark lasts, and how long it takes to fade at the end of that */
const MARK_LIFE = 40, MARK_FADE = 8;
/** how hard a tyre has to be sliding (0 to 1) to leave rubber, and to smoke */
const MARK_FROM = 0.25, SMOKE_FROM = 0.35;
/** puffs a second from one tyre sliding as hard as it can */
const SMOKE_RATE = 30;

/** One tyre's mark: where it last reached, the two ends of its edge there, how black it was, and whether it is still being laid. */
interface Trail {
  on: boolean;
  x: number;
  y: number;
  z: number;
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  ink: number;
}

/**
 * What sliding tyres leave behind: black marks on the road and smoke in the air.
 * Each is one mesh and one draw call, in the scene from the start so its shader is built behind the loading screen.
 */
export class TyreFx {
  private time = uniform(0);
  private marks: THREE.BufferAttribute;
  private inks: THREE.BufferAttribute;
  private nextMark = 0;
  private trails: Trail[] = [0, 1, 2, 3].map(() => ({ on: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, ink: 0 }));

  private count: number;
  private centres: THREE.InstancedBufferAttribute;
  private looks: THREE.InstancedBufferAttribute;
  private puffs: { age: number; life: number; vx: number; vy: number; vz: number; size: number }[];
  private nextPuff = 0;
  private owed = [0, 0, 0, 0];
  private alive = 0;

  constructor(scene: THREE.Scene, puffs = 160) {
    // marks: a ring of flat four-cornered stretches, each with how black it is and when it was laid
    const g = new THREE.BufferGeometry();
    this.marks = new THREE.BufferAttribute(new Float32Array(MARKS * 12), 3).setUsage(THREE.DynamicDrawUsage);
    this.inks = new THREE.BufferAttribute(new Float32Array(MARKS * 8), 2).setUsage(THREE.DynamicDrawUsage);
    const index = new Uint16Array(MARKS * 6);
    for (let i = 0; i < MARKS; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    g.setAttribute('position', this.marks);
    g.setAttribute('ink', this.inks);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const rubber = new THREE.MeshBasicNodeMaterial({ color: 0x0b0b0c, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    rubber.polygonOffset = true;
    rubber.polygonOffsetFactor = -6;
    rubber.polygonOffsetUnits = -24;
    const ink = attribute('ink', 'vec2');
    rubber.opacityNode = ink.x.mul(smoothstep(MARK_LIFE - MARK_FADE, MARK_LIFE, this.time.sub(ink.y)).oneMinus());
    const road = new THREE.Mesh(g, rubber);
    road.frustumCulled = false;
    road.renderOrder = 1;

    // smoke: one soft round sprite drawn `count` times, each copy with its own place, size and thickness
    this.count = puffs;
    this.centres = new THREE.InstancedBufferAttribute(new Float32Array(puffs * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.looks = new THREE.InstancedBufferAttribute(new Float32Array(puffs * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.puffs = Array.from({ length: puffs }, () => ({ age: 1, life: 0, vx: 0, vy: 0, vz: 0, size: 0 }));
    const grey = uniform(new THREE.Color(0.82, 0.82, 0.84));
    // by night it is lit by little: left white it would glow
    onNight((night) => grey.value.setScalar(0.82 - 0.62 * night));
    const smoke = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const look = instancedDynamicBufferAttribute<'vec2'>(this.looks, 'vec2');
    smoke.positionNode = instancedDynamicBufferAttribute<'vec3'>(this.centres, 'vec3');
    smoke.scaleNode = look.x;
    smoke.colorNode = grey;
    smoke.opacityNode = look.y.mul(smoothstep(0.12, 0.5, length(uv().sub(0.5))).oneMinus());
    const cloud = new THREE.Sprite(smoke);
    cloud.count = puffs;
    cloud.frustumCulled = false;
    cloud.renderOrder = 4;
    scene.add(road, cloud);
  }

  /** Stops every mark where it is: for when the car is picked up and put down somewhere else. */
  reset() {
    for (const t of this.trails) t.on = false;
  }

  /** Once a frame. `bike`: its two wheels are each a pair of the physics' four, and leave one narrow mark between them. */
  update(dt: number, vehicle: Vehicle, bike = false) {
    this.time.value += dt;
    if (dt > 0) {
      const lv = vehicle.body.linvel();
      const width = bike ? 0.07 : vehicle.spec.wheelRadius * 0.36;
      for (let n = 0; n < 4; n++) {
        const trail = this.trails[n];
        let p = vehicle.wheelContact[n], slide = vehicle.wheelSlide[n];
        if (bike) {
          const q = vehicle.wheelContact[n ^ 1];
          if (n & 1 || !p || !q) p = null;
          else [p, slide] = [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 }, Math.max(slide, vehicle.wheelSlide[n ^ 1])];
        }
        if (!p || slide < MARK_FROM) {
          trail.on = false;
          this.owed[n] = 0;
          continue;
        }
        this.lay(trail, p.x, p.y + ROAD_HEIGHT + 0.012, p.z, width, Math.min(0.85, slide * 1.1));
        if (slide < SMOKE_FROM) continue;
        // a tyre spinning on the spot throws its smoke back; one sliding along leaves it standing where it was made
        this.owed[n] += (slide - SMOKE_FROM) / (1 - SMOKE_FROM) * SMOKE_RATE * dt;
        for (; this.owed[n] >= 1; this.owed[n]--) this.puff(p.x, p.y + ROAD_HEIGHT + 0.15, p.z, lv.x * 0.25, lv.z * 0.25);
      }
    }
    if (this.alive) this.drift(dt);
  }

  private lay(t: Trail, x: number, y: number, z: number, half: number, ink: number) {
    const dx = x - t.x, dz = z - t.z, d = Math.hypot(dx, dz);
    // across the way the tyre is going
    const ax = (-dz / (d || 1)) * half, az = (dx / (d || 1)) * half;
    if (!t.on || d > 3) {
      // a fresh mark starts where the tyre is now; its first edge is squared up once the tyre has moved on
      Object.assign(t, { on: true, x, y, z, lx: x, lz: z, rx: x, rz: z, ink });
      return;
    }
    if (d < MARK_STEP) return;
    if (t.lx === t.rx && t.lz === t.rz) [t.lx, t.lz, t.rx, t.rz] = [t.x + ax, t.z + az, t.x - ax, t.z - az];
    const i = this.nextMark;
    this.nextMark = (i + 1) % MARKS;
    const lx = x + ax, lz = z + az, rx = x - ax, rz = z - az;
    (this.marks.array as Float32Array).set([t.lx, t.y, t.lz, t.rx, t.y, t.rz, lx, y, lz, rx, y, rz], i * 12);
    const now = this.time.value;
    (this.inks.array as Float32Array).set([t.ink, now, t.ink, now, ink, now, ink, now], i * 8);
    this.marks.needsUpdate = this.inks.needsUpdate = true;
    Object.assign(t, { x, y, z, lx, lz, rx, rz, ink });
  }

  private puff(x: number, y: number, z: number, vx: number, vz: number) {
    const i = this.nextPuff;
    this.nextPuff = (i + 1) % this.count;
    const r = () => Math.random() - 0.5;
    this.centres.setXYZ(i, x + r() * 0.3, y, z + r() * 0.3);
    Object.assign(this.puffs[i], { age: 0, life: 1.1 + Math.random() * 0.9, vx: vx + r() * 1.2, vy: 0.5 + Math.random() * 0.7, vz: vz + r() * 1.2, size: 0.7 + Math.random() * 0.5 });
    this.alive = Math.max(this.alive, 1);
  }

  /** Every puff rises, slows, spreads and thins. */
  private drift(dt: number) {
    const at = this.centres.array as Float32Array, look = this.looks.array as Float32Array;
    const slow = Math.exp(-1.6 * dt);
    let alive = 0;
    this.puffs.forEach((p, i) => {
      if (p.age >= p.life) return;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        look[i * 2] = look[i * 2 + 1] = 0;
        return;
      }
      alive++;
      p.vx *= slow;
      p.vz *= slow;
      at[i * 3] += p.vx * dt;
      at[i * 3 + 1] += p.vy * dt;
      at[i * 3 + 2] += p.vz * dt;
      look[i * 2] = p.size * (1 + 3.2 * k);
      // in fast, out slowly
      look[i * 2 + 1] = 0.3 * Math.min(1, k * 8) * (1 - k) ** 1.5;
    });
    this.alive = alive;
    this.centres.needsUpdate = this.looks.needsUpdate = true;
  }
}
