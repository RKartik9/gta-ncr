import * as THREE from 'three/webgpu';
import { Instances, instanced } from '../render/instances.ts';

/** drops in the air at once, and stains on the ground, at most: past that the oldest go first */
const DROPS = 360, SPLATS = 240;
/** metres above the ground the stains are drawn: just over the road, which is itself drawn over the ground */
const ON_ROAD = 0.056;
/** seconds a stain lasts before it fades */
const DRIES = 120;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

interface Drop {
  life: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  size: number;
  ground: number;
}
interface Splat {
  on: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** its size now, the size it spreads to, and how long it has lain */
  r: number;
  to: number;
  stretch: number;
  age: number;
}

/** An irregular blot, flat on the ground: one shape for every stain, each turned and stretched its own way. */
function blot() {
  const n = 14, pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, r = 0.75 + Math.random() * 0.4 + (i % 3 === 0 ? 0.25 : 0);
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return new THREE.ShapeGeometry(new THREE.Shape(pts)).rotateX(-Math.PI / 2);
}

/**
 * Blood: drops thrown off a blow the way it went, falling under gravity, and stains where they land; a pool
 * that spreads under anyone lying knocked out; and drips from the badly hurt. Two meshes for all of it.
 */
export class Blood {
  private drops: Drop[] = [];
  private splats: Splat[] = [];
  private nextDrop = 0;
  private nextSplat = 0;
  private dropMesh: Instances;
  private splatMesh: Instances;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const wet = instanced(new THREE.MeshStandardNodeMaterial({ color: 0x7a0a05, roughness: 0.3 }));
    const stain = instanced(new THREE.MeshStandardNodeMaterial({ color: 0x4a0805, roughness: 0.45, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.dropMesh = new Instances(new THREE.IcosahedronGeometry(1, 0), wet, Array(DROPS).fill(HIDDEN), true);
    this.splatMesh = new Instances(blot(), stain, Array(SPLATS).fill(HIDDEN), true);
    this.splatMesh.receiveShadow = true;
    for (const mesh of [this.dropMesh, this.splatMesh]) {
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    for (let i = 0; i < DROPS; i++) this.drops.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, ground: 0 });
    for (let i = 0; i < SPLATS; i++) this.splats.push({ on: false, x: 0, y: 0, z: 0, yaw: 0, r: 0, to: 0, stretch: 1, age: 0 });
  }

  /** A blow landing at `at`, going along `dir`: `amount` is how bad it was (the damage done). */
  spray(at: THREE.Vector3, dir: THREE.Vector3, amount: number, ground: number) {
    const n = Math.min(24, Math.round(amount * 0.55));
    for (let k = 0; k < n; k++) {
      const d = this.drops[this.nextDrop++ % DROPS];
      d.p.copy(at);
      // mostly on along the blow, some back towards whoever threw it, all of it fanned out
      const speed = 1 + Math.random() * 3.5;
      d.v.copy(dir).multiplyScalar(Math.random() < 0.8 ? speed : -speed * 0.4);
      d.v.x += (Math.random() - 0.5) * 2.6;
      d.v.y += Math.random() * 2.2 - 0.3;
      d.v.z += (Math.random() - 0.5) * 2.6;
      d.size = 0.006 + Math.random() ** 2 * 0.016;
      d.ground = ground;
      d.life = 3;
    }
  }

  /** One drop falling from `at`. */
  drip(at: THREE.Vector3, ground: number) {
    const d = this.drops[this.nextDrop++ % DROPS];
    d.p.copy(at);
    d.v.set((Math.random() - 0.5) * 0.3, -0.2, (Math.random() - 0.5) * 0.3);
    d.size = 0.008 + Math.random() * 0.006;
    d.ground = ground;
    d.life = 3;
  }

  /** A pool spreading out from under someone lying at (x, z), to `size` metres across. */
  pool(x: number, z: number, ground: number, size: number) {
    this.splat(x, ground, z, 0.05, size, 1 + Math.random() * 0.3, Math.random() * 6);
  }

  /** Washed away: every stain within `r` metres of (x, z) fades out over the next few seconds. */
  clean(x: number, z: number, r: number) {
    for (const s of this.splats) if (s.on && Math.hypot(s.x - x, s.z - z) < r) s.age = Math.max(s.age, DRIES + 6);
  }

  private splat(x: number, ground: number, z: number, r: number, to: number, stretch: number, yaw: number) {
    const s = this.splats[this.nextSplat++ % SPLATS];
    // each a hair above the last, so overlapping stains do not flicker through one another
    Object.assign(s, { on: true, x, y: ground + ON_ROAD + (this.nextSplat % 40) * 0.0002, z, r, to, stretch, yaw, age: 0 });
  }

  update(dt: number) {
    if (dt <= 0) return;
    this.drops.forEach((d, i) => {
      if (d.life <= 0) return;
      d.life -= dt;
      d.v.y -= 9.81 * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y <= d.ground + ON_ROAD || d.life <= 0) {
        // where it lands, a spot, drawn out the way it was going
        const along = Math.hypot(d.v.x, d.v.z);
        if (d.life > 0 && Math.random() < 0.45) this.splat(d.p.x, d.ground, d.p.z, d.size, d.size * (1.4 + Math.random() * 1.6), 1 + Math.min(1.2, along * 0.3), Math.atan2(d.v.x, d.v.z) + Math.PI / 2);
        d.life = 0;
        this.dropMesh.setMatrixAt(i, HIDDEN);
        return;
      }
      this.dropMesh.setMatrixAt(i, this.m.compose(d.p, this.q.identity(), this.s.setScalar(d.size)));
    });
    this.splats.forEach((s, i) => {
      if (!s.on) return;
      s.age += dt;
      s.r += (s.to - s.r) * Math.min(1, dt * (s.to > 0.3 ? 0.35 : 12));
      const fade = Math.min(1, Math.max(0, (DRIES + 10 - s.age) / 10));
      if (fade <= 0) {
        s.on = false;
        this.splatMesh.setMatrixAt(i, HIDDEN);
        return;
      }
      this.q.setFromAxisAngle(UP, s.yaw);
      this.splatMesh.setMatrixAt(i, this.m.compose(this.p.set(s.x, s.y, s.z), this.q, this.s.set(s.r * s.stretch * fade, 1, s.r * fade)));
    });
    this.dropMesh.instanceMatrix.needsUpdate = true;
    this.splatMesh.instanceMatrix.needsUpdate = true;
  }
}
