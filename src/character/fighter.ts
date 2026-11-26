import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { BODY_MASS, CHEST, CharacterBody, PELVIS, Ragdoll } from './ragdoll.ts';
import { type Baked, type Figure, HIPS, LEFT_ARM, LEFT_HAND, NECK, HEAD_BONE, RIGHT_ARM, RIGHT_FOOT, RIGHT_HAND, SPINE, SPINE1, SPINE2, UPPER, blank, mix } from './figure.ts';
import type { Gun } from './guns.ts';

/** the joints an elbow and a knee land with */
const RIGHT_ELBOW = 12, RIGHT_KNEE = 18;
import { CROUCH_DROP, FRAMES, type PoseName, STICK_AIM } from './poses.ts';
import type { V3 } from '../vehicle/rider.ts';
import { clamp, damp } from '../util.ts';

/**
 * move: on their feet and their own master. cock, strike, recover: the three parts of a blow. stagger: rocked by
 * one. dodge: ducking or stepping out of the way of one. down: off their feet, and the physics has every limb.
 * getup: on the way back up.
 */
export type State = 'move' | 'cock' | 'strike' | 'recover' | 'stagger' | 'dodge' | 'down' | 'getup';

/** The sounds a fight makes. */
export type Thump = 'swing' | 'punch' | 'kick' | 'stick' | 'block' | 'thud' | 'body' | 'grunt' | 'pain' | 'death' | 'scream' | 'm416' | 'akm' | 'hit' | 'ricochet' | 'click' | 'draw' | 'reload-m416' | 'reload-akm';

export type MoveName = 'jab' | 'cross' | 'hook' | 'uppercut' | 'elbow' | 'kick' | 'knee' | 'roundhouse' | 'stomp' | 'swing' | 'chop';

/** A blow, and what goes into it. */
export interface Move {
  name: MoveName;
  cock: PoseName;
  hit: PoseName;
  /** seconds drawing back, in the blow, and getting back into guard */
  time: [number, number, number];
  /** the bone it lands with; -1 for the far end of the stick */
  limb: number;
  /** the whole body goes into it, legs and all, not only the arms */
  full: boolean;
  /** kg of the body behind it, and the m/s it is taken to land at, at least and at most */
  mass: number;
  slow: number;
  fast: number;
  /** metres across what lands */
  radius: number;
  /** m/s the feet carry the body forward into it */
  lunge: number;
  /** radians the body turns about the upright, drawn back and landing: positive brings the right side forward */
  twist: [number, number];
  /** the way it pushes whoever it lands on: shares forward, to the striker's left, and up */
  dir: [number, number, number];
  stick?: [V3, V3];
  sound: Thump;
  /** a blow with weight in it: thrown with a grunt */
  heavy: boolean;
}

const move = (m: Omit<Move, 'full' | 'heavy' | 'radius'> & Partial<Pick<Move, 'full' | 'heavy' | 'radius'>>): Move => ({ full: false, heavy: false, radius: 0.13, ...m });
export const MOVES: Record<MoveName, Move> = {
  jab: move({ name: 'jab', cock: 'guard', hit: 'jab', time: [0.06, 0.09, 0.16], limb: LEFT_HAND, mass: 2.5, slow: 5, fast: 10, lunge: 1.6, twist: [0.12, -0.4], dir: [1, 0, 0.08], sound: 'punch' }),
  cross: move({ name: 'cross', cock: 'cock', hit: 'cross', time: [0.12, 0.1, 0.24], limb: RIGHT_HAND, mass: 3.5, slow: 6, fast: 12, lunge: 1.8, twist: [-0.4, 0.8], dir: [1, 0, 0.08], sound: 'punch', heavy: true }),
  hook: move({ name: 'hook', cock: 'hookCock', hit: 'hook', time: [0.14, 0.11, 0.28], limb: LEFT_HAND, mass: 3.8, slow: 7, fast: 13, lunge: 1, twist: [0.45, -0.95], dir: [0.55, -0.8, 0.05], sound: 'punch', heavy: true }),
  uppercut: move({ name: 'uppercut', cock: 'upperCock', hit: 'uppercut', time: [0.16, 0.11, 0.32], limb: RIGHT_HAND, mass: 3.8, slow: 7, fast: 13, lunge: 1.2, twist: [-0.3, 0.55], dir: [0.45, 0, 0.9], sound: 'punch', heavy: true }),
  elbow: move({ name: 'elbow', cock: 'elbowCock', hit: 'elbow', time: [0.12, 0.1, 0.3], limb: RIGHT_ELBOW, mass: 4.5, slow: 6, fast: 11, radius: 0.15, lunge: 1.4, twist: [-0.45, 0.9], dir: [0.6, 0.75, 0.05], sound: 'punch', heavy: true }),
  knee: move({ name: 'knee', cock: 'kneeCock', hit: 'knee', time: [0.14, 0.12, 0.3], limb: RIGHT_KNEE, full: true, mass: 7, slow: 5, fast: 9, radius: 0.18, lunge: 1.2, twist: [0, 0], dir: [0.7, 0, 0.6], sound: 'kick', heavy: true }),
  kick: move({ name: 'kick', cock: 'kickCock', hit: 'kick', time: [0.18, 0.14, 0.34], limb: RIGHT_FOOT, full: true, mass: 7, slow: 6, fast: 11, radius: 0.16, lunge: 0.6, twist: [0, 0], dir: [1, 0, 0.1], sound: 'kick', heavy: true }),
  roundhouse: move({ name: 'roundhouse', cock: 'roundCock', hit: 'roundhouse', time: [0.2, 0.15, 0.4], limb: RIGHT_FOOT, full: true, mass: 7.5, slow: 8, fast: 14, radius: 0.17, lunge: 0.4, twist: [-0.3, 0.8], dir: [0.5, 0.85, 0.1], sound: 'kick', heavy: true }),
  stomp: move({ name: 'stomp', cock: 'kickCock', hit: 'stomp', time: [0.2, 0.12, 0.35], limb: RIGHT_FOOT, full: true, mass: 8, slow: 4, fast: 9, radius: 0.2, lunge: 0.5, twist: [0, 0], dir: [0.2, 0, -1], sound: 'kick', heavy: true }),
  swing: move({ name: 'swing', cock: 'stickCock', hit: 'stickSwing', time: [0.32, 0.14, 0.5], limb: -1, mass: 2.5, slow: 10, fast: 22, radius: 0.16, lunge: 0.9, twist: [-0.85, 0.95], dir: [1, 0, 0], stick: [STICK_AIM.cock, STICK_AIM.swing], sound: 'stick', heavy: true }),
  chop: move({ name: 'chop', cock: 'stickHigh', hit: 'stickChop', time: [0.4, 0.14, 0.45], limb: -1, mass: 2.8, slow: 10, fast: 20, radius: 0.16, lunge: 0.6, twist: [0, 0], dir: [0.5, 0, -0.8], stick: [STICK_AIM.high, STICK_AIM.chop], sound: 'stick', heavy: true }),
};
const PUNCHES: MoveName[] = ['jab', 'cross', 'hook', 'uppercut', 'elbow'];
const SWINGS: MoveName[] = ['swing', 'chop'];
/** seconds after one blow in which the next is the following one of the combination */
const CHAIN = 0.6;

/** What a fighter is trying to do: set by the player's hands or by an NPC's head (brain.ts). */
export interface Intent {
  /** m/s over the ground */
  vx: number;
  vz: number;
  /** the way to face, or null to face the way they are going */
  face: number | null;
  block: boolean;
}

/** The world as a fighter needs it. */
export interface Ring {
  /** A blow `m`, `radius` across, is at `at` moving at `velocity`: true if it landed on anything. */
  strike(by: Fighter, m: Move, at: THREE.Vector3, radius: number, velocity: THREE.Vector3): boolean;
  /** a blow thrown */
  swing(by: Fighter, m: Move): void;
}

const GETUP = 1.3, CROUCHED = 0.6, DODGE = 0.38;
/** N s of blows, weighed by where they land, that anyone can take in quick succession and stay standing */
const BALANCE = 80;
/** metres the figures are drawn above where their bodies stand: the road is drawn that much over the ground */
const LIFT = 0.045;
/** how stiff the neck and the back are against a blow, and how quickly they settle */
const SPRING = 170, DAMPING = 15;

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const _a = blank(), _b = blank();
const _v = new THREE.Vector3(), _mid = new THREE.Vector3(), _axis = new THREE.Vector3();
const _left = new THREE.Vector3(), _fwd = new THREE.Vector3(), _at = new THREE.Vector3(), _pole = new THREE.Vector3(), _fingers = new THREE.Vector3(), _palm = new THREE.Vector3();
const _look = new THREE.Matrix4(), _tilt = new THREE.Quaternion(), _euler = new THREE.Euler();
const ORIGIN = new THREE.Vector3();
/** 0 to 1, eased at both ends */
const smooth = (t: number) => { const k = clamp(t, 0, 1); return k * k * (3 - 2 * k); };
/**
 * A rifle in the hands, in the rifle's own space (x to the holder's left, y up, z along the barrel). The right hand
 * round the pistol grip, palm against its right side; the left under the handguard, palm up, fingers across it.
 * Each is where the middle of the palm goes, the way the fingers run from the wrist, and the way the palm faces.
 */
const RIGHT_GRIP = { at: [-0.012, -0.04, -0.02], fingers: [0.1, -0.3, 1], palm: [1, 0, -0.1] } satisfies Record<string, V3>;
const LEFT_GRIP = { fingers: [-0.85, 0.1, 0.5], palm: [-0.15, 1, 0] } satisfies Record<string, V3>;
/** metres from the wrist to the middle of the palm, and from the bones of the hand to its skin */
const PALM = 0.085, FLESH = 0.022;
/** a reload, as shares of the time it takes: the left hand to the magazine, out with it, a new one, back in, and back to the handguard */
const RELOAD = [0.16, 0.38, 0.56, 0.8, 0.9];
const UP = new THREE.Vector3(0, 1, 0);
type Q = { x: number; y: number; z: number; w: number };
/** (x, y, z) turned by q */
function turned(q: Q, x: number, y: number, z: number) {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + q.y * tz - q.z * ty, y: y + q.w * ty + q.z * tx - q.x * tz, z: z + q.w * tz + q.x * ty - q.y * tx };
}

/** A bend that a blow sets going and that settles back: a lean (axis times angle, in the world) and how fast it is changing. */
class Sway {
  readonly lean = new THREE.Vector3();
  readonly rate = new THREE.Vector3();
  kick(axis: THREE.Vector3, speed: number) {
    this.rate.addScaledVector(axis, speed);
  }
  step(dt: number) {
    // a spring, stepped in small pieces so it stays steady at any frame rate
    for (let n = 0, h = dt / 4; n < 4; n++) {
      this.rate.addScaledVector(this.lean, -SPRING * h).multiplyScalar(Math.max(0, 1 - DAMPING * h));
      this.lean.addScaledVector(this.rate, h);
    }
    if (this.lean.length() > 0.9) this.lean.setLength(0.9);
  }
  clear() {
    this.lean.set(0, 0, 0);
    this.rate.set(0, 0, 0);
  }
}

/**
 * Anyone on foot who can hit and be hit: the player out of the car, and the people they fall out with. Standing,
 * they are a capsule the legs push about, drawn in poses eased one into another, with the body twisting into each
 * blow and the head and back thrown by the ones that land. A blow is an impulse sized by how fast the fist or the
 * foot was really moving. Knocked down, they are eleven jointed pieces until they lie still.
 */
export class Fighter {
  readonly body: CharacterBody;
  readonly doll: Ragdoll;
  figure: Figure | null = null;
  on = false;
  state: State = 'move';
  /** seconds in this state */
  t = 0;
  health = 100;
  /** damage is divided by this: the player takes more than the people in the street */
  toughness = 1;
  /** N s of blows lately taken: see BALANCE */
  balance = 0;
  /** how shaken they are by blows to the head: past 1 the guard will not hold, and the next good one puts them down */
  daze = 0;
  yaw = 0;
  /** holding the hockey stick */
  armed = false;
  /** the rifle they hold, if any: shouldered, and no blows thrown */
  gun: Gun | null = null;
  /** where the rifle is pointed, in the world */
  readonly aim = new THREE.Vector3(0, 0, 1);
  /** the rifle as it is held this frame: where its grip is and how it is turned, and how far out of it the magazine is */
  readonly gunAt = new THREE.Vector3();
  readonly gunTurn = new THREE.Quaternion();
  readonly magOut = new THREE.Vector3();
  /** the last round's kick into the shoulder, 1 as it is fired and dying away */
  kick = 0;
  /** how far through changing the magazine, 0 to 1; 0 when not */
  reloading = 0;
  /** seconds more the rifle is kept up at the shoulder whatever the legs are doing: firing, or looking down the sights */
  raise = 0;
  /** how far the rifle is let down across the body, 0 to 1: nobody sprints with one at the shoulder */
  private lowered = 0;
  /** someone lies at their feet, in front of them: a kick is a stamp */
  stompable = false;
  /** someone standing right up against them: a kick is a knee */
  close = false;
  /** how high their voice is */
  voice = 1;
  /** the blow being thrown, if any */
  move: Move | null = null;
  readonly intent: Intent = { vx: 0, vz: 0, face: null, block: false };
  /** where they stand (their feet), as drawn this frame */
  readonly pos = new THREE.Vector3();
  /** which way the stick points from the hands, in the world */
  readonly stickDir = new THREE.Vector3(0, 0, 1);
  readonly hand = new THREE.Vector3();
  /** seconds since they last threw, took or squared up for a blow: the fists come down after a while */
  calm = 99;
  /** seconds since they were last hurt */
  unhurt = 99;
  /** seconds since they last made a sound at being hit */
  unhurtVoice = 99;
  /** m/s of the blow from a car or anything else that knocked them flying in the last physics step, for whoever wants to know */
  struck = 0;
  /** who last hit them */
  hitBy: Fighter | null = null;
  /** seconds of the picture held still after a blow lands: it is felt, as in any fight on film */
  freeze = 0;
  /** they have bled where they lie */
  pooled = false;
  /** seconds more they go on bleeding from a round they have taken */
  bleeding = 0;

  private prev = new THREE.Vector3();
  private cur = new THREE.Vector3();
  private landed = false;
  /** the blow asked for, and for how many more seconds it is still wanted */
  private queued: MoveName | 'punch' | 'kick' | null = null;
  private queuedFor = 0;
  /** the last blow thrown, and seconds since it was done with */
  private last: MoveName | null = null;
  private since = 99;
  private reel = 0.3;
  private reaction: PoseName = 'flinch';
  private dodgeX = 0;
  private dodgeZ = 0;
  private phase = 0;
  private stance = 0;
  private still = 0;
  private twist = 0;
  private bob = Math.random() * 10;
  private head = new Sway();
  private torso = new Sway();
  private target = blank();
  private lastPoint = new THREE.Vector3();
  private lastV = { x: 0, y: 0, z: 0 };

  constructor(world: RAPIER.World) {
    this.body = new CharacterBody(world);
    this.doll = new Ragdoll(world);
  }

  private reset(figure: Figure, x: number, y: number, z: number, yaw: number) {
    this.figure = figure;
    this.on = true;
    this.state = 'move';
    this.t = this.balance = this.daze = this.queuedFor = this.struck = this.stance = this.still = this.twist = this.freeze = 0;
    this.health = 100;
    this.calm = this.unhurt = this.since = 99;
    this.armed = this.pooled = this.stompable = this.close = false;
    this.gun = null;
    this.kick = this.reloading = this.raise = this.lowered = this.bleeding = 0;
    figure.heal();
    this.move = this.queued = this.last = null;
    this.hitBy = null;
    this.yaw = yaw;
    this.head.clear();
    this.torso.clear();
    Object.assign(this.intent, { vx: 0, vz: 0, face: null, block: false });
    this.cur.set(x, y, z);
    this.prev.copy(this.cur);
    this.pos.copy(this.cur);
    figure.drop = 0;
    figure.snap(figure.source.poses.stand);
    figure.group.position.copy(this.cur);
    figure.group.position.y += LIFT;
    figure.group.quaternion.setFromAxisAngle(UP, yaw);
    figure.refresh();
    figure.at(LEFT_HAND, this.lastPoint);
  }

  /** On their feet at (x, y, z). */
  spawn(figure: Figure, x: number, y: number, z: number, yaw: number) {
    this.doll.deactivate();
    this.reset(figure, x, y, z, yaw);
    this.body.place(x, y, z);
  }

  /** Just out of a car seat: rising out of a crouch to their feet, which takes a moment. */
  stepOut() {
    const figure = this.figure!;
    figure.snap(figure.source.poses.crouch);
    figure.drop = CROUCH_DROP * 0.7;
    [this.state, this.t] = ['getup', CROUCHED + 0.15];
  }

  /** Already off their feet, thrown at `vel`: someone a car has just hit. */
  spawnDown(figure: Figure, x: number, y: number, z: number, yaw: number, vel: { x: number; y: number; z: number }) {
    this.body.remove();
    this.reset(figure, x, y, z, yaw);
    this.doll.activate(x, y, z, yaw, vel);
    this.lastV = { ...vel };
    this.state = 'down';
  }

  /** Gone from the world; whoever asked gets the figure back. */
  despawn() {
    const figure = this.figure;
    this.body.remove();
    this.doll.deactivate();
    this.on = false;
    this.figure = null;
    return figure;
  }

  get standing() {
    return this.on && this.state !== 'down' && this.state !== 'getup';
  }

  get blocking() {
    return this.state === 'move' && this.intent.block && this.daze < 1;
  }

  /** ducked or stepped out of the way: a blow now goes past */
  get evading() {
    return this.state === 'dodge' && this.t < DODGE * 0.75;
  }

  /** winding up, or in, a blow: for the other side to see coming */
  get threatening() {
    return this.state === 'cock' || this.state === 'strike';
  }

  /**
   * A blow: one by name, or the next in the combination (`punch`: jab, cross, hook, uppercut; `kick`: a front kick
   * then a roundhouse, or a stamp on someone down). With the stick in hand a punch is a swing of it.
   */
  attack(kind: MoveName | 'punch' | 'kick' = 'punch') {
    if (this.gun) return;
    this.queued = kind;
    this.queuedFor = 0.3;
  }

  /** Out of the way, along (x, z), or straight back when that is nothing. */
  dodge(x: number, z: number) {
    if (this.state !== 'move' && this.state !== 'recover') return;
    const l = Math.hypot(x, z);
    [this.dodgeX, this.dodgeZ] = l > 0.1 ? [x / l, z / l] : [-Math.sin(this.yaw), -Math.cos(this.yaw)];
    [this.state, this.t, this.move] = ['dodge', 0, null];
  }

  hurt(damage: number) {
    this.health = Math.max(0, this.health - damage / this.toughness);
    this.calm = this.unhurt = 0;
  }

  private pick(kind: MoveName | 'punch' | 'kick'): MoveName {
    const chained = this.since < CHAIN;
    if (kind === 'kick') return this.stompable ? 'stomp' : this.close ? 'knee' : chained && this.last === 'kick' ? 'roundhouse' : 'kick';
    if (this.armed && kind !== 'stomp' && kind !== 'roundhouse') {
      return chained && this.last && SWINGS.includes(this.last) ? SWINGS[(SWINGS.indexOf(this.last) + 1) % SWINGS.length] : 'swing';
    }
    if (kind !== 'punch') return kind;
    const at = this.last ? PUNCHES.indexOf(this.last) : -1;
    return chained && at >= 0 ? PUNCHES[(at + 1) % PUNCHES.length] : 'jab';
  }

  /** Before each physics step. */
  step(dt: number) {
    if (this.doll.active) this.doll.settle(dt);
    if (!this.body.on) return;
    const { vx, vz, block } = this.intent, fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    if (this.state === 'stagger') this.body.drive(0, 0, dt, 3);
    else if (this.state === 'getup') this.body.drive(0, 0, dt);
    else if (this.state === 'dodge') {
      const k = this.t < DODGE * 0.6 ? 4.5 : 0;
      this.body.drive(this.dodgeX * k, this.dodgeZ * k, dt, 40);
    } else if (this.state === 'strike' && this.move) this.body.drive(fx * this.move.lunge + vx * 0.2, fz * this.move.lunge + vz * 0.2, dt, 25);
    else {
      // nobody throws a punch at a run
      const k = this.state !== 'move' ? 0.3 : block ? 0.45 : this.daze > 0.8 ? 0.5 : 1;
      this.body.drive(vx * k, vz * k, dt);
    }
  }

  /** After each physics step: where they have got to, and whether anything sent them flying. */
  afterStep() {
    this.prev.copy(this.cur);
    this.struck = 0;
    if (this.doll.active) {
      const pelvis = this.doll.parts[PELVIS], p = pelvis.translation(), v = pelvis.linvel();
      this.cur.set(p.x, p.y - (this.figure?.hipHeight ?? 0.95), p.z);
      // being thrown does not hurt; landing does, and so does being hit again
      const dv = Math.hypot(v.x - this.lastV.x, v.y - this.lastV.y, v.z - this.lastV.z);
      if (dv > 4) this.hurt(dv * dv * 0.3);
      this.lastV = { x: v.x, y: v.y, z: v.z };
    } else if (this.body.on) {
      const p = this.body.body.translation();
      this.cur.set(p.x, p.y, p.z);
      const jolt = this.body.jolt();
      if (jolt > 3) {
        this.struck = jolt;
        this.hurt(jolt * jolt * 0.35);
        this.fall();
      }
    }
  }

  /** Off their feet where they stand, moving as they were; a blow, if there was one, lands on the piece of them it hit. */
  fall(at?: THREE.Vector3, impulse?: THREE.Vector3) {
    if (this.doll.active || !this.body.on) return;
    const v = this.body.body.linvel(), p = this.body.body.translation();
    this.lastV = { x: v.x, y: v.y, z: v.z };
    this.doll.activate(p.x, p.y, p.z, this.yaw, this.lastV);
    this.body.remove();
    if (at && impulse) this.doll.hit(at, impulse);
    this.state = 'down';
    this.move = null;
    this.t = this.still = this.balance = this.daze = 0;
  }

  /** Up from where the body came to rest: the capsule goes back under them, and the bones ease from how they lay. */
  private rise() {
    const figure = this.figure!;
    const p = this.doll.parts[PELVIS].translation(), chest = this.doll.parts[CHEST].rotation();
    // from their back they sit up facing their feet; from their front they push up facing where their head was
    const up = turned(chest, 0, 1, 0), front = turned(chest, 0, 0, 1);
    this.yaw = Math.hypot(up.x, up.z) < 0.35 ? Math.atan2(front.x, front.z) : front.y > 0 ? Math.atan2(-up.x, -up.z) : Math.atan2(up.x, up.z);
    const ground = Math.max(0, p.y - 0.14);
    this.doll.deactivate();
    this.body.place(p.x, ground, p.z);
    figure.turnKeeping(this.yaw);
    figure.drop = clamp(figure.hipHeight - (p.y - ground), 0, figure.hipHeight);
    this.cur.set(p.x, ground, p.z);
    this.prev.copy(this.cur);
    this.state = 'getup';
    this.t = 0;
  }

  /**
   * A blow of `impulse` (N s) lands at `at`. Standing, it costs health by where it lands, less behind a guard;
   * enough of it, a dazed head taking another, or one big one on the chin, and they go down. Returns the damage
   * done and where it landed.
   */
  takeHit(at: THREE.Vector3, impulse: THREE.Vector3, by: Fighter | null): { damage: number; zone: 'head' | 'body' | 'legs'; blocked: boolean } {
    const size = impulse.length();
    this.hitBy = by;
    if (this.doll.active) {
      this.doll.hit(at, impulse);
      this.hurt(size * 0.25);
      return { damage: size * 0.25, zone: 'body', blocked: false };
    }
    if (!this.body.on) return { damage: 0, zone: 'body', blocked: false };
    const height = (at.y - this.cur.y) / ((this.figure?.hipHeight ?? 0.95) / 0.95);
    const zone = height > 1.38 ? 'head' : height > 0.72 ? 'body' : 'legs';
    const weight = zone === 'head' ? 1.6 : zone === 'body' ? 1 : 0.6;
    // a guard only covers the front, and only while the head is clear
    const front = -(impulse.x * Math.sin(this.yaw) + impulse.z * Math.cos(this.yaw)) / size;
    const blocked = this.blocking && front > 0.2 && zone !== 'legs';
    const damage = size * 0.42 * weight * (blocked ? 0.2 : 1);
    this.hurt(damage);
    this.balance += (size * (zone === 'legs' ? 1.6 : weight) * (blocked ? 0.3 : 1)) / this.toughness;
    if (zone === 'head' && !blocked) this.daze += size / 45 / this.toughness;
    if (blocked) impulse.multiplyScalar(0.5);

    // the head is thrown the way the blow went, or the body folds over a blow to it
    _v.set(impulse.x, 0, impulse.z).normalize();
    _axis.crossVectors(UP, _v).normalize();
    if (zone === 'head') this.head.kick(_axis, Math.min(11, size * (blocked ? 0.05 : 0.22)));
    else this.torso.kick(_axis.negate(), Math.min(7, size * (blocked ? 0.04 : 0.14)));

    if (this.health <= 0 || this.balance > BALANCE || this.daze > 1.6 || (zone === 'head' && size > 42 && !blocked)) this.fall(at, impulse);
    else {
      // the blow itself, and the step back the legs take to stay under the body
      const step = (BODY_MASS * Math.min(1.4, size / 22)) / size;
      this.body.body.applyImpulse({ x: impulse.x * (1 + step), y: 0, z: impulse.z * (1 + step) }, true);
      this.state = 'stagger';
      this.t = 0;
      this.move = null;
      this.reel = blocked ? 0.12 : 0.2 + size / 110 + this.daze * 0.25;
      this.reaction = blocked ? 'block' : zone === 'body' && size > 30 ? 'gut' : 'flinch';
    }
    return { damage, zone, blocked };
  }

  /**
   * The rifle brought up: the butt in the hollow of the right shoulder, the barrel along the aim, the body turned
   * a little side-on behind it and bent at the waist to follow it up and down, the head down to the sights, and
   * each arm bent so its hand is where it holds the rifle. Laid over the pose for this frame only.
   */
  private shoulder(figure: Figure, gun: Gun, dt: number) {
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const left = _left.set(cos, 0, -sin), fwd = _fwd.set(sin, 0, cos);
    this.kick *= Math.exp(-16 * dt);
    const r = this.reloading;
    // the rifle comes down and rolls its magazine towards the left hand while that is changed
    const down = r > 0 ? smooth(r / 0.12) * smooth((1 - r) / 0.12) : 0;
    // at a run it is carried low across the body, the muzzle down and to the left, and comes up again to fire
    const v = this.body.body.linvel();
    this.raise -= dt;
    this.lowered += ((Math.hypot(v.x, v.z) > 4.2 && this.raise <= 0 && r <= 0 ? 1 : 0) - this.lowered) * damp(9, dt);
    const low = smooth(this.lowered);
    const pitch = Math.asin(clamp(this.aim.y, -1, 1)) * (1 - low);

    figure.overlay();
    // side-on: the right shoulder back, the head left looking where the rifle does
    const side = 1 - low;
    figure.bend(SPINE1, UP, -0.24 * side);
    figure.bend(SPINE2, UP, -0.24 * side);
    figure.bend(NECK, UP, 0.26 * side);
    figure.bend(HEAD_BONE, UP, 0.2 * side);
    // up and down from the waist, the head a little more: the eye stays behind the sights
    for (const [bone, share] of [[SPINE, 0.15], [SPINE1, 0.2], [SPINE2, 0.2], [NECK, 0.15], [HEAD_BONE, 0.15]] as const) figure.bend(bone, left, -pitch * share);
    // the cheek to the stock: the head forward and down, and tipped over to the right
    figure.bend(SPINE2, left, 0.08 * side);
    figure.bend(NECK, left, 0.22 * side);
    figure.bend(NECK, fwd, 0.14 * side);
    figure.bend(HEAD_BONE, fwd, 0.12 * side);
    figure.refresh();

    // the rifle: along the aim, kicked up a little by the last round, tipped over for a reload
    _v.copy(this.aim).lerp(_mid.copy(fwd).multiplyScalar(0.55).addScaledVector(left, 0.55).addScaledVector(UP, -0.65), low).normalize();
    const turn = this.gunTurn.setFromRotationMatrix(_look.lookAt(_v, ORIGIN, UP));
    turn.multiply(_tilt.setFromEuler(_euler.set(down * 0.32 - this.kick * 0.03, down * 0.12, down * 0.4 + low * 0.35)));
    const at = (p: V3, out: THREE.Vector3) => out.set(p[0], p[1], p[2]).applyQuaternion(turn);
    figure.at(RIGHT_ARM, this.gunAt).addScaledVector(left, 0.04).addScaledVector(fwd, 0.035 - this.kick * 0.02 - down * 0.02).addScaledVector(UP, 0.03 - down * 0.05 - low * 0.16).addScaledVector(left, low * 0.05).sub(at(gun.butt, _v));

    // the right hand on the grip, the elbow down and out
    at(RIGHT_GRIP.fingers, _fingers).normalize();
    at(RIGHT_GRIP.palm, _palm).addScaledVector(_fingers, -_palm.dot(_fingers)).normalize();
    at(RIGHT_GRIP.at, _at).add(this.gunAt).addScaledVector(_fingers, -PALM).addScaledVector(_palm, -FLESH);
    figure.reach(RIGHT_ARM, _at, _pole.set(0, -1, 0).addScaledVector(left, -0.75).addScaledVector(fwd, -0.3), _fingers, _palm);

    // the left hand under the handguard; on a reload it goes to the magazine, down to the belt with it, and back
    const [reachMag, magDown, fresh, magIn, back] = RELOAD;
    const go = r <= 0 ? 0 : r < reachMag ? smooth(r / reachMag) : r < magIn ? 1 : 1 - smooth((r - magIn) / (back - magIn));
    const away = r < reachMag || r >= magIn ? 0 : r < magDown ? smooth((r - reachMag) / (magDown - reachMag)) : r < fresh ? 1 : 1 - smooth((r - fresh) / (magIn - fresh));
    this.magOut.set(0.03, -0.26, -0.04).multiplyScalar(away);
    at(LEFT_GRIP.fingers, _fingers).normalize();
    at(LEFT_GRIP.palm, _palm).addScaledVector(_fingers, -_palm.dot(_fingers)).normalize();
    _v.set(gun.support[0], gun.support[1], gun.support[2]).lerp(_mid.set(gun.magazine[0], gun.magazine[1], gun.magazine[2]), go).add(this.magOut);
    _at.copy(_v).applyQuaternion(turn).add(this.gunAt).addScaledVector(_fingers, -PALM * 0.6).addScaledVector(_palm, -FLESH * 0.5);
    figure.reach(LEFT_ARM, _at, _pole.set(0, -1, 0).addScaledVector(left, 0.45).addScaledVector(fwd, -0.2), _fingers, _palm);
  }

  /** Every frame: the state they are in runs its course, and the figure is moved to match. `blend` is how far between two physics steps the picture is. */
  update(dt: number, blend: number, ring: Ring) {
    const figure = this.figure;
    if (!this.on || !figure) return;
    figure.unlay();
    figure.bleed(dt);
    // held for a moment by a blow landing
    if (this.freeze > 0) {
      this.freeze -= dt;
      dt *= 0.08;
    }
    this.t += dt;
    this.calm += dt;
    this.unhurt += dt;
    this.unhurtVoice += dt;
    this.since += dt;
    this.queuedFor -= dt;
    this.balance = Math.max(0, this.balance - 25 * dt);
    this.daze = Math.max(0, this.daze - 0.22 * dt);
    this.pos.lerpVectors(this.prev, this.cur, blend);
    figure.group.position.copy(this.pos);
    figure.group.position.y += LIFT;

    if (this.state === 'down') {
      figure.drop = 0;
      figure.follow((piece) => this.doll.parts[piece].rotation(), damp(25, dt));
      figure.refresh();
      this.still = this.doll.speed < 0.35 ? this.still + dt : 0;
      if (this.health > 0 && ((this.still > 0.9 && this.t > 1.6) || this.t > 8)) this.rise();
      return;
    }

    const poses = figure.source.poses;
    if (this.state === 'getup') {
      const low = this.t < CROUCHED;
      figure.ease(low ? poses.crouch : poses.stand, damp(6, dt));
      figure.drop += ((low ? CROUCH_DROP : 0) - figure.drop) * damp(low ? 5 : 7, dt);
      figure.refresh();
      if (this.t >= GETUP) [this.state, this.t, figure.drop] = ['move', 0, 0];
      return;
    }

    // the blow: drawn back, thrown, and the guard brought up again
    const m = this.move;
    if ((this.state === 'move' || (this.state === 'recover' && this.t > (m?.time[2] ?? 0) * 0.5)) && this.queued && this.queuedFor > 0) {
      const next = MOVES[this.pick(this.queued)];
      [this.move, this.state, this.t, this.queued, this.landed, this.calm] = [next, 'cock', 0, null, false, 0];
    } else if (this.state === 'cock' && m && this.t >= m.time[0]) {
      [this.state, this.t] = ['strike', 0];
      ring.swing(this, m);
    } else if (this.state === 'strike' && m && this.t >= m.time[1]) [this.state, this.t] = ['recover', 0];
    else if (this.state === 'recover' && m && this.t >= m.time[2]) {
      [this.state, this.t, this.last, this.since, this.move] = ['move', 0, m.name, 0, null];
    } else if (this.state === 'stagger' && this.t >= this.reel) [this.state, this.t] = ['move', 0];
    else if (this.state === 'dodge' && this.t >= DODGE) [this.state, this.t] = ['move', 0];

    // facing: where they mean to, or the way they are going
    const v = this.body.body.linvel(), speed = Math.hypot(v.x, v.z);
    const want = this.intent.face ?? (speed > 0.4 && this.state === 'move' ? Math.atan2(v.x, v.z) : this.yaw);
    const turnRate = this.state === 'cock' || this.state === 'move' ? 12 : 4;
    this.yaw += clamp(wrap(want - this.yaw), -turnRate * dt, turnRate * dt);
    figure.group.quaternion.setFromAxisAngle(UP, this.yaw);

    // legs: standing, walking or running by how fast the ground is going past
    const run = clamp((speed - 2.2) / 1.4, 0, 1);
    this.phase = (this.phase + (speed * dt) / (1.5 + 1.1 * run)) % 1;
    const frame = Math.floor(this.phase * FRAMES), part = this.phase * FRAMES - frame, next = (frame + 1) % FRAMES;
    mix(_a, figure.source.walk[frame], figure.source.walk[next], part);
    if (run > 0) mix(_a, _a, mix(_b, figure.source.run[frame], figure.source.run[next], part), run);
    mix(this.target, poses.stand, _a, clamp(speed / 0.5, 0, 1));
    // squared up and not going anywhere: on the balls of bent legs, the left foot forward (a blow's own legs come over this)
    const squared = (this.gun ? 0.75 : this.stance * (this.armed ? 0.6 : 1)) * clamp(1 - speed / 1.2, 0, 1);
    if (squared > 0.01) mix(this.target, this.target, poses.fightStance, squared);

    // arms and back, or the whole body: whatever the fight asks of them
    this.stance += ((this.calm < 5 ? 1 : 0) - this.stance) * damp(4, dt);
    let upper: Baked | null = null, weight = 1, rate = 12, whole = false, drop = 0;
    const s = this.state;
    if (s === 'move') {
      if (this.gun) [upper, rate] = [poses.rifle, 16];
      else if (this.intent.block) upper = poses.block;
      else if (this.armed) upper = poses.stickCarry;
      else if (this.stance > 0.01) [upper, weight] = [poses.guard, this.stance];
    } else if (m && s === 'cock') [upper, rate, whole] = [poses[m.cock], m.full ? 16 : 20, m.full];
    // the blow's legs come with it (the back heel driving), so it is mixed whole whenever it has legs of its own
    else if (m && s === 'strike') [upper, rate, whole] = [poses[m.hit], m.full ? 28 : 45, m.full || this.stance > 0.5];
    // a swing carries on through before the stick comes back round; a punch snaps back to the guard
    else if (m && s === 'recover') [upper, rate] = [m.stick && this.t < m.time[2] * 0.45 ? poses.stickFollow : this.armed ? poses.stickCarry : poses.guard, m.stick ? 8 : 14];
    else if (s === 'dodge') [upper, rate, whole, drop] = [poses.duck, 22, true, 0.16];
    else [upper, rate] = [poses[this.reaction], 22];
    if (upper) mix(this.target, this.target, upper, weight, whole ? undefined : UPPER);
    figure.ease(this.target, damp(rate, dt));
    figure.drop += (drop - figure.drop) * damp(14, dt);

    // laid over the pose: the turn of the body into the blow, the guard's bob, and whatever the last blow taken is doing to the neck and back
    const goal = !m ? 0 : s === 'cock' ? m.twist[0] : s === 'strike' ? m.twist[1] : s === 'recover' ? m.twist[1] * 0.5 : 0;
    this.twist += (goal - this.twist) * damp(s === 'strike' ? 30 : 14, dt);
    if (m?.full) figure.bend(HIPS, UP, this.twist * 0.6);
    figure.bend(SPINE1, UP, this.twist * (m?.full ? 0.2 : 0.5));
    figure.bend(SPINE2, UP, this.twist * (m?.full ? 0.2 : 0.5));
    this.bob += dt * (this.daze > 0.7 ? 3 : 6);
    if (s === 'move' && this.stance > 0.3) {
      _axis.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      figure.bend(SPINE, _axis, Math.sin(this.bob) * 0.035 * this.stance);
      figure.drop += (0.025 + Math.sin(this.bob * 2) * 0.02) * this.stance * (speed < 0.8 ? 1 : 0);
    }
    if (this.daze > 0.6) {
      // reeling: the head lolls
      _axis.set(Math.sin(this.bob * 0.7), 0, Math.cos(this.bob * 1.3)).normalize();
      this.head.kick(_axis, (this.daze - 0.6) * 4 * dt);
    }
    this.head.step(dt);
    this.torso.step(dt);
    for (const [sway, bones] of [[this.head, [[NECK, 0.55], [HEAD_BONE, 0.45]]], [this.torso, [[SPINE1, 0.5], [SPINE2, 0.5]]]] as const) {
      const angle = sway.lean.length();
      if (angle < 1e-3) continue;
      _axis.copy(sway.lean).divideScalar(angle);
      for (const [bone, share] of bones) figure.bend(bone, _axis, angle * share);
    }
    figure.close(0, this.gun ? 1.05 : undefined);
    if (this.gun) this.shoulder(figure, this.gun, dt);
    figure.refresh();

    // the fist, the foot, or the far end of the stick: where it is, and how fast it is really going
    const aim = m?.stick ? (s === 'cock' ? m.stick[0] : s === 'strike' ? m.stick[1] : s === 'recover' && this.t < m.time[2] * 0.45 ? STICK_AIM.follow : STICK_AIM.carry) : STICK_AIM.carry;
    _v.set(aim[0], aim[1], aim[2]).normalize().applyAxisAngle(UP, this.yaw);
    this.stickDir.lerp(_v, damp(s === 'strike' ? 35 : s === 'cock' ? 16 : 10, dt)).normalize();
    figure.at(RIGHT_HAND, this.hand);
    const limb = m ? m.limb : this.armed ? -1 : LEFT_HAND;
    const point = limb < 0 ? _mid.copy(this.hand).addScaledVector(this.stickDir, 0.8) : figure.at(limb, _mid);
    const velocity = _v.copy(point).sub(this.lastPoint).divideScalar(Math.max(dt, 1e-3));
    this.lastPoint.copy(point);
    if (s === 'strike' && m && !this.landed) {
      this.landed = ring.strike(this, m, point, m.radius, velocity)
        || (limb < 0 && ring.strike(this, m, _mid.copy(this.hand).addScaledVector(this.stickDir, 0.45), 0.14, velocity));
    }
  }
}
