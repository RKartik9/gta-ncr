import * as THREE from 'three/webgpu';
import { type CarSpec, HATCHBACK, axleHeight, restLength, rideHeight } from './cars.ts';
import { clamp, lerp } from '../util.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { numberPlateTexture, wheelTexture } from '../render/textures.ts';

export interface CarWheel {
  /** moves with the suspension and turns with the steering */
  pivot: THREE.Group;
  /** rolls */
  spin: THREE.Object3D;
  /** how far this wheel's centre sits above the one the physics uses, for cars with unequal wheels */
  lift: number;
  /** which of the physics' four wheels it follows, when not its own place in the list: a bike has two for four */
  follows?: number;
}

export interface CarModel {
  /** the car's figures, corrected to what the model actually measures */
  spec: CarSpec;
  /** follows the chassis */
  group: THREE.Group;
  /** front-left, front-right, rear-left, rear-right */
  wheels: CarWheel[];
  /** a bike's frame and wheels, hinged where the tyres meet the road so it can be leant into a corner */
  lean?: THREE.Group;
  /** whoever is driving; hidden when the camera is where his head is */
  rider?: THREE.Object3D;
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

/** What a car modelled in code looks like: its side profile, where its glass is, and its paint. */
interface Look {
  /** rear (-z) to nose (+z), in metres above the road: [z, roof, belt, half-width, floor] */
  profile: number[][];
  paint: number;
  /** half-width of the roof: the glasshouse leans in to it from the shoulders */
  roof: number;
  /** stretches of z that are glass: the side windows and the pillar that splits them, the windscreen, the rear window */
  side: [number, number];
  pillar: [number, number];
  screen: [number, number];
  rear: [number, number];
  /** half-width of a tyre */
  tyre: number;
  /** a spare wheel hung on the tailgate */
  spare?: boolean;
}

const LOOKS: Record<string, Look> = {
  hatchback: {
    profile: [
      [-1.92, 0.86, 0.86, 0.68, 0.36], [-1.86, 1.0, 0.97, 0.78, 0.27], [-1.76, 1.08, 1.0, 0.82, 0.22], [-1.5, 1.33, 1.0, 0.84, 0.2],
      [-1.28, 1.46, 1.0, 0.84, 0.2], [-0.6, 1.5, 0.99, 0.84, 0.2], [0.06, 1.47, 0.98, 0.84, 0.2], [0.44, 1.23, 0.97, 0.84, 0.2],
      [0.8, 1.0, 0.96, 0.84, 0.2], [1.3, 0.94, 0.92, 0.83, 0.2], [1.66, 0.87, 0.85, 0.8, 0.22], [1.84, 0.76, 0.75, 0.74, 0.28], [1.92, 0.64, 0.64, 0.64, 0.38],
    ],
    paint: 0xa30d16, roof: 0.63, side: [-1.27, 0.56], pillar: [-0.42, -0.32], screen: [0.1, 0.76], rear: [-1.74, -1.36], tyre: 0.1,
  },
  // A box on a ladder frame: flat bonnet, upright screen, flat roof, a tail as square as the nose, and the spare on the back.
  thar: {
    profile: [
      [-1.99, 1.2, 1.18, 0.8, 0.55], [-1.95, 1.8, 1.18, 0.85, 0.45], [-1.8, 1.84, 1.18, 0.86, 0.42], [-0.6, 1.85, 1.18, 0.86, 0.42],
      [0.22, 1.83, 1.18, 0.86, 0.42], [0.52, 1.24, 1.18, 0.86, 0.42], [0.6, 1.17, 1.15, 0.84, 0.42], [1.55, 1.12, 1.1, 0.8, 0.42],
      [1.86, 1.08, 1.06, 0.76, 0.45], [1.96, 0.95, 0.95, 0.72, 0.52], [1.99, 0.8, 0.8, 0.66, 0.6],
    ],
    paint: 0xb5121b, roof: 0.76, side: [-1.7, 0.36], pillar: [-0.56, -0.44], screen: [0.22, 0.56], rear: [-1.97, -1.82], tyre: 0.13, spare: true,
  },
  // A crossover: a long sloping screen, a roof that falls away to a raked tailgate.
  creta: {
    profile: [
      [-2.15, 0.95, 0.95, 0.7, 0.45], [-2.1, 1.15, 1.08, 0.82, 0.34], [-1.98, 1.3, 1.1, 0.86, 0.28], [-1.7, 1.56, 1.1, 0.88, 0.26],
      [-1.2, 1.63, 1.09, 0.89, 0.26], [-0.3, 1.635, 1.07, 0.89, 0.26], [0.2, 1.58, 1.06, 0.89, 0.26], [0.75, 1.2, 1.05, 0.89, 0.26],
      [0.95, 1.07, 1.04, 0.88, 0.26], [1.6, 1.0, 0.98, 0.86, 0.27], [1.95, 0.92, 0.9, 0.82, 0.3], [2.1, 0.78, 0.77, 0.76, 0.36], [2.15, 0.64, 0.64, 0.66, 0.44],
    ],
    paint: 0xe4e6e8, roof: 0.64, side: [-1.55, 0.62], pillar: [-0.4, -0.3], screen: [0.22, 0.93], rear: [-1.97, -1.68], tyre: 0.11,
  },
};

function profileAt(look: Look, z: number) {
  const P = look.profile;
  let i = 1;
  while (i < P.length - 1 && P[i][0] < z) i++;
  const a = P[i - 1], b = P[i];
  const t = clamp((z - a[0]) / (b[0] - a[0]), 0, 1);
  return { top: lerp(a[1], b[1], t), belt: lerp(a[2], b[2], t), w: lerp(a[3], b[3], t), floor: lerp(a[4], b[4], t) };
}

const RING = 16;

/** Half a cross-section (x >= 0), from the floor centre up and over to the roof centre. */
function section(look: Look, z: number): [number, number][] {
  const { top, belt, w, floor } = profileAt(look, z);
  const cabin = clamp((top - belt) / 0.4, 0, 1);
  const wt = lerp(w * 0.9, look.roof, cabin); // the glasshouse leans in towards the roof
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
const within = (z: number, [from, to]: [number, number]) => z > from && z < to;

/** Which material a body panel gets, from where it sits on the shell. */
function panel(look: Look, z: number, ring: number, cabinHeight: number): number {
  const P = look.profile;
  if (ring <= 1) return TRIM; // underside
  if (ring >= 7 && ring <= 9 && cabinHeight > 0.13 && within(z, look.side) && !within(z, look.pillar)) return GLASS; // doors, split by the B-pillar
  if (ring >= 11 && (within(z, look.screen) || within(z, look.rear))) return GLASS; // windscreen and tailgate
  if ((ring === 5 || ring === 6) && z > P[P.length - 1][0] - 0.32) return HEAD;
  if ((ring === 5 || ring === 6) && z < P[0][0] + 0.14) return TAIL;
  if (ring === 2) return TRIM; // sill
  return PAINT;
}

function shellGeometry(look: Look) {
  const from = look.profile[0][0], to = look.profile[look.profile.length - 1][0];
  const stations: number[] = [];
  for (let z = from; z <= to + 1e-4; z += 0.04) stations.push(Math.min(to, z));
  const pos: number[] = [];
  const idx: number[][] = [[], [], [], [], []];
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (const z of stations) for (const [x, y] of section(look, z)) pos.push(x * side, y, z);
    for (let s = 0; s < stations.length - 1; s++) {
      const zm = (stations[s] + stations[s + 1]) / 2;
      const p = profileAt(look, zm);
      for (let r = 0; r < RING - 1; r++) {
        const a = base + s * RING + r, b = a + 1, c = a + RING, d = c + 1;
        const list = idx[panel(look, zm, r, p.top - p.belt)];
        if (side > 0) list.push(a, b, c, b, d, c);
        else list.push(a, c, b, b, c, d);
      }
    }
    // nose and tail
    for (const [s, flip] of [[0, false], [stations.length - 1, true]] as const) {
      const ring = section(look, stations[s]);
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

function wheelGeometry(r: number, hw: number) {
  // tyre cross-section, revolved round the axle
  const pts = [[r * 0.62, -hw], [r * 0.9, -hw], [r * 0.985, -hw * 0.8], [r, -hw * 0.5], [r, hw * 0.5], [r * 0.985, hw * 0.8], [r * 0.9, hw], [r * 0.62, hw]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 28).rotateZ(Math.PI / 2);
}

/**
 * A code-built car flattened for drawing many copies: everything on its body (shell, wheel arches, mirrors,
 * number plates, a spare wheel) merged into one geometry with a group per material, standing on the road at
 * the origin; and one wheel (tyre, then alloy faces). The cabin's insides are left out: the glass hides them.
 */
export function carShape(spec: CarSpec) {
  const model = buildCodedCar(spec);
  const body = model.group.children[0];
  body.position.y = 0;
  body.updateMatrixWorld(true);
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData.interior || o.parent?.userData.interior) return;
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = Array.isArray(mesh.material) ? g.groups : [{ start: 0, count: g.index ? g.index.count : g.attributes.position.count, materialIndex: 0 }];
    for (const { start, count, materialIndex } of groups) {
      const part = g.clone();
      part.clearGroups();
      if (g.index) part.setIndex(Array.from(g.index.array.slice(start, start + count)));
      const flat = part.index ? part.toNonIndexed() : part;
      const m = mats[materialIndex ?? 0];
      (byMaterial.get(m) ?? byMaterial.set(m, []).get(m)!).push(flat);
    }
  });
  const materials = [...byMaterial.keys()];
  const shell = mergeGeometries(materials.map((m) => mergeGeometries(byMaterial.get(m)!)!), true)!;
  const shellMats = (body.children.find((o) => Array.isArray((o as THREE.Mesh).material)) as THREE.Mesh).material as THREE.Material[];
  const tyre = model.wheels[0].spin.children as THREE.Mesh[];
  const wheel = mergeGeometries(tyre.map((m) => {
    m.updateMatrix();
    return m.geometry.clone().applyMatrix4(m.matrix);
  }), true)!;
  return {
    shell, materials, wheel, wheelMaterials: tyre.map((m) => m.material as THREE.Material),
    /** which of `materials` are the paint and the head and tail lamps */
    paint: materials.indexOf(shellMats[PAINT]), head: materials.indexOf(shellMats[HEAD]), tail: materials.indexOf(shellMats[TAIL]),
  };
}

/** A plain road wheel for the traffic's own vehicles: tyre, then alloy faces (material groups: rubber, alloy). */
export function plainWheel(radius: number, halfWidth: number) {
  const faces = [1, -1].map((side) => new THREE.CircleGeometry(radius * 0.66, 20).rotateY((side * Math.PI) / 2).translate(side * halfWidth * 0.85, 0, 0));
  return {
    wheel: mergeGeometries([wheelGeometry(radius, halfWidth), mergeGeometries(faces)!], true)!,
    wheelMaterials: [new THREE.MeshStandardMaterial({ color: 0x151516, roughness: 0.86 }), new THREE.MeshStandardMaterial({ map: wheelTexture(), roughness: 0.35, metalness: 0.7 })] as THREE.Material[],
  };
}

/** The stand-in car: used when a model file cannot be loaded. */
export const buildHatchback = () => buildCodedCar(HATCHBACK);

/** A car modelled in code, for the ones with no model file: its `Look` is found by the spec's id. */
export function buildCodedCar(wanted: CarSpec): CarModel {
  const CAR = LOOKS[wanted.id] ? wanted : HATCHBACK;
  const look = LOOKS[CAR.id];
  const P = look.profile;
  const tailEnd = P[0], noseEnd = P[P.length - 1];
  const widest = Math.max(...P.map((p) => p[3]));
  const group = new THREE.Group();
  group.name = `car-${CAR.id}`;
  const body = new THREE.Group();
  body.position.y = -rideHeight(CAR);
  group.add(body);

  const paint = new THREE.MeshPhysicalMaterial({ color: look.paint, roughness: 0.42, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x06090b, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.7, side: THREE.DoubleSide });
  const head = new THREE.MeshStandardMaterial({ color: 0xf3f6f8, roughness: 0.1, metalness: 0.6, emissive: 0xfff3da, emissiveIntensity: 0.6 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x7a0a0a, roughness: 0.25, emissive: 0xff1a0a, emissiveIntensity: 0.5 });
  const shell = new THREE.Mesh(shellGeometry(look), [paint, glass, trim, head, tail]);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  const dark = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.95 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151516, roughness: 0.86 });
  const alloy = new THREE.MeshStandardMaterial({ map: wheelTexture(), roughness: 0.3, metalness: 0.75 });
  const tyre = wheelGeometry(CAR.wheelRadius, look.tyre);
  const face = new THREE.CircleGeometry(CAR.wheelRadius * 0.66, 24);
  const wheels: CarWheel[] = [];
  for (const [x, z] of [[CAR.track, CAR.axleFront], [-CAR.track, CAR.axleFront], [CAR.track, CAR.axleRear], [-CAR.track, CAR.axleRear]]) {
    const wheel = new THREE.Group();
    const t = new THREE.Mesh(tyre, rubber);
    t.castShadow = true;
    const f = new THREE.Mesh(face, alloy);
    f.rotation.y = x > 0 ? Math.PI / 2 : -Math.PI / 2;
    f.position.x = Math.sign(x) * look.tyre * 0.85;
    wheel.add(t, f);
    const pivot = new THREE.Group();
    pivot.position.set(x, axleHeight(CAR) - restLength(CAR), z);
    pivot.add(wheel);
    group.add(pivot);
    wheels.push({ pivot, spin: wheel, lift: 0 });
  }
  // A dark drum through the body at each axle reads as a pair of wheel arches.
  for (const z of [CAR.axleFront, CAR.axleRear]) {
    const well = new THREE.Mesh(new THREE.CylinderGeometry(CAR.wheelRadius + 0.075, CAR.wheelRadius + 0.075, widest * 2 + 0.01, 24).rotateZ(Math.PI / 2), dark);
    well.position.set(0, CAR.wheelRadius + 0.02, z);
    body.add(well);
  }
  if (look.spare) {
    const spare = new THREE.Mesh(wheelGeometry(CAR.wheelRadius, look.tyre).rotateY(Math.PI / 2), rubber);
    const hub = new THREE.Mesh(face, alloy);
    hub.rotation.y = Math.PI;
    hub.position.z = -look.tyre * 0.85;
    spare.add(hub);
    spare.position.set(0, 1.05, tailEnd[0] - look.tyre - 0.04);
    spare.castShadow = true;
    body.add(spare);
  }

  const plate = new THREE.MeshStandardMaterial({ map: numberPlateTexture(), roughness: 0.5 });
  const plateGeo = new THREE.PlaneGeometry(0.5, 0.125);
  const front = new THREE.Mesh(plateGeo, plate);
  front.position.set(0, noseEnd[1] - 0.14, noseEnd[0] + 0.005);
  const rear = new THREE.Mesh(plateGeo, plate);
  // under the spare, where there is one
  rear.position.set(0, look.spare ? tailEnd[4] + 0.07 : tailEnd[1] - 0.24, tailEnd[0] - 0.005);
  rear.rotation.y = Math.PI;
  body.add(front, rear);

  for (const side of [1, -1]) {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.07), paint);
    mirror.position.set(side * (widest + 0.06), profileAt(look, look.screen[1]).belt + 0.06, look.screen[1] - 0.14);
    mirror.castShadow = true;
    body.add(mirror);
  }

  // Just enough interior for the cockpit view, set out from where the driver's eyes are. Right-hand drive: the driver sits on -x.
  const [eyeX, eyeY, eyeZ] = CAR.cockpitCamera;
  const dash = new THREE.Mesh(new THREE.BoxGeometry(widest * 1.8, 0.22, 0.42), new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 }));
  dash.position.set(0, eyeY - 0.3, eyeZ + 0.74);
  const column = new THREE.Group();
  column.position.set(eyeX, eyeY - 0.22, eyeZ + 0.46);
  column.rotation.x = -1.1;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 8, 28), new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.6 }));
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.035, 0.02), rim.material);
  column.add(rim, spoke);
  column.name = 'steering-wheel';
  const seats = new THREE.Mesh(new THREE.BoxGeometry(widest * 1.55, 0.5, 1.5), new THREE.MeshStandardMaterial({ color: 0x232426, roughness: 0.95 }));
  seats.position.set(0, eyeY - 0.65, eyeZ - 0.33);
  dash.userData.interior = column.userData.interior = seats.userData.interior = true;
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
