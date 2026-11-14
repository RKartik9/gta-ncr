import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { zipSync } from 'three/addons/libs/fflate.module.js';
import { CARS, CRETA, type CarSpec, SIAN, THAR, axleHeight, restLength, rideHeight } from './cars.ts';
import type { CarModel, CarWheel } from './carModel.ts';
import { lensLights, mergeInto, tuneMaterials } from './gltfCar.ts';

/** One line of public/models/garage.json: a vehicle brought in through the importer. */
export interface GarageEntry {
  id: string;
  name: string;
  /** the .glb or .gltf under public/models/<id>/ */
  file: string;
  /** whose handling it borrows */
  kind: 'car' | 'suv' | 'sports' | 'bike';
  /** metres, nose to tail: the one figure the model is scaled by */
  length: number;
  /** the model was drawn facing backwards */
  flip?: boolean;
  credit?: string;
  /** a bike's saddle: how high the rider's hips sit above the road and how far forward of the middle, metres */
  seat?: [number, number];
  /** a bike's grips, when they are not found: half the distance between them, their height above the road, how far forward of the middle */
  grips?: [number, number, number];
}

// A sports bike and its rider. The physics has four wheels and no notion of balance, so underneath it is a low,
// narrow car that cannot fall over; the picture has two wheels and leans.
// ponytail: no wheelies, no falling off; a real two-wheel model if bikes become the point of the game.
const BIKE: CarSpec = {
  id: 'bike', name: 'Bike', enginePitch: 1.5,
  mass: 290, length: 2.1, width: 0.8, height: 1.2, groundClearance: 0.16, centreOfMass: 0.36,
  wheelRadius: 0.3, track: 0.5, axleFront: 0.7, axleRear: -0.7, suspensionRest: 0.22, suspensionStiffness: 40,
  weightFront: 0.48, antiRoll: 20, driveFront: 0, engineForce: 2500, reverseForce: 500, brakeDecel: 12, brakeFront: 0.65,
  topSpeed: 55, reverseSpeed: 2, maxSteer: 0.5, gripFront: 1.15, gripRear: 1.2, drag: 0.3, downforce: 0,
  hoodCamera: [0, 1.3, 0.3], cockpitCamera: [0, 1.4, -0.15],
};
const KINDS: Record<GarageEntry['kind'], CarSpec> = { car: CRETA, suv: THAR, sports: SIAN, bike: BIKE };

export const garage: GarageEntry[] = [];

/** Reads garage.json and puts its vehicles in the list of cars. One that carries a built-in car's id gives that car its body. */
export async function loadGarage() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}models/garage.json`, { cache: 'no-store' });
    if (res.ok) garage.push(...((await res.json()) as GarageEntry[]));
  } catch {
    // no garage: the built-in cars are all there is
  }
  for (const e of garage) {
    const imported = { file: e.file, flip: e.flip, bike: e.kind === 'bike', seat: e.seat, grips: e.grips };
    const mine = CARS.find((c) => c.id === e.id);
    if (mine) Object.assign(mine, { imported, credit: e.credit, length: e.length });
    else CARS.push({ ...(KINDS[e.kind] ?? CRETA), id: e.id, name: e.name, model: undefined, credit: e.credit, length: e.length, imported });
  }
}

const WHEEL = /wheel|tyre|tire(?!d)|(?<![a-z])rim(?![a-z])/i;

type Found = { parts: THREE.Object3D[]; box: THREE.Box3 };

/**
 * Finds wheels nobody named, in a model already stood on y = 0 facing +z. A tyre is what touches the road: the
 * patches of the model that reach the ground give each wheel's place and width, and the curve the tyre rises
 * away from the road with gives its radius. Every triangle inside that disc is then cut out of the body.
 * Returns nothing when the model does not stand on wheels this can make sense of.
 * ponytail: what sits inside the wheel turns with it (brake callipers, a hub cap); name the wheels in the file if that shows.
 */
function wheelsByShape(top: THREE.Object3D, bike: boolean, length: number): (Found | undefined)[] | undefined {
  top.updateWorldMatrix(true, true);
  const meshes: THREE.Mesh[] = [];
  top.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as unknown as THREE.SkinnedMesh).isSkinnedMesh && !Array.isArray(m.material)) meshes.push(m);
  });
  const v = new THREE.Vector3();
  const each = (fn: (x: number, y: number, z: number) => void) => {
    for (const m of meshes) {
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        fn(v.x, v.y, v.z);
      }
    }
  };
  const places = bike ? [0, 2] : [0, 1, 2, 3];
  const quad = (x: number, z: number) => (z > 0 ? 0 : 2) + (bike || x > 0 ? 0 : 1);

  // where it touches the road (a bike's side stand does too, off to one side: not that)
  const low = length * 0.02;
  const patch = [0, 1, 2, 3].map(() => ({ x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }));
  each((x, y, z) => {
    if (y > low || (bike && Math.abs(x) > length * 0.06)) return;
    const p = patch[quad(x, z)];
    p.x0 = Math.min(p.x0, x), p.x1 = Math.max(p.x1, x), p.z0 = Math.min(p.z0, z), p.z1 = Math.max(p.z1, z);
  });
  if (places.some((q) => !(patch[q].x1 - patch[q].x0 < length * 0.12 && patch[q].z1 - patch[q].z0 < length * 0.2))) return;
  const wheel = patch.map((p) => ({ x: (p.x0 + p.x1) / 2, z: (p.z0 + p.z1) / 2, half: Math.max((p.x1 - p.x0) / 2, length * 0.015) * 1.3, r: 0, y: 0 }));

  // how fast the tyre climbs away from the road, a little ahead of and behind the patch: a circle of radius r is dz²/2r up
  const bin = length / 400, from = Math.round(0.03 / 0.0025), to = Math.round(0.07 / 0.0025);
  // Only the bottom of the tyre is looked at, where nothing but tyre is: higher up the arch and the sill crowd in.
  // Ahead and behind are kept apart, so a patch found a little off-centre does not flatter the wheel.
  const floor = patch.map(() => new Float32Array(2 * (to + 1)).fill(Infinity));
  each((x, y, z) => {
    const q = quad(x, z), w = wheel[q];
    if (y > length * 0.035 || Math.abs(x - w.x) > w.half) return;
    const k = Math.round(Math.abs(z - w.z) / bin);
    if (k <= to) floor[q][k + (z > w.z ? to + 1 : 0)] = Math.min(floor[q][k + (z > w.z ? to + 1 : 0)], y);
  });
  for (const q of places) {
    // the tyres are not always the lowest thing on the model: each is measured from its own lowest point
    const ground = Math.min(...floor[q].subarray(0, 4), ...floor[q].subarray(to + 1, to + 5));
    const guesses: number[] = [];
    for (let k = from; k <= to; k++) {
      for (const side of [0, to + 1]) {
        const y = floor[q][k + side] - ground, dz = k * bin;
        if (y > 1e-4 && y < Infinity) guesses.push((dz * dz + y * y) / (2 * y));
      }
    }
    // Between a coarse tyre's rings of vertices the lowest point found is on its sidewall, which reads as a smaller
    // wheel: the tread is the biggest circle on offer, bar the odd stray.
    guesses.sort((a, b) => b - a);
    wheel[q].r = guesses[Math.floor(guesses.length * 0.1)] ?? 0;
    wheel[q].y = ground + wheel[q].r;
    if (!(wheel[q].r > length * 0.04 && wheel[q].r < length * 0.2)) return;
  }

  // That is within a couple of centimetres, and a wheel turning about a point two centimetres off its middle
  // visibly wobbles. So a circle is now laid through the tread itself: the outermost vertex in each few degrees
  // of the lower part of the tyre, where no mudguard or arch is in the way. Twice, as the first guess moves.
  const STEP = Math.PI / 45, ARC = 19; // 4 degrees; 76 degrees either side of straight down
  for (let pass = 0; pass < 3; pass++) {
    const rim = patch.map(() => ({ r: new Float32Array(2 * ARC + 1), y: new Float32Array(2 * ARC + 1), z: new Float32Array(2 * ARC + 1) }));
    each((x, y, z) => {
      const q = quad(x, z), w = wheel[q];
      if (Math.abs(x - w.x) > w.half) return;
      const dy = y - w.y, dz = z - w.z, r = Math.hypot(dy, dz);
      const k = Math.round(Math.atan2(dz, -dy) / STEP) + ARC;
      if (r < w.r * 0.8 || r > w.r * 1.12 || k < 0 || k > 2 * ARC || r <= rim[q].r[k]) return;
      rim[q].r[k] = r, rim[q].y[k] = y, rim[q].z[k] = z;
    });
    for (const q of places) {
      // least squares for y² + z² + Dy + Ez + F = 0
      let n = 0, sy = 0, sz = 0, syy = 0, szz = 0, syz = 0, by = 0, bz = 0, b1 = 0;
      for (let k = 0; k <= 2 * ARC; k++) {
        if (!rim[q].r[k]) continue;
        const y = rim[q].y[k], z = rim[q].z[k], d = y * y + z * z;
        n++, (sy += y), (sz += z), (syy += y * y), (szz += z * z), (syz += y * z), (by -= d * y), (bz -= d * z), (b1 -= d);
      }
      if (n < 6) continue;
      const m = new THREE.Matrix3().set(syy, syz, sy, syz, szz, sz, sy, sz, n);
      if (Math.abs(m.determinant()) < 1e-12) continue;
      const [D, E, F] = new THREE.Vector3(by, bz, b1).applyMatrix3(m.invert()).toArray();
      const r = Math.sqrt(Math.max(0, (D * D + E * E) / 4 - F));
      // a fit that has run off (it found the mudguard, not the tyre) is not believed
      if (Math.abs(r - wheel[q].r) > wheel[q].r * 0.15) continue;
      Object.assign(wheel[q], { y: -D / 2, z: -E / 2, r });
    }
  }
  // the two wheels of an axle are the same wheel
  if (!bike) for (const q of [0, 2]) wheel[q].r = wheel[q + 1].r = (wheel[q].r + wheel[q + 1].r) / 2;

  const out: (Found | undefined)[] = [undefined, undefined, undefined, undefined];
  for (const q of places) {
    const w = wheel[q];
    out[q] = { parts: [], box: new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(w.x, w.y, w.z), new THREE.Vector3(w.half * 2, w.r * 2, w.r * 2)) };
  }
  const inside = (q: number) => {
    const w = wheel[q];
    return Math.abs(v.x - w.x) < w.half && (v.y - w.y) ** 2 + (v.z - w.z) ** 2 < (w.r * 1.03) ** 2;
  };
  for (const m of meshes) {
    if (!m.geometry.index && Object.values(m.geometry.attributes).some((a) => (a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute)) continue;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const pos = g.attributes.position;
    const taken: number[][] = [[], [], [], []], rest: number[] = [];
    for (let t = 0; t < pos.count / 3; t++) {
      v.fromBufferAttribute(pos, t * 3).applyMatrix4(m.matrixWorld);
      const q = quad(v.x, v.z);
      let all = inside(q);
      for (let k = 1; all && k < 3; k++) all = (v.fromBufferAttribute(pos, t * 3 + k).applyMatrix4(m.matrixWorld), inside(q));
      (all ? taken[q] : rest).push(t);
    }
    if (rest.length === pos.count / 3) continue;
    const some = (tris: number[]) => {
      const part = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(g.attributes)) {
        const n = a.itemSize * 3, src = a.array, arr = new (src.constructor as new (n: number) => typeof src)(tris.length * n);
        tris.forEach((t, k) => arr.set(src.subarray(t * n, t * n + n), k * n));
        part.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
      }
      return part;
    };
    m.geometry = some(rest);
    for (const q of places) {
      if (!taken[q].length) continue;
      const piece = new THREE.Mesh(some(taken[q]), m.material);
      piece.name = 'wheel';
      piece.position.copy(m.position);
      piece.quaternion.copy(m.quaternion);
      piece.scale.copy(m.scale);
      m.parent!.add(piece);
      piece.updateWorldMatrix(true, false);
      out[q]!.parts.push(piece);
    }
  }
  return places.every((q) => out[q]!.parts.length) ? out : undefined;
}

/**
 * Loads any glTF as a vehicle. Nothing is assumed of the file but that it is one vehicle: it is stood upright,
 * turned to face +z, scaled to its real length, and its wheels are found by name so they can roll and steer.
 * Where a model carries fewer wheels than it stands on (GTA V's carry one), the ones it has are copied round.
 */
export async function loadImported(base: CarSpec): Promise<CarModel> {
  const { file, flip, bike } = base.imported!;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${import.meta.env.BASE_URL}models/${base.id}/${file}`);
  tuneMaterials(gltf.scene);
  const top = new THREE.Group();
  top.add(gltf.scene);
  const box = new THREE.Box3(), size = new THREE.Vector3(), centre = new THREE.Vector3();
  const measure = () => {
    top.updateWorldMatrix(true, true);
    box.setFromObject(top).getSize(size);
  };
  measure();
  if (size.y > size.x && size.y > size.z) top.rotation.x = -Math.PI / 2; // drawn with z up
  measure();
  if (size.x > size.z) top.rotation.y = Math.PI / 2; // drawn along x
  if (flip) top.rotation.y += Math.PI;
  measure();
  top.scale.multiplyScalar(base.length / size.z);
  measure();
  box.getCenter(centre);
  top.position.set(-centre.x, -box.min.y, -centre.z);
  measure();
  const width = size.x, height = size.y;

  // Wheels: the highest things in the tree named as one, split up while they still span more than one wheel.
  const hasMesh = (o: THREE.Object3D) => {
    let found = false;
    o.traverse((c) => (found ||= (c as THREE.Mesh).isMesh));
    return found;
  };
  const b = new THREE.Box3();
  const quads: (Found | undefined)[] = [undefined, undefined, undefined, undefined];
  const take = (o: THREE.Object3D) => {
    b.setFromObject(o);
    const c = b.getCenter(new THREE.Vector3());
    const spans = b.max.z - b.min.z > base.length * 0.45 || (!bike && b.min.x < -width * 0.1 && b.max.x > width * 0.1);
    if (spans) return o.children.filter(hasMesh).forEach(take);
    // not the steering wheel, nor a spare on the tailgate or the bonnet
    if (/steer/i.test(o.name) || c.y > height * 0.5 || (!bike && Math.abs(c.x) < width * 0.22)) return;
    // and it is round, seen from the side: a calliper or a mudguard that says "wheel" in its name stays on the body
    const tall = b.max.y - b.min.y;
    if (Math.abs(tall - (b.max.z - b.min.z)) > tall * 0.3) return;
    const q = (c.z > 0 ? 0 : 2) + (bike || c.x > 0 ? 0 : 1);
    const f = (quads[q] ??= { parts: [], box: new THREE.Box3() });
    f.parts.push(o);
    f.box.union(b);
  };
  const seek = (o: THREE.Object3D) => (WHEEL.test(o.name) && hasMesh(o) ? take(o) : o.children.forEach(seek));
  seek(top);
  const places = bike ? [0, 2] : [0, 1, 2, 3];
  // Most models name nothing ("Object_12"), or are one mesh: then the wheels are cut out by where they stand.
  if (!places.every((q) => quads[q])) wheelsByShape(top, !!bike, base.length)?.forEach((f, q) => (quads[q] = f));

  // A wheel the file does not have is a copy of one it does: its partner across the car turned about, or the one on the other axle.
  const extra = new THREE.Group();
  if (places.some((q) => quads[q])) for (const q of places) {
    if (quads[q]) continue;
    const from = [q ^ 1, q ^ 2, q ^ 3].find((s) => quads[s]?.parts.length && places.includes(s));
    if (from === undefined) continue;
    const src = quads[from]!, sc = src.box.getCenter(new THREE.Vector3());
    const across = (from ^ q) & 1, along = (from ^ q) & 2;
    const stand = new THREE.Group(), inner = new THREE.Group();
    stand.add(inner);
    extra.add(stand);
    extra.updateWorldMatrix(true, true);
    for (const part of src.parts) {
      const copy = part.clone();
      part.parent!.add(copy);
      copy.updateWorldMatrix(true, true);
      inner.attach(copy); // keeps its place in the world, which is the source's
    }
    // then the copies are carried, about the source wheel's centre, to where the missing one belongs
    inner.position.copy(sc).negate();
    stand.position.set(across ? -sc.x : sc.x, sc.y, along ? -sc.z : sc.z);
    if (across) stand.rotation.y = Math.PI; // keeps the wheel's face outward
    extra.updateWorldMatrix(true, true);
    quads[q] = { parts: [stand], box: new THREE.Box3().setFromCenterAndSize(stand.position, src.box.getSize(new THREE.Vector3())) };
  }

  const found = places.map((q) => quads[q]).filter((f): f is Found => !!f);
  const whole = found.length === places.length;
  console.debug(`${base.name}: ${whole ? `${found.length} wheels, radius ${found.map((f) => ((f.box.max.y - f.box.min.y) / 2).toFixed(3)).join(' ')} m, hubs ${found.map((f) => ((f.box.max.y + f.box.min.y) / 2).toFixed(3)).join(' ')} m up` : 'no wheels found, so they will not turn'}`);
  const at = found.map((f) => ({ c: f.box.getCenter(new THREE.Vector3()), r: (f.box.max.y - f.box.min.y) / 2 }));
  const avg = (list: number[]) => list.reduce((a, v) => a + v, 0) / list.length;
  const spec: CarSpec = { ...base, width, height, centreOfMass: Math.min(base.centreOfMass, height * 0.45) };
  if (whole) {
    spec.wheelRadius = avg(at.map((w) => w.r));
    spec.axleFront = bike ? at[0].c.z : (at[0].c.z + at[1].c.z) / 2;
    spec.axleRear = bike ? at[1].c.z : (at[2].c.z + at[3].c.z) / 2;
    if (!bike) spec.track = (at[0].c.x - at[1].c.x + at[2].c.x - at[3].c.x) / 4;
  } else {
    // no wheels to be found by name: they stay part of the body and do not turn, and the car stands where a car of its size would
    Object.assign(spec, { wheelRadius: base.length * 0.078, axleFront: base.length * 0.3, axleRear: -base.length * 0.3 });
    if (!bike) spec.track = width * 0.42;
  }
  // the eyes go where this body's seats are, not the car's whose handling it borrows
  spec.hoodCamera = bike ? [0, height * 1.05, spec.axleFront * 0.4] : [0, height * 0.82, spec.axleFront * 0.5];
  spec.cockpitCamera = bike ? [0, height * 1.12, -base.length * 0.08] : [-width * 0.2, height * 0.8, -base.length * 0.02];

  const group = new THREE.Group();
  group.name = `car-${base.id}`;
  const body = new THREE.Group();
  body.position.y = -rideHeight(spec);
  group.add(body);
  // A bike's wheels hang from the leaning frame, whose origin is on the road; a car's from the chassis.
  const raise = bike ? rideHeight(spec) : 0;
  const wheels: CarWheel[] = !whole ? [] : found.map((f, i) => {
    const pivot = new THREE.Group(), spin = new THREE.Group(), holder = new THREE.Group();
    const lift = at[i].r - spec.wheelRadius + raise;
    pivot.position.set(bike ? 0 : i % 2 === 0 ? spec.track : -spec.track, axleHeight(spec) - restLength(spec) + lift, (bike ? i === 0 : i < 2) ? spec.axleFront : spec.axleRear);
    pivot.add(spin);
    (bike ? body : group).add(pivot);
    holder.position.copy(at[i].c);
    for (const part of f.parts) mergeInto(part, holder);
    spin.add(...holder.children);
    return { pivot, spin, lift, follows: bike ? i * 2 : undefined };
  });
  const flat = new THREE.Group();
  mergeInto(top, flat);
  body.add(flat);
  return { spec, group, wheels, lean: bike ? body : undefined, setBraking() {}, setLights: lensLights(group) };
}

/**
 * The importer: a dialog in the pause menu, in the development build only. It hands the chosen files to the dev
 * server (vite.config.ts), which writes them into public/models/ and garage.json: the vehicle is then part of
 * the game's files, and ships with the next build. The built game has neither this dialog nor that door.
 */
export function setupImporter(current: () => CarSpec) {
  if (!import.meta.env.DEV) return;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const send = async (method: 'PUT' | 'DELETE', entry: Partial<GarageEntry>, body?: Uint8Array<ArrayBuffer>) => {
    const res = await fetch(`/__garage?entry=${encodeURIComponent(JSON.stringify(entry))}`, { method, body, headers: { 'X-Garage': '1' } });
    const said = await res.json();
    if (!res.ok) throw new Error(said.error);
    // into the newcomer where it stands; a removed one leaves the first car
    const to = new URL(location.href);
    if (method === 'PUT') to.searchParams.set('car', said.id);
    else to.searchParams.delete('car');
    location.href = to.href;
  };

  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'background:#14171b;color:#e9edf1;border:1px solid #333a42;border-radius:14px;padding:22px;width:min(440px,92vw);font:13px/1.5 system-ui,sans-serif';
  const field = 'display:block;width:100%;box-sizing:border-box;margin:4px 0 12px;padding:7px 9px;border-radius:8px;border:1px solid #333a42;background:#0d0f12;color:inherit;font:inherit';
  dialog.innerHTML = `
    <form method="dialog">
      <h3 style="margin:0 0 4px;font-size:16px">Import a vehicle</h3>
      <p style="margin:0 0 14px;color:#9aa4ae">A .glb, a .zip holding a .gltf (as Sketchfab gives), or the folder a .gltf sits in. It is copied into public/models and stays in the game.</p>
      <label>Model file (.glb or .zip)<input name="file" type="file" accept=".glb,.zip" style="${field}"></label>
      <label>…or a folder with a .gltf<input name="folder" type="file" webkitdirectory style="${field}"></label>
      <label>Name<input name="name" type="text" required placeholder="Mahindra Thar" list="garage-names" autocomplete="off" style="${field}"></label>
      <datalist id="garage-names">${CARS.filter((c) => !c.model).map((c) => `<option value="${c.name}">`).join('')}</datalist>
      <label>Drives like<select name="kind" style="${field}"><option value="car">a family car (Creta)</option><option value="suv">a 4x4 (Thar)</option><option value="sports">a supercar (Sián)</option><option value="bike">a motorbike</option></select></label>
      <label>Real length, metres<input name="length" type="text" inputmode="decimal" value="4.3" style="${field}"></label>
      <label style="display:block;margin-bottom:12px"><input name="flip" type="checkbox"> The model faces backwards</label>
      <label>Credit (author, licence)<input name="credit" type="text" autocomplete="off" style="${field}"></label>
      <p data-status role="status" style="min-height:1.5em;margin:0 0 10px;color:#ffb4a8"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" data-cancel class="btn">Cancel</button><button type="submit" class="btn primary">Import</button></div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  const status = dialog.querySelector<HTMLElement>('[data-status]')!;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  input('kind').addEventListener('change', () => (input('length').value = String(KINDS[input('kind').value as GarageEntry['kind']].length)));
  dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
  // keys typed here are not for the car
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const name = input('name').value.trim(), length = Number(input('length').value);
      if (!(length > 0.5 && length < 30)) throw new Error('The length should be in metres: about 4.3 for a car, 2.1 for a bike.');
      const one = input('file').files?.[0], many = [...(input('folder').files ?? [])];
      if (!one && !many.length) throw new Error('Choose a model file or a folder first.');
      status.style.color = '#9aa4ae';
      status.textContent = 'Copying it into the game…';
      const bytes = async (f: File) => new Uint8Array(await f.arrayBuffer());
      const packed: Record<string, [Uint8Array, { level: 0 }]> = {};
      if (one && !/\.zip$/i.test(one.name)) packed['model.glb'] = [await bytes(one), { level: 0 }];
      else for (const f of one ? [] : many) packed[f.webkitRelativePath || f.name] = [await bytes(f), { level: 0 }];
      const body = one && /\.zip$/i.test(one.name) ? await bytes(one) : (zipSync(packed) as Uint8Array<ArrayBuffer>);
      // a name that is a built-in car's gives that car its body and keeps its handling
      const mine = CARS.find((c) => !c.model && (slug(c.name) === slug(name) || c.id === slug(name)));
      await send('PUT', { id: mine?.id ?? slug(name), name, kind: input('kind').value as GarageEntry['kind'], length, flip: input('flip').checked, credit: input('credit').value.trim() || undefined, file: '' }, body);
    } catch (err) {
      status.style.color = '#ffb4a8';
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `<div class="row"><div><div class="label">Garage</div><div class="hint">Development build only: add a car or bike from a 3D model file</div></div>
    <div style="display:flex;gap:6px"><button class="btn" data-turn>Turn it round</button><button class="btn danger" data-remove>Remove</button><button class="btn primary" data-import>Import…</button></div></div>`;
  document.getElementById('car-switch')!.closest('.card')!.after(card);
  const mine = () => garage.find((e) => e.id === current().id);
  const oops = (err: unknown) => alert(err instanceof Error ? err.message : String(err));
  card.querySelector('[data-import]')!.addEventListener('click', () => dialog.showModal());
  // both act on the car being driven, when it is an imported one
  card.querySelector('[data-turn]')!.addEventListener('click', () => {
    const e = mine();
    if (e) send('PUT', { ...e, flip: !e.flip }).catch(oops);
    else oops('Switch to an imported vehicle first: this turns the one you are in to face the other way.');
  });
  card.querySelector('[data-remove]')!.addEventListener('click', () => {
    const e = mine();
    if (!e) oops('Switch to an imported vehicle first: this removes the one you are in.');
    else if (confirm(`Remove the ${e.name} and delete public/models/${e.id}?`)) send('DELETE', { id: e.id }).catch(oops);
  });
}
