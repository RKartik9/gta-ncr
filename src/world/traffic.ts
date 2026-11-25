import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { attribute, materialEmissive, select, sin, step, time, vec3 } from 'three/tsl';
import type { Road } from './tile.ts';
import { ROAD_HEIGHT } from './ground.ts';
import { TRAFFIC_GROUPS, WRECK_GROUPS } from './physics.ts';
import { signalMeshes } from './props.ts';
import { Instances, instanced } from '../render/instances.ts';
import { TRAFFIC_KINDS, TRAFFIC_MIX, type TrafficKind } from '../vehicle/trafficModels.ts';

/** One direction of one stretch of road between two map points. */
interface Edge {
  a: number;
  b: number;
  len: number;
  /** unit direction */
  fx: number;
  fz: number;
  /** lane centres for this direction, metres to the left of the road's centre line (India keeps left) */
  lanes: number[];
  /** m/s */
  speed: number;
  /** the signal controller at `b` this edge is stopped by, or -1; and which of its two phases it moves on */
  ctrl: number;
  group: number;
}

interface Car {
  on: boolean;
  edge: number;
  next: number;
  /** metres along the edge */
  s: number;
  lane: number;
  speed: number;
  /** share of the road's speed this driver likes */
  cruise: number;
  /** the driver: 0 patient and careful, 1 impatient. Shapes their headway, how hard they pull away, amber lights and the horn. */
  aggression: number;
  /** seconds of gap they keep to the car in front, and the acceleration they like, m/s² */
  headway: number;
  accel: number;
  /** seconds before they move off once the way ahead clears: nobody pulls away the instant the light changes */
  react: number;
  /** seconds until they next think about changing lane, and until they may sound the horn again */
  laneTimer: number;
  honk: number;
  /** seconds held up by the player */
  wait: number;
  /** seconds left of hurrying, after the player has hooted at them */
  hurry: number;
  /** brake lights on; the indicator going (1 left, 2 right, 3 both: hazards) */
  brake: boolean;
  signal: number;
  /** this car's horn: its pitch, and how many times it has sounded at the player this hold-up */
  hornPitch: number;
  honks: number;
  x: number;
  z: number;
  /** sideways offset from the centre line, eased so a turn does not jump lanes */
  ox: number;
  oz: number;
  yaw: number;
  /** how far the wheels have turned, radians */
  spin: number;
  /** seconds stopped for anything but a red light; past STUCK the car stops waiting for other cars (a gridlock would last for ever) */
  stuck: number;
  /** waiting at a red light, or behind a car that is */
  red: boolean;
  /** the junction this car has the right of way through, or -1 */
  claim: number;
  /** knocked off its line by a crash: no longer driven, just a body the physics throws about */
  wrecked: boolean;
  wreckTime: number;
  /** its driver has got out to have it out with the player */
  empty: boolean;
  /** the velocity it was last told to drive at: anything else after a step is something having hit it */
  vx: number;
  vz: number;
  /** the turn it was last told to make, rad/s */
  spinY: number;
  kind: TrafficKind;
  /** which copy of its kind's meshes it is drawn as */
  slot: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/** A set of signals working one junction: two phases, along `axis` and across it. */
interface Controller {
  x: number;
  z: number;
  ax: number;
  az: number;
  /** seconds into the cycle at the start, so junctions do not all change together */
  offset: number;
}

/** length the player's car is taken to be, for keeping a distance behind it */
const PLAYER_LENGTH = 4.5;
const BUCKET = 100;
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
/** signal cycle, seconds: each phase is green, then amber, then everything red for a moment */
const GREEN = 14, AMBER = 3, CYCLE = 2 * (GREEN + AMBER + 1);
const RED = 0, AMBER_ON = 1, GREEN_ON = 2;
/** per-copy tint of a signal mesh: which lamp is lit */
const LAMPS = [new THREE.Color(1, 0, 0), new THREE.Color(0, 1, 0), new THREE.Color(0, 0, 1)];
const STUCK = 6;
/** Intelligent Driver Model: the gap kept when stopped (m), the braking a driver is comfortable with and the most they will brake (m/s²). */
const S0 = 2.2, COMFORT = 2.6, EMERGENCY = 9;
/** headings closer than this (as |cos|) can share a junction: the same road, either way */
const ALONG = 0.7;

function roadSpeed(r: Road) {
  if (r.kind.startsWith('trunk') || r.kind.startsWith('primary')) return 15;
  if (r.kind.startsWith('secondary') || r.kind.startsWith('tertiary')) return 12;
  return 8;
}

const key = (x: number, z: number) => `${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`;

/**
 * Cars that drive themselves round the streets near the player. They keep to the left lane, obey one-way
 * streets, stop at red lights, take turns through junctions (one road's traffic at a time), slow behind
 * whatever is ahead of them (the player included) and ease off for corners. Each driver is someone: patient or
 * impatient, which sets the gap they keep, how hard they pull away, whether they run an amber and how soon they
 * sound the horn at a player in their way. Held up, they change lane; the player's horn moves them over. Out of sight they are taken away
 * and set down again somewhere else within the draw distance. Hit by the player, even lightly, they are knocked off their line and left to the physics.
 * The signals they obey are the map's own, and the lamps on every signal pole show the phase.
 */
export class Traffic {
  private xs: number[] = [];
  private zs: number[] = [];
  /** half the widest road at each node, plus a margin: where the junction box starts */
  private radius: number[] = [];
  /** how many other nodes each node is joined to: 3 or more is a junction */
  private degree: number[] = [];
  private edges: Edge[] = [];
  /** edges leaving each node */
  private out: number[][] = [];
  /** nodes with somewhere to go, by 100 m bucket */
  private buckets = new Map<string, number[]>();
  private ctrls: Controller[] = [];
  /** cars holding the right of way through each junction */
  private claims = new Map<number, Set<Car>>();
  /** people on the pavement and stepping off it: a car stops for one in its lane */
  walkers: { x: number; z: number }[] = [];
  /** every vehicle driving, and the velocity it drives at: for people to judge a gap to cross in */
  readonly positions: { x: number; z: number; vx: number; vz: number }[] = [];
  /** a driver sounds the horn at (x, z): a quick tap, two taps, or leaning on it; `pitch` is that car's horn */
  onHonk?: (x: number, z: number, kind: 'tap' | 'double' | 'long', pitch: number) => void;
  /**
   * A vehicle has been knocked off its line, or hit by someone on foot. `near`: the player had a hand in it. `leave` is for whoever wants its driver out
   * on the street: true if there is still a driver in it to get out, and from then on there is not.
   */
  onWreck?: (car: { body: RAPIER.RigidBody; aggression: number; width: number; near: boolean; leave: () => boolean }) => void;
  private time = 0;
  private lampTimer = 0;
  private cars: Car[] = [];
  private shells: Instances[] = [];
  private wheels: Instances[] = [];
  private meshOf = new Map<TrafficKind, { shell: Instances; wheels: Instances }>();
  private lamps: { head: THREE.MeshStandardNodeMaterial; tail: THREE.MeshStandardNodeMaterial }[] = [];
  private near: number;
  private far: number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qs = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private w = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private side = new THREE.Vector3(1, 0, 0);

  constructor(scene: THREE.Scene, world: RAPIER.World, count: number, drawDistance: number) {
    this.far = Math.min(drawDistance, 320);
    this.near = Math.min(140, this.far * 0.5);
    // the mix of vehicles: which kind each one is, and how many copies of each kind are drawn
    const kinds = Array.from({ length: count }, (_, i) => TRAFFIC_KINDS[TRAFFIC_MIX[i % TRAFFIC_MIX.length]]);
    const per = new Map<TrafficKind, number>();
    for (const k of kinds) per.set(k, (per.get(k) ?? 0) + 1);
    const shells = new Map<TrafficKind, Instances>();
    for (const [kind, n] of per) {
      // the materials remade for drawing many copies; the paint takes each copy's colour
      const shape = kind.shape();
      const mats = shape.materials.map((m, k) => nodeMaterial(m, k === shape.paint, k === shape.head ? 'head' : k === shape.tail ? 'tail' : undefined));
      const shell = new Instances(shape.shell, mats, Array(n).fill(HIDDEN), true);
      const wheels = new Instances(shape.wheel, shape.wheelMaterials.map((m) => nodeMaterial(m)), Array(n * kind.wheels.length).fill(HIDDEN), true);
      this.lamps.push({ head: mats[shape.head], tail: mats[shape.tail] });
      shell.castShadow = shell.receiveShadow = wheels.castShadow = true;
      // the copies move anywhere; the bounds worked out at the start mean nothing
      shell.frustumCulled = wheels.frustumCulled = false;
      shells.set(kind, shell);
      this.shells.push(shell);
      this.wheels.push(wheels);
      this.meshOf.set(kind, { shell, wheels });
      scene.add(shell, wheels);
    }
    const used = new Map<TrafficKind, number>();
    kinds.forEach((kind) => {
      const slot = used.get(kind) ?? 0;
      used.set(kind, slot + 1);
      // A real body of the vehicle's own weight. While it drives, its speed is set each step to keep it on its line;
      // hit hard enough to knock it off, it is left to the physics. The box stands on the road (origin at its foot).
      const { width: w, height: h, length: l, mass } = kind;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -50, 0).setCanSleep(false).setAngularDamping(0.4).setLinearDamping(0.05));
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(w / 2, h / 2, l / 2).setTranslation(0, h / 2, 0).setMassProperties(
          mass,
          // the weight sits as low as the real vehicle's, not in the middle of the box: they roll only when hit hard
          { x: 0, y: kind.centreOfMass - h / 2, z: 0 },
          { x: (mass / 12) * (h ** 2 + l ** 2), y: (mass / 12) * (w ** 2 + l ** 2), z: (mass / 12) * (w ** 2 + h ** 2) },
          { x: 0, y: 0, z: 0, w: 1 },
        ).setFriction(0).setRestitution(0.15).setCollisionGroups(TRAFFIC_GROUPS),
        body,
      );
      body.setEnabled(false);
      shells.get(kind)!.setColorAt(slot, new THREE.Color(kind.colours[Math.floor(Math.random() * kind.colours.length)]));
      this.cars.push({ on: false, edge: 0, next: -1, s: 0, lane: 0, speed: 0, cruise: 1, aggression: 0, headway: 1.4, accel: 1.8, react: 0, laneTimer: 0, honk: 0, wait: 0, hurry: 0, brake: false, signal: 0, hornPitch: 1, honks: 0, spinY: 0, x: 0, z: 0, ox: 0, oz: 0, yaw: 0, spin: 0, stuck: 0, red: false, claim: -1, wrecked: false, wreckTime: 0, empty: false, vx: 0, vz: 0, kind, slot, body, collider });
    });
  }

  /** The streets to drive and the signals on them, from the whole map's overview; cars appear round (x, z) straight away. */
  setRoads(roads: Road[], signals: number[], x: number, z: number) {
    const ids = new Map<string, number>();
    const links: Set<number>[] = [];
    const node = (px: number, pz: number) => {
      const k = `${px},${pz}`;
      let id = ids.get(k);
      if (id === undefined) {
        id = this.xs.push(px) - 1;
        this.zs.push(pz);
        this.out.push([]);
        this.radius.push(0);
        links.push(new Set());
        ids.set(k, id);
      }
      return id;
    };
    const add = (a: number, b: number, r: Road, twoWay: boolean) => {
      const dx = this.xs[b] - this.xs[a], dz = this.zs[b] - this.zs[a], len = Math.hypot(dx, dz);
      const n = twoWay ? Math.max(1, Math.floor(r.lanes / 2)) : Math.max(1, Math.round(r.lanes));
      const w = twoWay ? r.width / 2 : r.width, from = twoWay ? 0 : -r.width / 2;
      const lanes = Array.from({ length: n }, (_, i) => from + (w / n) * (i + 0.5));
      this.out[a].push(this.edges.push({ a, b, len, fx: dx / len, fz: dz / len, lanes, speed: roadSpeed(r), ctrl: -1, group: 0 }) - 1);
    };
    for (const r of roads) {
      for (let i = 0; i + 3 < r.pts.length; i += 2) {
        const a = node(r.pts[i], r.pts[i + 1]), b = node(r.pts[i + 2], r.pts[i + 3]);
        if (a === b) continue;
        add(a, b, r, !r.oneway);
        if (!r.oneway) add(b, a, r, true);
        links[a].add(b);
        links[b].add(a);
        for (const n of [a, b]) this.radius[n] = Math.max(this.radius[n], r.width / 2 + 1.5);
      }
    }
    this.degree = links.map((l) => l.size);
    const junctions = new Map<string, number[]>();
    this.out.forEach((list, n) => {
      const k = key(this.xs[n], this.zs[n]);
      if (list.length) (this.buckets.get(k) ?? this.buckets.set(k, []).get(k)!).push(n);
      if (this.degree[n] >= 3) (junctions.get(k) ?? junctions.set(k, []).get(k)!).push(n);
    });

    // Signals: each works the nearest junction; junctions close together (a dual carriageway's crossing is
    // several) share one controller, so their lights change together.
    const ctrlOf = new Map<number, number>();
    for (let i = 0; i < signals.length; i += 2) {
      const n = this.nearestIn(junctions, signals[i], signals[i + 1], 30);
      if (n < 0 || ctrlOf.has(n)) continue;
      let c = this.ctrls.findIndex((k) => Math.hypot(k.x - this.xs[n], k.z - this.zs[n]) < 40);
      if (c < 0) {
        // the phases run along and across the fastest road into the junction
        const main = this.edges.filter((e) => e.b === n).sort((p, q) => q.speed - p.speed || q.lanes.length - p.lanes.length)[0];
        if (!main) continue;
        c = this.ctrls.push({ x: this.xs[n], z: this.zs[n], ax: main.fx, az: main.fz, offset: Math.random() * CYCLE }) - 1;
      }
      ctrlOf.set(n, c);
    }
    for (const e of this.edges) {
      const c = ctrlOf.get(e.b);
      // stopped on the way in, not between two nodes of the same junction
      if (c === undefined || ctrlOf.get(e.a) === c) continue;
      e.ctrl = c;
      e.group = Math.abs(e.fx * this.ctrls[c].ax + e.fz * this.ctrls[c].az) > Math.SQRT1_2 ? 0 : 1;
    }
    for (let tries = 0; tries < this.cars.length * 20; tries++) this.spawn(x, z, 25);
  }

  private nearestIn(buckets: Map<string, number[]>, x: number, z: number, within: number) {
    let best = -1, bestD = within;
    for (let bx = -1; bx <= 1; bx++) for (let bz = -1; bz <= 1; bz++) {
      for (const n of buckets.get(key(x + bx * BUCKET, z + bz * BUCKET)) ?? []) {
        const d = Math.hypot(this.xs[n] - x, this.zs[n] - z);
        if (d < bestD) [best, bestD] = [n, d];
      }
    }
    return best;
  }

  /** What a controller shows one of its phases right now. */
  private light(c: number, group: number) {
    const t = (((this.time + this.ctrls[c].offset - group * (CYCLE / 2)) % CYCLE) + CYCLE) % CYCLE;
    return t < GREEN ? GREEN_ON : t < GREEN + AMBER ? AMBER_ON : RED;
  }

  /** Which way to go at the end of `e`: anywhere but back, and more likely straight on; a bus keeps to main roads. */
  private pickNext(e: number, kind?: TrafficKind) {
    const { a, b, fx, fz } = this.edges[e];
    const ahead = this.out[b].filter((n) => this.edges[n].b !== a);
    const list = ahead.length ? ahead : this.out[b];
    if (!list.length) return -1;
    const w = list.map((n) => (0.15 + Math.max(0, this.edges[n].fx * fx + this.edges[n].fz * fz)) * (kind?.majorOnly && this.edges[n].speed < 12 ? 0.03 : 1));
    let r = Math.random() * w.reduce((s, v) => s + v, 0);
    for (let i = 0; i < list.length; i++) if ((r -= w[i]) <= 0) return list[i];
    return list[list.length - 1];
  }

  /** Sets one parked car down on a road between `near` and `far` metres from (px, pz), if a clear spot turns up. */
  private spawn(px: number, pz: number, near = this.near) {
    const free = this.cars.filter((c) => !c.on);
    if (!free.length) return;
    const car = free[Math.floor(Math.random() * free.length)];
    const angle = Math.random() * Math.PI * 2, r = near + Math.random() * (this.far - near);
    const nodes = this.buckets.get(key(px + Math.sin(angle) * r, pz + Math.cos(angle) * r));
    if (!nodes) return;
    const n = nodes[Math.floor(Math.random() * nodes.length)];
    const x = this.xs[n], z = this.zs[n];
    const d = Math.hypot(x - px, z - pz);
    if (d < near || d > this.far || this.degree[n] >= 3) return;
    if (this.cars.some((c) => c.on && Math.hypot(c.x - x, c.z - z) < 15)) return;
    const list = this.out[n];
    const edge = list[Math.floor(Math.random() * list.length)];
    if (car.kind.majorOnly && this.edges[edge].speed < 12) return;
    car.edge = edge;
    const e = this.edges[car.edge];
    car.next = this.pickNext(car.edge, car.kind);
    car.s = 0;
    car.lane = Math.floor(Math.random() * e.lanes.length);
    // a new driver: the impatient ones want to go faster, sit closer and pull away harder
    car.aggression = Math.random() ** 1.5;
    car.cruise = 0.78 + car.aggression * 0.3 + (Math.random() - 0.5) * 0.12;
    car.headway = 1.9 - car.aggression * 1.0;
    car.accel = (1.3 + car.aggression * 1.4) * (car.kind.majorOnly || car.kind.topSpeed < 12 ? 0.7 : 1);
    car.react = car.laneTimer = car.honk = car.wait = car.hurry = car.signal = car.honks = 0;
    car.brake = false;
    // a bus or a truck has a deeper horn than a car, an auto a higher one
    car.hornPitch = (car.kind.majorOnly ? 0.85 : car.kind.topSpeed < 12 ? 1.12 : 1) * (0.96 + Math.random() * 0.08);
    car.speed = e.speed * car.cruise * 0.6;
    car.ox = e.fz * e.lanes[car.lane];
    car.oz = -e.fx * e.lanes[car.lane];
    car.x = x + car.ox;
    car.z = z + car.oz;
    car.yaw = Math.atan2(e.fx, e.fz);
    car.stuck = 0;
    car.red = false;
    car.claim = -1;
    car.wrecked = false;
    car.wreckTime = 0;
    car.empty = false;
    car.on = true;
    car.collider.setFriction(0);
    car.collider.setCollisionGroups(TRAFFIC_GROUPS);
    car.body.setEnabled(true);
    car.body.setTranslation({ x: car.x, y: 0.02, z: car.z }, true);
    car.body.setRotation(this.q.setFromAxisAngle(this.up, car.yaw), true);
    car.vx = e.fx * car.speed;
    car.vz = e.fz * car.speed;
    car.body.setLinvel({ x: car.vx, y: 0, z: car.vz }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car.spinY = 0;
  }

  private remove(car: Car) {
    car.on = false;
    this.release(car);
    car.body.setEnabled(false);
  }

  /** Knocked off its line: hazards on, and from here on only a body. Its driver may have something to say about it. */
  private wreck(car: Car, near: boolean) {
    car.wrecked = true;
    car.signal = 3; // hazards on
    car.brake = false;
    car.collider.setFriction(0.8);
    car.collider.setCollisionGroups(WRECK_GROUPS);
    this.release(car);
    this.onWreck?.({
      body: car.body, aggression: car.aggression, width: car.kind.width, near,
      leave: () => car.on && car.wrecked && !car.empty && (car.empty = true),
    });
  }

  /**
   * Someone on foot has hit the vehicle whose body this is. A patient driver leans on the horn and drives on;
   * an impatient one stops where they are. False if it is not one of the traffic's.
   */
  provoke(body: RAPIER.RigidBody) {
    const car = this.cars.find((c) => c.on && c.body.handle === body.handle);
    if (!car) return false;
    if (car.wrecked) {
      if (!car.empty) this.onWreck?.({ body: car.body, aggression: car.aggression, width: car.kind.width, near: true, leave: () => car.on && !car.empty && (car.empty = true) });
    } else if (car.aggression > 0.3) this.wreck(car, true);
    else {
      this.onHonk?.(car.x, car.z, 'long', car.hornPitch);
      car.hurry = 4;
    }
    return true;
  }

  private release(car: Car) {
    if (car.claim >= 0) this.claims.get(car.claim)?.delete(car);
    car.claim = -1;
  }

  /** One physics step. (px, pz) is the player and (pvx, pvz) their velocity: every car keeps clear of them. */
  step(dt: number, px: number, pz: number, pvx = 0, pvz = 0) {
    if (!this.edges.length) return;
    this.time += dt;
    const ease = 1 - Math.exp(-5 * dt), turn = 1 - Math.exp(-8 * dt);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (!car.on) continue;
      const t = car.body.translation(), r = car.body.rotation();
      const toPlayer = Math.hypot(t.x - px, t.z - pz);
      // Knocked off the speed it was set (by 2.5 m/s in one step) or tipped: a crash. From here it is only a
      // body; it goes once nobody is looking.
      const lv = car.body.linvel();
      // Next to the player it takes far less: a nudge or a swipe from them is a crash, not a wall it shrugs off.
      const touching = toPlayer < car.kind.length / 2 + PLAYER_LENGTH / 2 + 1;
      const knocked = Math.hypot(lv.x - car.vx, lv.z - car.vz), spun = Math.abs(car.body.angvel().y - car.spinY);
      if (!car.wrecked && (knocked > (touching ? 0.8 : 2.5) || (touching && spun > 0.4) || 1 - 2 * (r.x * r.x + r.z * r.z) < 0.9)) {
        this.wreck(car, touching);
      }
      if (car.wrecked) {
        car.x = t.x;
        car.z = t.z;
        car.speed = 0;
        car.wreckTime += dt;
        if (toPlayer > this.far + 80 || (car.wreckTime > 40 && toPlayer > 60)) this.remove(car);
        continue;
      }
      // held up for long, out of the player's way: take it off rather than leave a knot of cars for ever
      if (car.stuck > STUCK && toPlayer > 60) {
        this.remove(car);
        continue;
      }
      let e = this.edges[car.edge];
      const half = car.kind.length / 2;
      const n = this.edges[car.next];
      car.hurry -= dt;
      let v0 = Math.min(e.speed * car.cruise * (car.hurry > 0 ? 1.15 : 1), car.kind.topSpeed);
      // a sharp turn coming up: no faster than a comfortable stop down to turning speed allows
      if (car.next >= 0 && n.fx * e.fx + n.fz * e.fz < 0.6) v0 = Math.min(v0, Math.sqrt(25 + 2 * COMFORT * Math.max(0, e.len - car.s - 4)));
      let acc = idm(car, v0);
      // the player, the nearest vehicle in this lane ahead (bumper to bumper, at its speed), anyone on foot in it
      const toPlayerAhead = toPlayer < 50 ? this.ahead(car, e, px, pz) - half - PLAYER_LENGTH / 2 : Infinity;
      let byPlayer = false;
      if (toPlayerAhead < Infinity) {
        const a = idm(car, v0, toPlayerAhead, Math.max(0, pvx * e.fx + pvz * e.fz));
        if (a < acc) [acc, byPlayer] = [a, true];
      }
      const { blocker, gap } = this.leader(car, e, 0);
      if (blocker) acc = Math.min(acc, idm(car, v0, gap, blocker.wrecked ? 0 : blocker.speed));
      for (const w of this.walkers) {
        const d = this.ahead(car, e, w.x, w.z) - half - 0.3;
        if (d < Infinity) acc = Math.min(acc, idm(car, v0, d, 0));
      }
      let red = blocker !== null && blocker.red && gap < 20;

      // the next junction, on this edge or the one after: its signal, the player in it, then the right of way through it
      const upcoming: [Edge, number][] = car.next >= 0 ? [[e, e.len - car.s], [n, e.len - car.s + n.len]] : [[e, e.len - car.s]];
      for (const [into, d] of upcoming) {
        const j = into.b;
        if (this.degree[j] < 3) continue;
        const line = d - this.radius[j];
        let stop = false;
        if (into.ctrl >= 0) {
          const lit = this.light(into.ctrl, into.group);
          // red: stop unless past stopping. Amber: stop if it can be done comfortably; the impatient need more room to think so.
          const room = (car.speed * car.speed) / (2 * COMFORT);
          if ((lit === RED && line > (car.speed * car.speed) / 14) || (lit === AMBER_ON && line > room * (1 + 2 * car.aggression))) {
            stop = true;
            red = true;
          }
        }
        // nobody drives into a junction the player is sitting in
        if (!stop && car.claim !== j && line > 0 && line < 15 && Math.hypot(px - this.xs[j], pz - this.zs[j]) < this.radius[j] + 1) {
          stop = true;
          byPlayer = true;
        }
        if (!stop && car.claim !== j && line < 8) {
          const holders = this.claims.get(j);
          const clash = holders && [...holders].some((o) => {
            const oe = this.edges[o.edge];
            return Math.abs(oe.fx * into.fx + oe.fz * into.fz) < ALONG;
          });
          if (clash && line > 0) stop = true;
          else {
            this.release(car);
            car.claim = j;
            (this.claims.get(j) ?? this.claims.set(j, new Set()).get(j)!).add(car);
          }
        }
        // the stop line is a car standing still; IDM keeps S0 short of it, so it is put that much past the line
        if (stop) acc = Math.min(acc, idm(car, v0, Math.max(0.1, line - 0.5 + S0 - 1), 0));
        break;
      }
      if (car.next < 0) acc = Math.min(acc, idm(car, v0, Math.max(0.1, e.len - car.s - 2 + S0), 0)); // dead end ahead

      // standing still: a moment to react once the way clears, longer for the patient
      if (car.speed < 0.3) {
        if (acc <= 0.1) car.react = 0.25 + Math.random() * (1.1 - car.aggression * 0.6);
        else if (car.react > 0) {
          car.react -= dt;
          acc = Math.min(acc, 0);
        }
      }
      car.red = red;
      const was = car.speed;
      car.speed = Math.max(0, car.speed + Math.max(-EMERGENCY, Math.min(car.accel, acc)) * dt);
      // brake lights: slowing down harder than the engine and the air would, or held at a standstill
      car.brake = car.speed < 0.3 ? acc <= 0.1 : (car.speed - was) / dt < -0.8;
      // indicators: a turn coming up at the end of this edge, or a change of lane still going on
      const moving = Math.hypot(car.ox - e.fz * e.lanes[car.lane], car.oz + e.fx * e.lanes[car.lane]) > 0.25;
      if (!moving && car.signal !== 0) car.signal = 0;
      if (car.next >= 0 && e.len - car.s < 35 && n.fx * e.fx + n.fz * e.fz < 0.8) car.signal = n.fx * e.fz - n.fz * e.fx > 0 ? 1 : 2;
      car.stuck = car.speed < 0.5 && !red ? car.stuck + dt : car.speed > 3 ? 0 : car.stuck;

      // The horn: held up by the player for longer than this driver's patience (a tap, then two, then leaning on
      // it, and only the impatient keep on), or cut up by them at speed (one long blast).
      car.honk -= dt;
      car.wait = byPlayer && car.speed < 1.5 ? car.wait + dt : Math.max(0, car.wait - 2 * dt);
      if (car.wait === 0) car.honks = 0;
      // leaned on the horn and still held up: the hot-headed get out to move the player themselves
      if (byPlayer && car.wait > 9 && car.aggression > 0.55 && car.speed < 0.5) {
        this.wreck(car, true);
        continue;
      }
      if (car.honk <= 0 && car.wait > 2 + (1 - car.aggression) * 5 && car.honks < 1 + Math.round(car.aggression * 2)) {
        this.onHonk?.(car.x, car.z, car.honks === 0 ? 'tap' : car.honks === 1 ? 'double' : 'long', car.hornPitch);
        car.honks++;
        car.honk = 5 + Math.random() * 5;
      } else if (car.honk <= 0 && byPlayer && toPlayerAhead < 6 && car.speed > 6) {
        this.onHonk?.(car.x, car.z, 'long', car.hornPitch);
        car.honk = 8;
      }

      // Lanes: held up, it looks for a quicker one; running free, it drifts back over to the left (India keeps left).
      car.laneTimer -= dt;
      if (car.laneTimer <= 0 && e.lanes.length > 1 && e.len - car.s > 25) {
        car.laneTimer = 1 + Math.random() * 2;
        const here = Math.min(gap, toPlayerAhead);
        const heldUp = here < 35 && acc < car.accel * 0.3 && car.speed < v0 * 0.85;
        const tries = heldUp ? (Math.random() < 0.5 ? [car.lane - 1, car.lane + 1] : [car.lane + 1, car.lane - 1]) : Math.random() < 0.3 ? [car.lane + 1] : [];
        for (const l of tries) {
          if (l < 0 || l >= e.lanes.length) continue;
          if (this.laneClear(car, e, l, px, pz, heldUp ? here + 8 : 40)) {
            car.signal = l > car.lane ? 1 : 2; // a higher lane is further left
            car.lane = l;
            break;
          }
        }
      }
      car.s += car.speed * dt;
      car.spin += (car.speed * dt) / car.kind.wheelRadius;
      while (car.s >= e.len) {
        if (car.next < 0) {
          this.remove(car);
          break;
        }
        car.s -= e.len;
        car.edge = car.next;
        e = this.edges[car.edge];
        car.next = this.pickNext(car.edge, car.kind);
        car.lane = Math.min(car.lane, e.lanes.length - 1);
      }
      const off = e.lanes[car.lane], pox = car.ox, poz = car.oz;
      car.ox += (e.fz * off - car.ox) * ease;
      car.oz += (-e.fx * off - car.oz) * ease;
      car.x = this.xs[e.a] + e.fx * car.s + car.ox;
      car.z = this.zs[e.a] + e.fz * car.s + car.oz;
      // the nose points the way the car is going, so a change of lane is steered rather than slid
      let lx = (car.ox - pox) / dt, lz = (car.oz - poz) / dt;
      const ll = Math.hypot(lx, lz), most = car.speed * 0.3;
      if (ll > most) [lx, lz] = [(lx * most) / ll, (lz * most) / ll];
      car.yaw += angle((car.speed > 1 ? Math.atan2(e.fx * car.speed + lx, e.fz * car.speed + lz) : Math.atan2(e.fx, e.fz)) - car.yaw) * turn;
      if (!car.on) continue;
      if (toPlayer > this.far + 80) {
        this.remove(car);
        continue;
      }
      // drive the body onto the new spot over this step, at no more than a little over the car's own speed
      let vx = (car.x - t.x) / dt, vz = (car.z - t.z) / dt;
      const v = Math.hypot(vx, vz), cap = car.speed + 5;
      if (v > cap) [vx, vz] = [(vx * cap) / v, (vz * cap) / v];
      const fx = 2 * (r.x * r.z + r.w * r.y), fz = 1 - 2 * (r.x * r.x + r.y * r.y);
      const spinY = Math.max(-3, Math.min(3, angle(car.yaw - Math.atan2(fx, fz)) / dt));
      car.vx = vx;
      car.vz = vz;
      car.spinY = spinY;
      car.body.setLinvel({ x: vx, y: Math.min(0, lv.y), z: vz }, true);
      car.body.setAngvel({ x: 0, y: spinY, z: 0 }, true);
      // through the junction and clear of it: let the next car have it
      const c = car.claim;
      if (c >= 0 && ((e.b !== c && this.edges[car.next]?.b !== c && Math.hypot(car.x - this.xs[c], car.z - this.zs[c]) > this.radius[c] + 2))) this.release(car);
    }
    this.spawn(px, pz);
    this.positions.length = 0;
    for (const car of this.cars) if (car.on && !car.wrecked) this.positions.push({ x: car.x, z: car.z, vx: car.vx, vz: car.vz });
    this.draw();
    this.lampTimer -= dt;
    if (this.lampTimer <= 0) {
      this.lampTimer = 0.25;
      this.lightSignals();
    }
  }

  /** Metres to (x, z) if it is in front of the car and in its lane (or the lane `shift` metres to its left), else Infinity. */
  private ahead(car: Car, e: Edge, x: number, z: number, shift = 0) {
    const along = this.along(car, e, x, z, shift);
    return along > 0 && along < 45 ? along : Infinity;
  }

  /** How far (x, z) is ahead of the car (negative: behind) if it is in the lane `shift` metres to the car's left, else NaN. */
  private along(car: Car, e: Edge, x: number, z: number, shift: number) {
    const rx = x - car.x - e.fz * shift, rz = z - car.z + e.fx * shift;
    return Math.abs(rx * e.fz - rz * e.fx) < 2.4 ? rx * e.fx + rz * e.fz : NaN;
  }

  /** The nearest vehicle ahead in the car's lane, or the lane `shift` metres to its left, and the gap to it bumper to bumper. */
  private leader(car: Car, e: Edge, shift: number) {
    let blocker: Car | null = null, gap = Infinity;
    for (const o of this.cars) {
      if (o === car || !o.on) continue;
      const oe = this.edges[o.edge];
      if (!o.wrecked && oe.fx * e.fx + oe.fz * e.fz < -0.5) continue; // coming the other way, in its own lane
      // its tail, middle and nose: a long bus angling in from a merge has its tail in the lane before its middle is
      const hx = (Math.sin(o.yaw) * o.kind.length) / 2, hz = (Math.cos(o.yaw) * o.kind.length) / 2;
      let d = Infinity;
      for (const k of [-1, 0, 1]) d = Math.min(d, this.ahead(car, e, o.x + hx * k, o.z + hz * k, shift));
      d -= car.kind.length / 2;
      if (d < gap) [gap, blocker] = [d, o];
    }
    return { blocker, gap };
  }

  /** Whether lane `l` has `room` metres free ahead and nobody close behind, the player included. */
  private laneClear(car: Car, e: Edge, l: number, px: number, pz: number, room: number) {
    const shift = e.lanes[l] - e.lanes[car.lane];
    const clear = (x: number, z: number, len: number) => {
      const d = this.along(car, e, x, z, shift);
      if (Number.isNaN(d)) return true;
      const gap = Math.abs(d) - car.kind.length / 2 - len / 2;
      return d > 0 ? gap > room : gap > 5 + car.speed * 0.6;
    };
    if (!clear(px, pz, PLAYER_LENGTH)) return false;
    for (const o of this.cars) {
      if (o === car || !o.on) continue;
      const oe = this.edges[o.edge];
      if (!o.wrecked && oe.fx * e.fx + oe.fz * e.fz < -0.5) continue;
      if (!clear(o.x, o.z, o.kind.length)) return false;
    }
    return true;
  }

  /** The player sounded the horn from (px, pz), facing (fx, fz): the car just in front of them makes way, or hurries. */
  hornFrom(px: number, pz: number, fx: number, fz: number) {
    let best: Car | null = null, bestD = 30;
    for (const car of this.cars) {
      if (!car.on || car.wrecked) continue;
      const rx = car.x - px, rz = car.z - pz, along = rx * fx + rz * fz;
      const e = this.edges[car.edge];
      if (along > 0 && along < bestD && Math.abs(rx * fz - rz * fx) < 2.5 && e.fx * fx + e.fz * fz > 0.5) [best, bestD] = [car, along];
    }
    if (!best) return;
    best.hurry = 4;
    const e = this.edges[best.edge];
    for (const l of [best.lane + 1, best.lane - 1]) {
      if (l < 0 || l >= e.lanes.length) continue;
      // the player is behind and wants by: only the others need room
      if (this.laneClear(best, e, l, Infinity, Infinity, 6)) {
        best.lane = l;
        return;
      }
    }
  }

  /** Each signal pole shows the phase of the traffic that faces it: the way the pole itself faces. */
  private lightSignals() {
    if (!this.ctrls.length) return;
    for (const entry of signalMeshes) {
      if (entry.mesh.disposed) {
        signalMeshes.delete(entry);
        continue;
      }
      entry.phase ??= entry.spots.map(([x, z, facing]) => {
        let best = -1, bestD = 45;
        this.ctrls.forEach((k, c) => {
          const d = Math.hypot(k.x - x, k.z - z);
          if (d < bestD) [best, bestD] = [c, d];
        });
        if (best < 0) return -1;
        const k = this.ctrls[best];
        return best * 2 + (Math.abs(Math.sin(facing) * k.ax + Math.cos(facing) * k.az) > Math.SQRT1_2 ? 0 : 1);
      });
      entry.phase.forEach((p, i) => {
        if (p < 0) return;
        const lit = LAMPS[this.light(p >> 1, p & 1)];
        entry.mesh.setColorAt(i, lit);
        entry.halo.setColorAt(i, lit);
      });
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.halo.instanceMatrix.needsUpdate = true;
    }
  }

  private draw() {
    for (const car of this.cars) {
      const { kind, slot } = car, { shell, wheels } = this.meshOf.get(kind)!, n = kind.wheels.length;
      if (!car.on) {
        shell.setMatrixAt(slot, HIDDEN);
        for (let k = 0; k < n; k++) wheels.setMatrixAt(slot * n + k, HIDDEN);
        continue;
      }
      const t = car.body.translation(), r = car.body.rotation();
      this.q.set(r.x, r.y, r.z, r.w);
      shell.setMatrixAt(slot, this.m.compose(this.p.set(t.x, t.y + ROAD_HEIGHT, t.z), this.q, this.one));
      shell.setExtraAt(slot, car.brake ? 1 : 0, car.signal & 1, (car.signal >> 1) & 1);
      this.qs.setFromAxisAngle(this.side, car.spin).premultiply(this.q);
      kind.wheels.forEach(([wx, wz], k) => {
        this.w.set(wx, kind.wheelRadius, wz).applyQuaternion(this.q);
        wheels.setMatrixAt(slot * n + k, this.m.compose(this.p.set(t.x + this.w.x, t.y + ROAD_HEIGHT + this.w.y, t.z + this.w.z), this.qs, this.one));
      });
    }
    for (const m of [...this.shells, ...this.wheels]) m.instanceMatrix.needsUpdate = true;
  }

  /** Head and tail lamps glow after dark. */
  setLights(on: boolean) {
    for (const { head, tail } of this.lamps) {
      head.emissiveIntensity = on ? 6 : 0.6;
      tail.emissiveIntensity = on ? 2 : 0.5;
    }
  }

  get active() {
    return this.cars.filter((c) => c.on).length;
  }
}

/** `a` brought into -pi..pi. */
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Each copy's lamps, from its spare numbers: x brake, y left indicator, z right; the indicators blink at 1.5 Hz. */
const lampState = () => {
  const ext = attribute('iext', 'vec3');
  // the model's x is to its left: each half of a lamp cluster blinks for its own side
  const side = select(attribute('position', 'vec3').x.greaterThan(0), ext.y, ext.z);
  const amber = vec3(1, 0.45, 0.02).mul(side.mul(step(0, sin(time.mul(9.42)))).mul(5));
  return { brake: ext.x, amber };
};

/** A code-built car's material, remade as a node material that draws `Instances`; a lamp lens also shows the brakes and indicators. */
function nodeMaterial(m: THREE.Material, tinted = false, lamp?: 'head' | 'tail') {
  const src = m as THREE.MeshPhysicalMaterial;
  const params = {
    color: tinted ? 0xffffff : src.color, roughness: src.roughness, metalness: src.metalness, map: src.map,
    emissive: src.emissive, emissiveIntensity: src.emissiveIntensity, side: src.side, envMapIntensity: src.envMapIntensity,
  };
  const node = src.isMeshPhysicalMaterial
    ? new THREE.MeshPhysicalNodeMaterial({ ...params, clearcoat: src.clearcoat, clearcoatRoughness: src.clearcoatRoughness })
    : new THREE.MeshStandardNodeMaterial(params);
  if (lamp) {
    const { brake, amber } = lampState();
    // the brake lights burn far brighter than the tail lights, day or night
    node.emissiveNode = lamp === 'tail' ? materialEmissive.add(vec3(1, 0.04, 0.02).mul(brake.mul(4))).add(amber) : materialEmissive.add(amber);
  }
  return instanced(node, tinted);
}

/**
 * Intelligent Driver Model (Treiber): the acceleration a driver at `car.speed` who wants `v0` takes with something
 * `gap` metres ahead moving at `lead`. Smooth on a free road, firm when closing on a slower car, a stop at a standstill.
 */
function idm(car: Car, v0: number, gap = Infinity, lead = 0) {
  const v = car.speed, free = 1 - (v / Math.max(v0, 0.1)) ** 4;
  if (gap === Infinity) return car.accel * free;
  const want = S0 + Math.max(0, v * car.headway + (v * (v - lead)) / (2 * Math.sqrt(car.accel * COMFORT)));
  return car.accel * (free - (want / Math.max(gap, 0.1)) ** 2);
}
