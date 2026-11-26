import * as THREE from 'three/webgpu';
import type { V3 } from '../vehicle/rider.ts';

export type GunName = 'm416' | 'akm';

export interface Gun {
  name: GunName;
  label: string;
  /** seconds between rounds, held down */
  interval: number;
  mag: number;
  reload: number;
  /** damage to the body; the head is always fatal and the legs take half */
  damage: number;
  /** N s a round pushes whoever it hits with */
  push: number;
  /** radians the muzzle climbs with each round, and its scatter */
  climb: number;
  spread: number;
  /**
   * Where it is held, in its own space (the pistol grip at the origin, the barrel along +z, up +y): the middle of
   * the butt that goes into the shoulder, the underside of the handguard where the left hand carries it, and
   * the magazine the left hand goes to on a reload.
   */
  butt: V3;
  support: V3;
  magazine: V3;
}

/** the rifles are drawn a little under life size: the figures' arms are short for their height, and a full-size rifle is more than they can hold */
const SIZE = 0.88;
const sized = (x: number, y: number, z: number): V3 => [x * SIZE, y * SIZE, z * SIZE];

export const GUNS: Record<GunName, Gun> = {
  m416: { name: 'm416', label: 'M416', interval: 60 / 720, mag: 30, reload: 2.6, damage: 34, push: 16, climb: 0.012, spread: 0.006, butt: sized(0, 0.04, -0.32), support: sized(0, 0.038, 0.275), magazine: sized(0, -0.1, 0.135) },
  akm: { name: 'akm', label: 'AKM', interval: 60 / 600, mag: 30, reload: 2.1, damage: 46, push: 22, climb: 0.02, spread: 0.01, butt: sized(0, 0.005, -0.325), support: sized(0, 0.017, 0.28), magazine: sized(0, -0.1, 0.19) },
};

const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material, rx = 0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rx;
  return mesh;
};
const tube = (r: number, len: number, z: number, y: number, m: THREE.Material) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10).rotateX(Math.PI / 2), m);
  mesh.position.set(0, y, z);
  return mesh;
};

/**
 * The rifle drawn in code, boxes and tubes, life size, in its own space: the pistol grip at the origin (where the
 * right hand holds it), the barrel along +z, up +y. Each knows where its muzzle is, for the flash and the tracer,
 * and has its magazine as a part of its own, to come out in the left hand on a reload.
 */
function build(name: GunName) {
  const g = new THREE.Group(), mag = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.55, metalness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3b3e, roughness: 0.35, metalness: 0.85 });
  if (name === 'm416') {
    const polymer = new THREE.MeshStandardMaterial({ color: 0x25262a, roughness: 0.85 });
    const alloy = new THREE.MeshStandardMaterial({ color: 0x4b4d52, roughness: 0.5, metalness: 0.7 });
    g.add(
      box(0.05, 0.05, 0.34, 0, 0.075, 0.09, black), // upper receiver
      box(0.046, 0.045, 0.2, 0, 0.03, 0.06, alloy), // lower receiver
      box(0.044, 0.05, 0.065, 0, 0.012, 0.135, alloy), // magazine well
      box(0.03, 0.012, 0.36, 0, 0.106, 0.1, steel), // top rail
      box(0.054, 0.06, 0.26, 0, 0.068, 0.39, polymer), // handguard
      box(0.03, 0.012, 0.24, 0, 0.104, 0.39, steel), // its rail
      tube(0.0095, 0.15, 0.595, 0.07, steel), // barrel past it
      tube(0.015, 0.05, 0.685, 0.07, black), // flash hider
      box(0.012, 0.045, 0.02, 0, 0.115, 0.5, black), // front sight
      box(0.03, 0.03, 0.035, 0, 0.127, -0.03, black), // rear sight
      box(0.034, 0.1, 0.042, 0, -0.04, -0.018, polymer, -0.3), // pistol grip
      box(0.008, 0.006, 0.07, 0, -0.022, 0.045, black), // trigger guard
      box(0.006, 0.022, 0.008, 0, -0.006, 0.04, steel, 0.3), // trigger
      tube(0.015, 0.2, -0.17, 0.07, alloy), // buffer tube
      box(0.04, 0.105, 0.14, 0, 0.045, -0.24, polymer), // stock
      box(0.042, 0.115, 0.012, 0, 0.04, -0.314, black), // butt pad
      box(0.012, 0.02, 0.05, 0.03, 0.085, 0.02, steel), // charging handle, on the left
    );
    mag.add(box(0.036, 0.16, 0.058, 0, -0.08, 0.146, alloy, -0.14), box(0.038, 0.014, 0.062, 0, -0.16, 0.157, black, -0.14));
    g.userData.muzzle = new THREE.Vector3(0, 0.07, 0.71).multiplyScalar(SIZE);
  } else {
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a4a22, roughness: 0.5 });
    const blued = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.4, metalness: 0.8 });
    g.add(
      box(0.042, 0.062, 0.32, 0, 0.045, 0.1, blued), // receiver
      box(0.038, 0.022, 0.26, 0, 0.085, 0.08, steel), // dust cover
      box(0.05, 0.05, 0.18, 0, 0.042, 0.345, wood), // lower handguard
      box(0.04, 0.03, 0.14, 0, 0.088, 0.33, wood), // upper handguard, over the gas tube
      tube(0.0105, 0.3, 0.585, 0.058, blued), // barrel
      tube(0.008, 0.15, 0.475, 0.09, blued), // gas tube
      box(0.02, 0.05, 0.03, 0, 0.078, 0.56, blued), // gas block
      box(0.008, 0.05, 0.012, 0, 0.09, 0.69, blued), // front sight post
      tube(0.014, 0.04, 0.75, 0.058, blued), // slant brake
      box(0.02, 0.02, 0.06, 0, 0.105, 0.24, blued), // rear sight
      box(0.032, 0.1, 0.042, 0, -0.04, -0.018, wood, -0.36), // pistol grip
      box(0.008, 0.006, 0.075, 0, -0.022, 0.05, blued), // trigger guard
      box(0.006, 0.022, 0.008, 0, -0.004, 0.04, steel, 0.3), // trigger
      box(0.038, 0.07, 0.16, 0, 0.03, -0.14, wood, 0.1), // stock, dropping away from the receiver
      box(0.04, 0.095, 0.13, 0, 0.012, -0.255, wood, 0.1),
      box(0.042, 0.105, 0.012, 0, 0.004, -0.322, blued, 0.1), // butt plate
      box(0.012, 0.012, 0.045, -0.027, 0.07, 0.12, steel), // bolt handle, on the right
    );
    // the magazine, curved forward: four pieces of it, each hung from the end of the last
    let y = 0.02, z = 0.165;
    for (const lean of [0.12, 0.3, 0.5, 0.7]) {
      const dy = -Math.cos(lean) * 0.058, dz = Math.sin(lean) * 0.058;
      mag.add(box(0.03, 0.066, 0.062, 0, y + dy / 2, z + dz / 2, blued, -lean));
      y += dy;
      z += dz;
    }
    g.userData.muzzle = new THREE.Vector3(0, 0.058, 0.77).multiplyScalar(SIZE);
  }
  g.add(mag);
  g.userData.mag = mag;
  g.traverse((o) => (o.castShadow = true));
  g.scale.setScalar(SIZE);
  g.visible = false;
  return g;
}

/** The rifles, the flash at the muzzle and the streak of a round, and the crosshair and the count of rounds on the screen. */
export class Armoury {
  readonly group = new THREE.Group();
  private models: Record<GunName, THREE.Group>;
  private flash: THREE.Mesh;
  private light = new THREE.PointLight(0xffc070, 0, 9, 2);
  private flashLeft = 0;
  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private nextTracer = 0;
  private held: GunName | null = null;
  private hud: HTMLDivElement;
  private count: HTMLDivElement;
  private v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.models = { m416: build('m416'), akm: build('akm') };
    const glow = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.flash = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.28, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.14), glow);
    this.flash.visible = false;
    const streak = new THREE.MeshBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 1).translate(0, 0, 0.5), streak);
      mesh.visible = false;
      this.tracers.push({ mesh, life: 0 });
      this.group.add(mesh);
    }
    this.light.position.set(0, -1000, 0);
    this.group.add(this.models.m416, this.models.akm, this.flash, this.light);
    scene.add(this.group);

    // the crosshair in the middle of the screen, and the rounds left in the corner
    this.hud = document.createElement('div');
    this.hud.style.cssText = 'position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none;display:none;z-index:5;' +
      'background:linear-gradient(#fff,#fff) center/2px 7px no-repeat,linear-gradient(#fff,#fff) center/7px 2px no-repeat;filter:drop-shadow(0 0 2px #000)';
    this.hud.innerHTML = '<div style="position:absolute;inset:0;border:2px solid rgba(255,255,255,.85);border-radius:50%;clip-path:polygon(0 0,35% 0,35% 100%,65% 100%,65% 0,100% 0,100% 35%,0 35%,0 65%,100% 65%,100% 100%,0 100%)"></div>';
    this.count = document.createElement('div');
    this.count.style.cssText = 'position:fixed;right:28px;bottom:120px;color:#fff;font:600 22px/1.2 system-ui,sans-serif;text-align:right;' +
      'text-shadow:0 1px 4px #000;pointer-events:none;display:none;z-index:5';
    document.body.append(this.hud, this.count);
  }

  /** Drawn for a frame too small to see at `at` (null: put away again), so their shaders are made before anyone needs them. */
  warm(at: THREE.Vector3 | null) {
    for (const model of Object.values(this.models)) {
      model.visible = !!at;
      model.scale.setScalar(at ? 0.001 : SIZE);
      if (at) model.position.copy(at);
    }
    if (!at) this.show(this.held);
  }

  /** Which rifle is in the player's hands (or none), and what the screen says about it. */
  show(name: GunName | null, rounds = 0, reloading = false) {
    this.held = name;
    for (const [n, model] of Object.entries(this.models)) model.visible = n === name;
    this.hud.style.display = this.count.style.display = name ? 'block' : 'none';
    if (name) this.count.innerHTML = `${GUNS[name].label}<br><span style="font-size:30px">${reloading ? '…' : rounds}</span><span style="opacity:.6"> / ${GUNS[name].mag}</span>`;
  }

  /**
   * The rifle with its grip at `at`, turned by `turn`, as whoever holds it has it this frame; `mag` is how far
   * the magazine is out of it, in the rifle's own space (a reload). Returns where its muzzle is.
   */
  hold(at: THREE.Vector3, turn: THREE.Quaternion, mag: THREE.Vector3, out: THREE.Vector3) {
    if (!this.held) return out.copy(at);
    const model = this.models[this.held];
    model.position.copy(at);
    model.quaternion.copy(turn);
    (model.userData.mag as THREE.Group).position.copy(mag).divideScalar(SIZE);
    return out.copy(model.userData.muzzle as THREE.Vector3).applyQuaternion(turn).add(at);
  }

  /** A round fired from `muzzle` along `dir`, landing at `to`. */
  fired(muzzle: THREE.Vector3, dir: THREE.Vector3, to: THREE.Vector3) {
    this.flash.position.copy(muzzle);
    this.flash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    this.flash.rotateZ(Math.random() * Math.PI);
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flash.visible = true;
    this.light.position.copy(muzzle);
    this.light.intensity = 30;
    this.flashLeft = 0.045;
    // one round in two drawn as a streak: enough to see where it is going
    if (this.nextTracer++ % 2) return;
    const t = this.tracers[this.nextTracer % this.tracers.length];
    const length = muzzle.distanceTo(to);
    t.mesh.position.copy(muzzle);
    t.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.v.copy(to).sub(muzzle).normalize());
    t.mesh.scale.set(1, 1, length);
    t.mesh.visible = true;
    t.life = 0.06;
  }

  update(dt: number) {
    if ((this.flashLeft -= dt) <= 0) {
      this.flash.visible = false;
      this.light.intensity = 0;
    }
    for (const t of this.tracers) if (t.mesh.visible && (t.life -= dt) <= 0) t.mesh.visible = false;
  }
}
