import * as THREE from 'three/webgpu';
import { type CarSpec, HATCHBACK as CAR, axleHeight, restLength, rideHeight } from './cars.ts';
import { clamp, lerp } from '../util.ts';
import { numberPlateTexture, wheelTexture } from '../render/textures.ts';

export interface CarWheel {
  /** moves with the suspension and turns with the steering */
  pivot: THREE.Group;
  /** rolls */
  spin: THREE.Object3D;
  /** how far this wheel's centre sits above the one the physics uses, for cars with unequal wheels */
  lift: number;
}

export interface CarModel {
  /** the car's figures, corrected to what the model actually measures */
  spec: CarSpec;
  /** follows the chassis */
  group: THREE.Group;
  /** front-left, front-right, rear-left, rear-right */
  wheels: CarWheel[];
  setBraking(on: boolean): void;
  /** headlamp and tail-lamp lenses glow */
  setLights(on: boolean): void;
}

/**
 * One set of car lights for the whole game (headlights, tail glow, cabin and dash), moved onto whichever car is
 * being driven. Switching cars must not change which lights are in the scene: every material's shader depends on
 * that set, so swapping per-car lights rebuilt them all and froze the game for half a second.
 */
export class CarLamps {
  private heads: THREE.SpotLight[];
  private tail = new THREE.PointLight(0xff1a0a, 0, 5, 2);
  // cabin: a warm courtesy light over the seats and the glow of the dash, so the inside is not a black hole at night
  private cabin = new THREE.PointLight(0xffd9a8, 0, 2.2, 2);
  private dash = new THREE.PointLight(0x9fd0ff, 0, 1.2, 2);
  private model: CarModel | null = null;
  private lit = false;
  private braking = false;

  constructor(castShadow: boolean) {
    this.heads = [0, 1].map((i) => {
      const l = new THREE.SpotLight(0xfff1dc, 0, 80, 0.44, 0.45, 1.4);
      if (castShadow && i === 0) {
        l.castShadow = true;
        l.shadow.mapSize.set(1024, 1024);
        l.shadow.camera.near = 0.3;
        l.shadow.bias = -0.0006;
      }
      return l;
    });
  }

  get on() {
    return this.lit;
  }

  /** Moves the lights onto `model`, placed from its measured size. */
  attach(model: CarModel) {
    this.model?.setLights(false);
    this.model = model;
    const c = model.spec;
    const y = 0.68 - rideHeight(c);
    const nose = c.length / 2 - 0.15;
    this.heads.forEach((l, i) => {
      const side = i === 0 ? 1 : -1;
      l.position.set(side * c.width * 0.33, y, nose);
      l.target.position.set(side * c.width * 0.2, y - 1.4, nose + 24);
      model.group.add(l, l.target);
    });
    this.tail.position.set(0, y, -c.length / 2 - 0.4);
    const [, eyeY, eyeZ] = c.cockpitCamera;
    this.cabin.position.set(0, eyeY - rideHeight(c) + 0.22, eyeZ - 0.15);
    this.dash.position.set(0, eyeY - rideHeight(c) - 0.3, eyeZ + 0.55);
    model.group.add(this.tail, this.cabin, this.dash);
    this.apply();
  }

  set(on: boolean, brake: boolean) {
    if (on === this.lit && brake === this.braking) return;
    this.lit = on;
    this.braking = brake;
    this.apply();
  }

  private apply() {
    const lit = this.lit;
    for (const l of this.heads) l.intensity = lit ? 420 : 0;
    this.tail.intensity = (lit ? 0.6 : 0) + (this.braking ? 1.6 : 0);
    this.cabin.intensity = lit ? 1.4 : 0;
    this.dash.intensity = lit ? 0.5 : 0;
    this.model?.setLights(lit);
  }
}

// Side profile of a small hatchback, rear (-z) to nose (+z), in metres above the road.
//            z      roof   belt   half-width  floor
const PROFILE = [
  [-1.92, 0.86, 0.86, 0.68, 0.36],
  [-1.86, 1.0, 0.97, 0.78, 0.27],
  [-1.76, 1.08, 1.0, 0.82, 0.22],
  [-1.5, 1.33, 1.0, 0.84, 0.2],
  [-1.28, 1.46, 1.0, 0.84, 0.2],
  [-0.6, 1.5, 0.99, 0.84, 0.2],
  [0.06, 1.47, 0.98, 0.84, 0.2],
  [0.44, 1.23, 0.97, 0.84, 0.2],
  [0.8, 1.0, 0.96, 0.84, 0.2],
  [1.3, 0.94, 0.92, 0.83, 0.2],
  [1.66, 0.87, 0.85, 0.8, 0.22],
  [1.84, 0.76, 0.75, 0.74, 0.28],
  [1.92, 0.64, 0.64, 0.64, 0.38],
];

function profileAt(z: number) {
  let i = 1;
  while (i < PROFILE.length - 1 && PROFILE[i][0] < z) i++;
  const a = PROFILE[i - 1], b = PROFILE[i];
  const t = clamp((z - a[0]) / (b[0] - a[0]), 0, 1);
  return { top: lerp(a[1], b[1], t), belt: lerp(a[2], b[2], t), w: lerp(a[3], b[3], t), floor: lerp(a[4], b[4], t) };
}

const RING = 16;

/** Half a cross-section (x >= 0), from the floor centre up and over to the roof centre. */
function section(z: number): [number, number][] {
  const { top, belt, w, floor } = profileAt(z);
  const cabin = clamp((top - belt) / 0.4, 0, 1);
  const wt = lerp(w * 0.9, 0.63, cabin); // the glasshouse leans in towards the roof
  const drop = Math.min(0.045, (top - belt) * 0.5);
  const shoulder: [number, number] = [w * 0.945, belt + 0.004];
  const rail: [number, number] = [wt, top - drop];
  const mix = (t: number): [number, number] => [lerp(shoulder[0], rail[0], t), lerp(shoulder[1], rail[1], t)];
  return [
    [0, floor], [w * 0.6, floor], [w * 0.9, floor + 0.03], [w * 0.985, floor + 0.12], [w, floor + (belt - floor) * 0.45],
    [w * 0.995, belt - 0.11], [w * 0.975, belt - 0.02], shoulder, mix(0.33), mix(0.66), rail,
    [wt * 0.93, top - drop * 0.3], [wt * 0.8, top], [wt * 0.5, top + 0.008], [wt * 0.25, top + 0.012], [0, top + 0.012],
  ];
}

const PAINT = 0, GLASS = 1, TRIM = 2, HEAD = 3, TAIL = 4;

/** Which material a body panel gets, from where it sits on the shell. */
function panel(z: number, ring: number, cabinHeight: number): number {
  if (ring <= 1) return TRIM; // underside
  if (ring >= 7 && ring <= 9 && cabinHeight > 0.13 && z > -1.27 && z < 0.56 && !(z > -0.42 && z < -0.32)) return GLASS; // doors, split by the B-pillar
  if (ring >= 11 && ((z > 0.1 && z < 0.76) || (z > -1.74 && z < -1.36))) return GLASS; // windscreen and tailgate
  if ((ring === 5 || ring === 6) && z > 1.6) return HEAD;
  if ((ring === 5 || ring === 6) && z < -1.78) return TAIL;
  if (ring === 2) return TRIM; // sill
  return PAINT;
}

function shellGeometry() {
  const stations: number[] = [];
  for (let z = -1.92; z <= 1.9201; z += 0.04) stations.push(Math.min(1.92, z));
  const pos: number[] = [];
  const idx: number[][] = [[], [], [], [], []];
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (const z of stations) for (const [x, y] of section(z)) pos.push(x * side, y, z);
    for (let s = 0; s < stations.length - 1; s++) {
      const zm = (stations[s] + stations[s + 1]) / 2;
      const p = profileAt(zm);
      for (let r = 0; r < RING - 1; r++) {
        const a = base + s * RING + r, b = a + 1, c = a + RING, d = c + 1;
        const list = idx[panel(zm, r, p.top - p.belt)];
        if (side > 0) list.push(a, b, c, b, d, c);
        else list.push(a, c, b, b, c, d);
      }
    }
    // nose and tail
    for (const [s, flip] of [[0, false], [stations.length - 1, true]] as const) {
      const ring = section(stations[s]);
      const cy = (ring[0][1] + ring[RING - 1][1]) / 2;
      const centre = pos.length / 3;
      pos.push(0, cy, stations[s]);
      for (let r = 0; r < RING - 1; r++) {
        const a = base + s * RING + r, b = a + 1;
        if ((side > 0) !== flip) idx[TRIM].push(centre, b, a);
        else idx[TRIM].push(centre, a, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  let start = 0;
  const all: number[] = [];
  idx.forEach((list, m) => {
    g.addGroup(start, list.length, m);
    start += list.length;
    all.push(...list);
  });
  g.setIndex(all);
  g.computeVertexNormals();
  // The two halves do not share vertices, so straighten the normals on the centre line to hide the seam.
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) {
    if (Math.abs(pos[i * 3]) < 1e-4) {
      const l = Math.hypot(n.getY(i), n.getZ(i)) || 1;
      n.setXYZ(i, 0, n.getY(i) / l, n.getZ(i) / l);
    }
  }
  return g;
}

function wheelGeometry() {
  const r = CAR.wheelRadius, hw = 0.1;
  // tyre cross-section, revolved round the axle
  const pts = [[r * 0.62, -hw], [r * 0.9, -hw], [r * 0.985, -hw * 0.8], [r, -hw * 0.5], [r, hw * 0.5], [r * 0.985, hw * 0.8], [r * 0.9, hw], [r * 0.62, hw]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 28).rotateZ(Math.PI / 2);
}

/** The stand-in car, modelled in code: used when a model file cannot be loaded. */
export function buildHatchback(): CarModel {
  const group = new THREE.Group();
  group.name = 'car';
  const body = new THREE.Group();
  body.position.y = -rideHeight(CAR);
  group.add(body);

  const paint = new THREE.MeshPhysicalMaterial({ color: 0xa30d16, roughness: 0.42, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x06090b, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.7, side: THREE.DoubleSide });
  const head = new THREE.MeshStandardMaterial({ color: 0xf3f6f8, roughness: 0.1, metalness: 0.6, emissive: 0xfff3da, emissiveIntensity: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x7a0a0a, roughness: 0.25, emissive: 0xff1a0a, emissiveIntensity: 0.5 });
  const shell = new THREE.Mesh(shellGeometry(), [paint, glass, trim, head, tail]);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  const dark = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151516, roughness: 0.86 });
  const alloy = new THREE.MeshStandardMaterial({ map: wheelTexture(), roughness: 0.3, metalness: 0.75 });
  const tyre = wheelGeometry();
  const face = new THREE.CircleGeometry(CAR.wheelRadius * 0.66, 24);
  const wheels: CarWheel[] = [];
  for (const [x, z] of [[CAR.track, CAR.axleFront], [-CAR.track, CAR.axleFront], [CAR.track, CAR.axleRear], [-CAR.track, CAR.axleRear]]) {
    const wheel = new THREE.Group();
    const t = new THREE.Mesh(tyre, rubber);
    t.castShadow = true;
    const f = new THREE.Mesh(face, alloy);
    f.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
    f.position.x = Math.sign(x) * 0.085;
    wheel.add(t, f);
    const pivot = new THREE.Group();
    pivot.position.set(x, axleHeight(CAR) - restLength(CAR), z);
    pivot.add(wheel);
    group.add(pivot);
    wheels.push({ pivot, spin: wheel, lift: 0 });
  }
  // A dark drum through the body at each axle reads as a pair of wheel arches.
  for (const z of [CAR.axleFront, CAR.axleRear]) {
    const well = new THREE.Mesh(new THREE.CylinderGeometry(0.385, 0.385, 1.69, 24).rotateZ(Math.PI / 2), dark);
    well.position.set(0, 0.33, z);
    body.add(well);
  }

  const plate = new THREE.MeshStandardMaterial({ map: numberPlateTexture(), roughness: 0.5 });
  const plateGeo = new THREE.PlaneGeometry(0.5, 0.125);
  const front = new THREE.Mesh(plateGeo, plate);
  front.position.set(0, 0.5, 1.925);
  const rear = new THREE.Mesh(plateGeo, plate);
  rear.position.set(0, 0.62, -1.925);
  rear.rotation.y = Math.PI;
  body.add(front, rear);

  for (const side of [1, -1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.07), paint);
    mirror.position.set(side * 0.9, 1.03, 0.62);
    mirror.castShadow = true;
    body.add(mirror);
  }

  // Just enough interior for the cockpit view. Right-hand drive: the driver sits on -x.
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.42), new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 }));
  dash.position.set(0, 0.9, 0.62);
  const column = new THREE.Group();
  column.position.set(-0.37, 0.98, 0.34);
  column.rotation.x = -1.1;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 8, 28), new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.6 }));
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.02), rim.material);
  column.add(rim, spoke);
  column.name = 'steering-wheel';
  const seats = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.5), new THREE.MeshStandardMaterial({ color: 0x232426, roughness: 0.95 }));
  seats.position.set(0, 0.55, -0.45);
  body.add(dash, column, seats);

  let lit = false, braking = false;
  return {
    spec: CAR,
    group,
    wheels,
    setBraking(on) {
      braking = on;
      tail.emissiveIntensity = on ? 5 : lit ? 2 : 0.5;
    },
    setLights(on) {
      lit = on;
      head.emissiveIntensity = on ? 6 : 0.6;
      tail.emissiveIntensity = braking ? 5 : on ? 2 : 0.5;
    },
  };
}
