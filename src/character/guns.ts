import * as THREE from 'three/webgpu';

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
}

export const GUNS: Record<GunName, Gun> = {
  m416: { name: 'm416', label: 'M416', interval: 60 / 720, mag: 30, reload: 2.1, damage: 34, push: 16, climb: 0.012, spread: 0.006 },
  akm: { name: 'akm', label: 'AKM', interval: 60 / 600, mag: 30, reload: 2.4, damage: 46, push: 22, climb: 0.02, spread: 0.01 },
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
 * The rifle drawn in code, a few boxes and tubes, in its own space: the pistol grip at the origin (where the right
 * hand holds it), the barrel along +z, up +y. Each knows where its muzzle is, for the flash and the tracer.
 */
function build(name: GunName) {
  const g = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.55, metalness: 0.6 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3b3e, roughness: 0.35, metalness: 0.85 });
  if (name === 'm416') {
    const tan = new THREE.MeshStandardMaterial({ color: 0x2b2a26, roughness: 0.8 });
    g.add(
      box(0.06, 0.08, 0.42, 0, 0.06, 0.1, black), // receiver
      box(0.055, 0.02, 0.36, 0, 0.11, 0.1, steel), // top rail
      box(0.065, 0.07, 0.24, 0, 0.055, 0.42, tan), // handguard
      tube(0.011, 0.2, 0.62, 0.06, steel), // barrel past it
      tube(0.018, 0.06, 0.73, 0.06, black), // flash hider
      box(0.035, 0.11, 0.045, 0, -0.03, -0.01, tan, -0.35), // pistol grip
      box(0.045, 0.17, 0.07, 0, -0.06, 0.18, black, 0.12), // magazine
      box(0.045, 0.09, 0.22, 0, 0.05, -0.22, tan), // stock
      box(0.03, 0.04, 0.08, 0, 0.145, 0.05, black), // sight
    );
    g.userData.muzzle = new THREE.Vector3(0, 0.06, 0.77);
  } else {
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a3f1d, roughness: 0.55 });
    g.add(
      box(0.055, 0.075, 0.4, 0, 0.055, 0.1, steel), // receiver
      box(0.06, 0.06, 0.22, 0, 0.05, 0.4, wood), // handguard
      tube(0.012, 0.32, 0.66, 0.065, steel), // barrel
      tube(0.016, 0.05, 0.84, 0.065, black), // muzzle brake
      box(0.006, 0.04, 0.01, 0, 0.1, 0.8, steel), // front sight
      box(0.035, 0.11, 0.045, 0, -0.03, -0.01, wood, -0.4), // pistol grip
      box(0.042, 0.12, 0.065, 0, -0.03, 0.2, black, 0.25), // magazine, curved forward
      box(0.042, 0.1, 0.065, 0, -0.12, 0.26, black, 0.55),
      box(0.045, 0.085, 0.26, 0, 0.03, -0.24, wood, 0.12), // stock
    );
    g.userData.muzzle = new THREE.Vector3(0, 0.065, 0.87);
  }
  g.traverse((o) => (o.castShadow = true));
  g.visible = false;
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);

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
  private m = new THREE.Matrix4();
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
      model.scale.setScalar(at ? 0.001 : 1);
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

  /** The rifle in the right hand at `hand`, pointing along `dir`; returns where its muzzle is. */
  hold(hand: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3) {
    if (!this.held) return out.copy(hand);
    const model = this.models[this.held];
    model.position.copy(hand);
    model.quaternion.setFromRotationMatrix(this.m.lookAt(this.v.set(0, 0, 0), dir.clone().negate(), UP));
    return out.copy(model.userData.muzzle as THREE.Vector3).applyQuaternion(model.quaternion).add(model.position);
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
