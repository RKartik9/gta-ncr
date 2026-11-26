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

/** An irregular blot about a metre across, facing +z: one shape for every stain, each turned and stretched its own way. */
export function blot() {
  const n = 30, pts: THREE.Vector2[] = [], lobes = Math.random() * 6.3, ripples = Math.random() * 6.3;
  for (let i = 0; i < n; i++) {
    // round, with a few lobes and a ragged edge
    const a = (i / n) * Math.PI * 2, r = 0.85 + Math.sin(a * 3 + lobes) * 0.2 + Math.sin(a * 7 + ripples) * 0.1 + Math.random() * 0.06;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return new THREE.ShapeGeometry(new THREE.Shape(pts));
}

/** puffs in the air at once */
const PUFFS = 14;
interface Puff {
  sprite: THREE.Sprite;
  life: number;
  span: number;
  from: number;
  to: number;
  rise: number;
  thick: number;
}

/** A soft round blur, white: tinted red it is a mist of blood, grey the dust a round knocks off a wall. */
function blur() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d')!, g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Blood: drops thrown off a blow the way it went, falling under gravity, and stains where they land; a pool
 * that spreads under anyone lying knocked out; drips from the badly hurt; and the red mist a round knocks out
 * of someone (and the dust it knocks off a wall). Two meshes for the drops and the stains, a few sprites for the mist.
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
  private puffs: Puff[] = [];
  private nextPuff = 0;
  /** one of everything, for the renderer to build its shaders with before any of it is needed */
  readonly sample = new THREE.Group();

  constructor(scene: THREE.Scene) {
    const map = blur();
    for (let i = 0; i < PUFFS; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map, transparent: true, depthWrite: false, opacity: 0 }));
      sprite.visible = false;
      scene.add(sprite);
      this.puffs.push({ sprite, life: 0, span: 1, from: 0, to: 0, rise: 0, thick: 0 });
    }
    this.sample.add(new THREE.Sprite(new THREE.SpriteNodeMaterial({ map, transparent: true, depthWrite: false, opacity: 0.01 })));
    const wet = instanced(new THREE.MeshStandardNodeMaterial({ color: 0x7a0a05, roughness: 0.3 }));
    const stain = instanced(new THREE.MeshStandardNodeMaterial({ color: 0x4a0805, roughness: 0.45, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.dropMesh = new Instances(new THREE.IcosahedronGeometry(1, 0), wet, Array(DROPS).fill(HIDDEN), true);
    this.splatMesh = new Instances(blot().rotateX(-Math.PI / 2), stain, Array(SPLATS).fill(HIDDEN), true);
    this.splatMesh.receiveShadow = true;
    for (const mesh of [this.dropMesh, this.splatMesh]) {
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    for (let i = 0; i < DROPS; i++) this.drops.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), size: 0, ground: 0 });
    for (let i = 0; i < SPLATS; i++) this.splats.push({ on: false, x: 0, y: 0, z: 0, yaw: 0, r: 0, to: 0, stretch: 1, age: 0 });
  }

  /**
   * A blow landing at `at`, going along `dir`: `amount` is how bad it was (the damage done), and `force` how
   * much faster than a fist's the blood leaves (a round carries it a long way out of the far side).
   */
  spray(at: THREE.Vector3, dir: THREE.Vector3, amount: number, ground: number, force = 1) {
    const n = Math.min(24, Math.round(amount * 0.55));
    for (let k = 0; k < n; k++) {
      const d = this.drops[this.nextDrop++ % DROPS];
      d.p.copy(at);
      // mostly on along the blow, some back towards whoever threw it, all of it fanned out
      const speed = (1 + Math.random() * 3.5) * force;
      d.v.copy(dir).multiplyScalar(Math.random() < 0.8 ? speed : -speed * 0.4);
      d.v.x += (Math.random() - 0.5) * 2.6;
      d.v.y += Math.random() * 2.2 - 0.3;
      d.v.z += (Math.random() - 0.5) * 2.6;
      d.size = 0.004 + Math.random() ** 2 * 0.012;
      d.ground = ground;
      d.life = 3;
    }
  }

  /**
   * A puff at `at`, `size` metres across by the time it has gone, `seconds` later: red by default, the mist off
   * a round going into someone; any other `colour` for dust and smoke.
   */
  puff(at: THREE.Vector3, size = 0.5, seconds = 0.4, colour = 0x7a0a05, thick = 0.75) {
    const p = this.puffs[this.nextPuff++ % PUFFS];
    p.sprite.position.copy(at);
    (p.sprite.material as THREE.SpriteNodeMaterial).color.set(colour);
    p.sprite.material.rotation = Math.random() * 6.3;
    p.sprite.visible = true;
    Object.assign(p, { life: seconds, span: seconds, from: size * 0.25, to: size, rise: colour === 0x7a0a05 ? -0.3 : 0.25, thick });
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
    for (const p of this.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = 1 - Math.max(0, p.life) / p.span;
      // out fast and then hanging, thinning all the while
      p.sprite.scale.setScalar(p.from + (p.to - p.from) * (1 - (1 - k) ** 3));
      p.sprite.position.y += p.rise * dt;
      p.sprite.material.opacity = p.thick * (1 - k) ** 1.5;
      if (p.life <= 0) p.sprite.visible = false;
    }
    this.drops.forEach((d, i) => {
      if (d.life <= 0) return;
      d.life -= dt;
      d.v.y -= 9.81 * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y <= d.ground + ON_ROAD || d.life <= 0) {
        // where it lands, a spot, drawn out the way it was going
        const along = Math.hypot(d.v.x, d.v.z);
        if (d.life > 0 && Math.random() < 0.45) this.splat(d.p.x, d.ground, d.p.z, d.size, d.size * (1.6 + Math.random() * 2.2), 1 + Math.min(1.2, along * 0.3), Math.atan2(d.v.x, d.v.z) + Math.PI / 2);
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
