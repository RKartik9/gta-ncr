import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { CarSpec } from '../vehicle/cars.ts';
import { FIGURES, type Pedestrians, type Walker } from '../world/pedestrians.ts';
import { STRIKE_GROUPS } from '../world/physics.ts';
import type { Traffic } from '../world/traffic.ts';
import { clamp } from '../util.ts';
import { Brain } from './brain.ts';
import { Blood } from './blood.ts';
import { Fighter, type Move, type Ring, type Thump, wrap } from './fighter.ts';
import { Figure, type Source, loadSource, woundSample } from './figure.ts';
import { CHEST, HEAD } from './ragdoll.ts';
import { Stick } from './stick.ts';
import { Armoury, GUNS, type GunName } from './guns.ts';

export type { Thump };

/** The car the player drives, as the people on foot need to know it. */
export interface CarRef {
  group: THREE.Object3D;
  spec: CarSpec;
  body: RAPIER.RigidBody;
  bike: boolean;
  /** the road under it */
  ground: number;
  heading: number;
}

/** What the player's hands ask for on foot: x to their right, y ahead, both -1 to 1 and relative to the camera. */
export interface FootInput {
  x: number;
  y: number;
  sprint: boolean;
  block: boolean;
}

export interface Hooks {
  /** a sound of `strength` (N s for blows, m/s for bodies) `distance` metres from the player; `voice` is how high the voice of whoever made it is */
  sound(kind: Thump, strength: number, distance: number, voice?: number): void;
  /** the camera is shaken, by about this many metres */
  shake(amount: number): void;
  /** a rifle's kick: the aim thrown up by `pitch` and aside by `yaw`, radians */
  recoil(pitch: number, yaw: number): void;
  /** the player has been hurt, 0 to 1: the edges of the screen go red */
  hurt(amount: number): void;
  /** the player has been dragged out of the car: the game is on foot now, without their asking */
  pulledOut(): void;
  /** the player has walked to the door and is back in the car */
  entered(): void;
  say(text: string): void;
  rumble(strength: number, ms: number): void;
  /** the screen goes dark, and comes back */
  fade(on: boolean): void;
}

const PLAYER = 'rider/model.glb';
/** the men who drive the traffic */
const DRIVERS = ['people/man_arab.glb', 'people/man_guy.glb'];
/** m/s on foot: a walk (a stick pushed a little), a jog, a sprint */
const WALK = 1.6, JOG = 3.2, SPRINT = 5.5;
/** blows on the car door it takes to have the player out of it, if they sit there */
const DRAG_OUT = 4;
/** metres from the car's side at which the player gets out, and from the car within which they can get in */
const DOOR = 0.6, REACH = 1.3;

interface Npc {
  brain: Brain;
  /** who they were on the pavement, to go back to being; null for a driver who got out */
  walker: Walker | null;
  file: string;
  /** seconds knocked out cold */
  out: number;
}

/** what the camera will not go behind: not the road, and not people */
const SIGHT_GROUPS = (0x0200 << 16) | (0xffff & ~0x00c2);

const _p = new THREE.Vector3(), _j = new THREE.Vector3(), _door = new THREE.Vector3(), _hit = new THREE.Vector3(), _line = new THREE.Vector3();
const NO_TURN = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Everything that happens on foot: the player getting out of the car and back in, the fights they get into with
 * the people on the pavement and with drivers they have hit, the hockey stick from the boot, and bodies knocked down
 * by blows and by cars. A fixed handful of fighters is made at the start and used over and over (see `Quality.fighters`).
 */
export class Combat implements Ring {
  onFoot = false;
  /** what the player can do where they stand, for the screen to say */
  prompt = '';
  readonly player: Fighter;
  readonly stick: Stick;
  /** the figures made ahead of time, for the renderer to build their shaders before any of them is needed */
  readonly warm = new THREE.Group();
  /** everyone on foot here, for the traffic to stop for */
  readonly obstacles: { x: number; z: number }[] = [];
  /** resolves once the figures are in: until then nobody can get out of the car */
  readonly ready: Promise<void>;

  private scene: THREE.Scene;
  private world: RAPIER.World;
  private people: Pedestrians;
  private traffic: Traffic;
  private hooks: Hooks;
  private fighters: Fighter[];
  private owner = new Map<number, Fighter>();
  private npcs = new Map<Fighter, Npc>();
  private sources = new Map<string, Source>();
  private spare = new Map<string, Figure[]>();
  private self: Figure | null = null;
  private car: CarRef | null = null;
  /** drivers who mean to get out, once their car has stopped */
  private angry: { body: RAPIER.RigidBody; width: number; leave: () => boolean; wait: number }[] = [];
  private scared = 0;
  private outCold = 0;
  private dark = false;
  private fist = new RAPIER.Ball(0.14);
  private blood: Blood;
  private carHits = 0;
  private drips = 0;
  private room = new RAPIER.Capsule(0.55, 0.26);
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** the player's rifles: which is in hand (null: fists), rounds left in each, and the trigger's timing */
  readonly armoury: Armoury;
  weapon: GunName | null = null;
  private rounds: Record<GunName, number> = { m416: GUNS.m416.mag, akm: GUNS.akm.mag };
  private cooldown = 0;
  private reloading = 0;
  /** screams on their way: who by (how high their voice is), where, and in how many seconds */
  private cries: { wait: number; x: number; z: number; voice: number }[] = [];
  private wasHeld = false;
  /** the rifle's muzzle */
  private muzzle = new THREE.Vector3();
  /** seconds into walking to the car door to get in, or -1 */
  private entering = -1;
  private doorAt = new THREE.Vector3();

  constructor(scene: THREE.Scene, world: RAPIER.World, people: Pedestrians, traffic: Traffic, count: number, hooks: Hooks) {
    this.scene = scene;
    this.world = world;
    this.people = people;
    this.traffic = traffic;
    this.hooks = hooks;
    this.fighters = Array.from({ length: Math.max(0, count) + 1 }, () => new Fighter(world));
    this.player = this.fighters[0];
    for (const f of this.fighters) for (const b of [f.body.body, ...f.doll.parts]) this.owner.set(b.handle, f);
    this.stick = new Stick(scene, world);
    this.blood = new Blood(scene);
    this.warm.add(this.blood.sample, woundSample());
    this.armoury = new Armoury(scene);
    this.player.toughness = 1.6;
    people.onStruck = (w, vx, vz) => this.runDown(w, vx, vz);
    traffic.onWreck = (car) => {
      // anyone but the meekest gets out to have it out with a player who hit them or held them up; a crash between two others is theirs to sort out
      if (!car.near || car.aggression <= 0.2 || this.angry.some((a) => a.body === car.body)) return;
      this.angry.push({ body: car.body, width: car.width, leave: car.leave, wait: 0.8 + Math.random() });
    };
    this.ready = Promise.all([...new Set([PLAYER, ...FIGURES.map(([file]) => file)])].map((file) => loadSource(file).then((source) => {
      this.sources.set(file, source);
      const figure = new Figure(source);
      this.warm.add(figure.group);
      if (file === PLAYER) {
        // the player is always the same man; one more of him for when he turns up in the crowd
        this.self = figure;
        this.spare.set(file, [new Figure(source)]);
        this.warm.add(this.spare.get(file)![0].group);
      } else this.spare.set(file, [figure]);
    }).catch((err) => console.warn(`Nobody on foot from ${file}`, err)))).then(() => {});
  }

  /** The car the player has: at the start, and whenever they change it. */
  setCar(car: CarRef) {
    this.car = car;
    this.stick.setCar(car.group, car.spec, car.bike);
  }

  private figureFor(file: string, height: number) {
    const source = this.sources.get(file);
    if (!source) return null;
    const figure = this.spare.get(file)?.pop() ?? new Figure(source);
    figure.setHeight(height);
    figure.dress(null, null);
    this.scene.add(figure.group);
    return figure;
  }

  private putBack(figure: Figure | null) {
    if (!figure || figure === this.self) return;
    figure.group.removeFromParent();
    this.spare.get(figure.source.file)?.push(figure);
  }

  /** a woman's voice is higher than a man's, and nobody's is quite anyone else's */
  private voiceOf(file: string) {
    return (/woman/.test(file) ? 1.75 : 1) * (0.9 + Math.random() * 0.22);
  }

  private free() {
    return this.fighters.find((f) => f !== this.player && !f.on) ?? null;
  }

  /** Where the player is: on foot, or at the wheel. */
  private where(out: THREE.Vector3) {
    return this.onFoot || !this.car ? out.copy(this.player.pos) : out.copy(this.car.group.position);
  }

  private distance(x: number, z: number) {
    const p = this.where(_p);
    return Math.hypot(p.x - x, p.z - z);
  }

  /** Beside the car's door on one side (1 left, -1 right), on the ground. */
  private door(car: CarRef, sideSign: number, out: THREE.Vector3) {
    const p = car.body.translation(), h = car.heading, along = car.bike ? 0 : car.spec.cockpitCamera[2];
    const out2 = sideSign * (car.spec.width / 2 + DOOR);
    return out.set(p.x + Math.cos(h) * out2 + Math.sin(h) * along, car.ground, p.z - Math.sin(h) * out2 + Math.cos(h) * along);
  }

  private clear(at: THREE.Vector3, car: CarRef) {
    let clear = true;
    this.world.intersectionsWithShape({ x: at.x, y: at.y + 0.95, z: at.z }, NO_TURN, this.room, () => (clear = false), undefined, STRIKE_GROUPS, undefined, car.body);
    return clear;
  }

  /** Out of the car, on the driver's side if there is room there. False if the player stays in. */
  exit() {
    const car = this.car, figure = this.self;
    if (!car || this.onFoot) return false;
    if (!figure) {
      this.hooks.say('One moment…');
      return false;
    }
    // the side the wheel is on; off a bike, to the left, as everyone gets off one
    const side = car.bike || car.spec.cockpitCamera[0] >= 0 ? 1 : -1;
    const at = [side, -side].map((s) => this.door(car, s, new THREE.Vector3())).find((p) => this.clear(p, car));
    if (!at) {
      this.hooks.say('No room to get out here');
      return false;
    }
    this.scene.add(figure.group);
    this.player.spawn(figure, at.x, at.y, at.z, car.heading);
    this.player.stepOut();
    this.player.toughness = 1.6;
    this.player.gun = this.weapon ? GUNS[this.weapon] : null;
    this.showGun();
    this.onFoot = true;
    this.outCold = 0;
    this.carHits = 0;
    return true;
  }

  /** Whether the player is on their feet and near enough to the car to get in. */
  get canEnter() {
    const car = this.car, p = this.player.pos;
    if (!car || !this.onFoot || this.player.state !== 'move') return false;
    // measured to the car's side, not its middle: a car is long
    const c = car.body.translation(), dx = p.x - c.x, dz = p.z - c.z, h = car.heading;
    const along = dx * Math.sin(h) + dz * Math.cos(h), across = dx * Math.cos(h) - dz * Math.sin(h);
    return Math.abs(along) < car.spec.length / 2 + 0.4 && Math.abs(across) < car.spec.width / 2 + REACH;
  }

  /**
   * Back in the car: a few steps to the door first, then in (hooks.entered). The stick, if in hand, goes back on
   * the boot on the way. False if they cannot get in from here.
   */
  enter() {
    if (!this.canEnter || this.entering >= 0 || !this.car) return false;
    const car = this.car, side = car.bike || car.spec.cockpitCamera[0] >= 0 ? 1 : -1;
    // the nearer door
    const a = this.door(car, side, new THREE.Vector3()), b = this.door(car, -side, new THREE.Vector3()), p = this.player.pos;
    this.doorAt.copy(Math.hypot(a.x - p.x, a.z - p.z) <= Math.hypot(b.x - p.x, b.z - p.z) ? a : b);
    this.entering = 0;
    return true;
  }

  private getIn() {
    this.entering = -1;
    if (this.player.armed) this.stick.toCar();
    this.player.despawn()?.group.removeFromParent();
    this.onFoot = false;
    this.armoury.show(null);
    this.hooks.entered();
  }

  /** How fast the player is going on foot, m/s over the ground. */
  get velocity() {
    return this.player.body.on ? this.player.body.body.linvel() : { x: 0, y: 0, z: 0 };
  }

  /** Stands the player at (x, y, z): for when they have walked somewhere they cannot be. */
  putPlayer(x: number, y: number, z: number) {
    if (this.onFoot && this.player.standing) this.player.body.place(x, y, z);
  }

  /** Metres from `from` along `dir` to the first wall, car or post, for the camera to keep in front of; null if there is none within `reach`. */
  sight(from: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, reach: number) {
    this.ray.origin = from;
    this.ray.dir = dir;
    return this.world.castRay(this.ray, reach, true, undefined, SIGHT_GROUPS)?.timeOfImpact ?? null;
  }

  /** The player's punch, or swing of the stick: one after another, a combination. */
  attack() {
    if (this.onFoot && this.player.standing) this.player.attack('punch');
  }

  /** The player's kick: a front kick, a roundhouse straight after, or a stamp on someone down. */
  kick() {
    if (this.onFoot && this.player.standing) this.player.attack('kick');
  }

  /** The player ducks or steps out of the way: along the way they are pushing (relative to `look`), or back. */
  dodge(input: FootInput, look: number) {
    if (!this.onFoot || !this.player.standing) return;
    const fx = Math.sin(look), fz = Math.cos(look);
    this.player.dodge(fx * input.y - fz * input.x, fz * input.y + fx * input.x);
  }

  /** The player's "use" key: takes the stick off the boot or up off the ground, or puts it back. */
  interact() {
    const me = this.player;
    if (!this.onFoot || me.state !== 'move') return;
    if (me.armed) {
      const home = this.stick.home(_p);
      if (home && Math.hypot(home.x - me.pos.x, home.z - me.pos.z) < 1.9) {
        me.armed = false;
        this.stick.toCar();
      } else this.hooks.say(home ? 'The stick goes back on the boot of the car' : 'Nowhere on this to keep a stick');
      return;
    }
    const at = this.stick.place(_p);
    if (at && Math.hypot(at.x - me.pos.x, at.z - me.pos.z) < 1.9) {
      me.armed = true;
      this.stick.toHand();
    }
  }

  /** Fists (null) or a rifle in the player's hands. The stick goes back on the boot first. */
  equip(name: GunName | null) {
    const me = this.player;
    if (!this.onFoot || !me.standing || name === this.weapon) return;
    if (name && me.armed) {
      me.armed = false;
      this.stick.toCar();
    }
    this.weapon = name;
    this.reloading = 0;
    me.gun = name ? GUNS[name] : null;
    me.reloading = 0;
    this.showGun();
    this.hooks.sound('draw', 0.5, 0);
    this.hooks.say(name ? GUNS[name].label : 'Fists');
  }

  reload() {
    const name = this.weapon;
    if (!name || !this.onFoot || this.reloading > 0 || this.rounds[name] === GUNS[name].mag) return;
    this.reloading = GUNS[name].reload;
    this.hooks.sound(`reload-${name}`, 1, 0);
    this.showGun();
  }

  private showGun() {
    const on = this.onFoot && this.weapon && this.player.standing ? this.weapon : null;
    this.armoury.show(on, on ? this.rounds[on] : 0, this.reloading > 0);
  }

  /**
   * Every frame on foot: the trigger (`held`), and the line the camera looks along from `from` in `dir`, which is
   * where the rounds go. Automatic: held down, it keeps firing at the rifle's rate.
   */
  trigger(held: boolean, from: THREE.Vector3, dir: THREE.Vector3, dt: number) {
    const name = this.weapon, me = this.player;
    // the rifle is at the shoulder, not at the camera: it points at what the camera's line comes to, a way off
    me.aim.copy(from).addScaledVector(dir, 40).sub(_p.copy(me.pos).setY(me.pos.y + 1.45)).normalize();
    this.cooldown -= dt;
    if (this.reloading > 0 && (this.reloading -= dt) <= 0) {
      this.rounds[name!] = GUNS[name!].mag;
      this.showGun();
    }
    me.reloading = name && this.reloading > 0 ? clamp(1 - this.reloading / GUNS[name].reload, 0.001, 1) : 0;
    if (held) me.raise = 0.9;
    const pressed = held && !this.wasHeld;
    this.wasHeld = held;
    if (!name || !this.onFoot || !me.standing || me.state !== 'move' || !held || this.cooldown > 0 || this.reloading > 0) return;
    if (this.rounds[name] <= 0) {
      if (pressed) this.hooks.sound('click', 1, 0);
      this.reload();
      return;
    }
    this.rounds[name]--;
    this.cooldown = GUNS[name].interval;
    this.shoot(from, dir, GUNS[name]);
    this.showGun();
  }

  private shoot(from: THREE.Vector3, dir: THREE.Vector3, gun: (typeof GUNS)[GunName]) {
    const me = this.player;
    const line = _line.copy(dir).add(_j.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(gun.spread * 2)).normalize();
    this.ray.origin = from;
    this.ray.dir = line;
    const hit = this.world.castRay(this.ray, 150, true, undefined, STRIKE_GROUPS, undefined, me.body.body);
    let dist = hit?.timeOfImpact ?? 150;
    // the road is not something a fist lands on, so the ray goes through it: stop it there
    if (line.y < -1e-3) dist = Math.min(dist, (me.pos.y + 0.03 - from.y) / line.y);
    // someone walking past in the way, first
    let walker: Walker | null = null;
    for (let d = 1.5; d < dist; d += 0.3) {
      _p.copy(from).addScaledVector(line, d);
      walker = this.people.strikeAt(_p.x, _p.y - me.pos.y, _p.z, 0.02);
      if (walker) {
        dist = d;
        break;
      }
    }
    const at = _hit.copy(from).addScaledVector(line, dist), away = this.distance(at.x, at.z);
    let target: Fighter | null = null;
    if (walker) {
      target = this.promote(walker);
      if (!target) this.people.knock(walker, line.x * 3, line.z * 3);
    } else if (hit) {
      const body = hit.collider.parent();
      target = this.owner.get(body?.handle ?? -1) ?? null;
      if (!target) {
        this.hooks.sound('ricochet', 1, away);
        // dust knocked off whatever it hit
        this.blood.puff(at, 0.45, 0.5, 0x9a9388, 0.5);
        if (body?.isDynamic()) {
          body.applyImpulseAtPoint(_j.copy(line).multiplyScalar(gun.push * 3), at, true);
          this.traffic.provoke(body);
        }
      }
    }
    if (target && target !== me) this.shot(target, at, line, gun);
    else if (!hit && !walker && dist < 150) {
      // into the road
      this.hooks.sound('ricochet', 0.6, away);
      this.blood.puff(at, 0.4, 0.5, 0x8a857c, 0.45);
    }
    this.armoury.fired(this.muzzle, _j.copy(at).sub(this.muzzle).normalize(), at);
    // a wisp of smoke off the muzzle with every other round
    if (this.rounds[gun.name] % 2) this.blood.puff(_p.copy(this.muzzle).addScaledVector(_j, 0.15), 0.3, 0.45, 0xc8c4bc, 0.22);
    this.hooks.sound(gun.name, 1, 0);
    me.kick = 1;
    this.hooks.recoil(gun.climb * (0.8 + Math.random() * 0.4), (Math.random() - 0.5) * gun.climb * 0.8);
    this.hooks.shake(0.015);
    this.hooks.rumble(0.25, 50);
    // gunfire: the street runs, and nobody comes to fight it out. Some of them scream as they go, each in their own moment.
    for (const w of this.people.scare(me.pos.x, me.pos.z, 45, () => false)) {
      if (this.cries.length < 5 && Math.random() < 0.45) this.cries.push({ wait: 0.15 + Math.random() * 1.2, x: w.x, z: w.z, voice: this.voiceOf(this.people.kindOf(w)[0]) });
    }
    for (const [f, npc] of this.npcs) if (f.health > 0 && this.distance(f.pos.x, f.pos.z) < 45) npc.brain.mode = 'flee';
  }

  /** A round lands on `f` at `at`, going along `line`: the head is fatal, the legs take half, and it bleeds. */
  private shot(f: Fighter, at: THREE.Vector3, line: THREE.Vector3, gun: (typeof GUNS)[GunName]) {
    const me = this.player, hips = f.figure?.hipHeight ?? 0.95;
    // where it really goes in: the skin, not the shape the physics has for them
    const skin = f.figure?.wound(_p.copy(at).addScaledVector(line, -0.5), line);
    if (skin) at.copy(skin);
    const height = (at.y - f.pos.y) / (hips / 0.95);
    const zone = !f.standing ? 'body' : height > 1.42 ? 'head' : height > 0.75 ? 'body' : 'legs';
    const alive = f.health > 0;
    f.hurt(zone === 'head' ? 500 : zone === 'legs' ? gun.damage * 0.5 : gun.damage);
    f.hitBy = me;
    const push = _j.copy(line).multiplyScalar(gun.push * (zone === 'head' ? 1.4 : 1));
    if (f.doll.active) f.doll.hit(at, push);
    else if (f.health <= 0) f.fall(at, push);
    else f.takeHit(at, push.multiplyScalar(0.6), me);
    const away = this.distance(at.x, at.z);
    this.hooks.sound('hit', zone === 'head' ? 1.4 : 1, away);
    // a red mist where it goes in, a little thrown back at whoever fired, and the most of it out of the far side
    this.blood.puff(at, zone === 'head' ? 0.6 : 0.42, 0.35);
    this.blood.spray(at, _j.copy(line).negate(), 6, f.pos.y, 0.7);
    this.blood.spray(_p.copy(at).addScaledVector(line, 0.22), _j.copy(line), zone === 'head' ? 34 : 20, f.pos.y, 1.7);
    this.blood.puff(_p, 0.5, 0.45, undefined, 0.5);
    f.bleeding = 14;
    if (alive && (f.health <= 0 || f.unhurtVoice > 0.4)) {
      f.unhurtVoice = 0;
      // a round through the head and there is no cry at all
      if (zone !== 'head') this.hooks.sound(f.health <= 0 ? 'death' : 'pain', 1.3, away, f.voice);
    }
    const npc = this.npcs.get(f);
    if (npc) npc.brain.mode = 'flee';
  }

  /** Before each physics step. */
  step(dt: number) {
    for (const f of this.fighters) if (f.on) f.step(dt);
  }

  /** After each physics step. */
  afterStep() {
    for (const f of this.fighters) {
      if (!f.on) continue;
      f.afterStep();
      if (!f.struck) continue;
      // sent flying by a car
      const away = this.distance(f.pos.x, f.pos.z);
      this.hooks.sound('body', f.struck, away);
      this.hooks.sound(f.health <= 0 ? 'death' : 'pain', 1.4, away, f.voice);
      const v = f.doll.parts[CHEST].linvel();
      this.blood.spray(_p.copy(f.pos).setY(f.pos.y + 1.1), _j.set(v.x, 0.3, v.z).normalize(), f.struck * 2.5, f.pos.y);
      if (f === this.player) {
        this.hooks.rumble(1, 400);
        this.hooks.shake(0.3);
        this.hooks.hurt(1);
      }
      this.npcs.get(f)?.brain.onHit(null);
    }
  }

  swing(by: Fighter, m: Move) {
    const away = this.distance(by.pos.x, by.pos.z);
    this.hooks.sound('swing', m.limb < 0 ? 1 : m.full ? 0.8 : 0.5, away);
    if (m.heavy && Math.random() < 0.55) this.hooks.sound('grunt', 0.7, away, by.voice);
  }

  strike(by: Fighter, m: Move, at: THREE.Vector3, radius: number, velocity: THREE.Vector3) {
    // how hard: what is behind the blow, times how fast it was really moving, plus the run-up
    const fx = Math.sin(by.yaw), fz = Math.cos(by.yaw), own = by.body.body.linvel();
    const speed = clamp(velocity.length(), m.slow, m.fast) + Math.max(0, own.x * fx + own.z * fz);
    // a stick goes where it was swinging; anything else, the way the blow is thrown
    if (m.limb < 0 && m.name === 'swing' && velocity.lengthSq() > 1) _j.copy(velocity).normalize().multiplyScalar(0.6).add(_p.set(fx, 0, fz)).setY(clamp(_j.y, -0.3, 0.15)).normalize();
    else _j.set(fx * m.dir[0] + fz * m.dir[1], m.dir[2], fz * m.dir[0] - fx * m.dir[1]).normalize();
    _j.multiplyScalar(m.mass * speed);
    const size = _j.length(), away = this.distance(at.x, at.z);

    let who: Fighter | null = null, what: RAPIER.Collider | null = null;
    this.fist.radius = radius;
    this.world.intersectionsWithShape(at, NO_TURN, this.fist, (c) => {
      const f = this.owner.get(c.parent()?.handle ?? -1);
      // whoever ducked it is not there to be hit
      if (f === by || f?.evading) return true;
      if (f) who = f;
      else what ??= c;
      return !f;
    }, undefined, STRIKE_GROUPS, undefined, by.body.body);
    let target = who as Fighter | null;
    if (!target && !what) {
      // someone on the pavement, who until now was only walking past
      const w = this.people.strikeAt(at.x, at.y - by.pos.y, at.z, radius);
      if (!w) return false;
      target = this.promote(w);
      if (!target) this.people.knock(w, (_j.x / size) * 2.5, (_j.z / size) * 2.5);
    }
    // what the blow does to the one who threw it
    by.body.body.applyImpulse({ x: -_j.x * 0.3, y: 0, z: -_j.z * 0.3 }, true);
    by.calm = 0;
    if (by === this.player) {
      this.hooks.rumble(m.limb < 0 ? 0.6 : 0.35, 90);
      this.hooks.shake(m.full || m.limb < 0 ? 0.06 : 0.03);
    }
    if (target) {
      const stood = target.standing;
      const hit = target.takeHit(at, _j, by);
      this.hooks.sound(hit.blocked ? 'block' : m.sound, size, away);
      // not a cry at every blow: someone being hit mostly takes it with a grunt of breath, and cries out at a bad one
      if (!hit.blocked && hit.damage > 4 && target.unhurtVoice > 0.5 && (hit.damage > 18 || Math.random() < 0.55)) {
        target.unhurtVoice = 0;
        this.hooks.sound(hit.damage > 18 ? 'pain' : 'grunt', Math.min(1.4, hit.damage / 18), away, target.voice);
      }
      // the picture holds a beat on a blow that really lands
      by.freeze = target.freeze = hit.blocked ? 0.03 : Math.min(0.12, 0.04 + size / 700);
      if (!hit.blocked && hit.damage > 3) {
        const gory = hit.zone === 'head' ? 1.4 : m.limb < 0 ? 1.2 : hit.zone === 'legs' ? 0.3 : 0.6;
        this.blood.spray(at, _p.copy(_j).normalize(), hit.damage * gory, target.pos.y);
        // a hard one to the head, or the stick anywhere, splits the skin
        if (hit.damage > 12 && (hit.zone === 'head' || m.limb < 0)) target.figure?.wound(_door.copy(at).addScaledVector(_p, -0.4), _p, 0.02 + Math.min(0.02, hit.damage / 1500), 0);
      }
      if (target === this.player) {
        this.hooks.rumble(clamp(size / 40, 0.3, 1), 160);
        this.hooks.shake(hit.blocked ? 0.04 : clamp(size / 200, 0.08, 0.25));
        this.hooks.hurt(hit.blocked ? 0.15 : clamp(hit.damage / 25, 0.3, 1));
      }
      if (stood && !target.standing) {
        this.hooks.sound('body', 4, away);
        if (target.health <= 0) this.hooks.sound('death', 1.4, away, target.voice);
      }
      this.npcs.get(target)?.brain.onHit(by, by !== this.player);
      this.alarm(at.x, at.z);
    } else if (what) {
      const body = (what as RAPIER.Collider).parent();
      this.hooks.sound(m.limb < 0 ? 'stick' : 'thud', size, away);
      if (body?.isDynamic()) {
        body.applyImpulseAtPoint(_j, at, true);
        if (by === this.player) this.traffic.provoke(body);
        // someone hammering on the door of the car the player is sitting in
        else if (!this.onFoot && this.car && body.handle === this.car.body.handle && ++this.carHits >= DRAG_OUT) this.dragOut(by);
      }
    } else {
      this.hooks.sound(m.limb < 0 ? 'stick' : m.sound, size, away);
      this.alarm(at.x, at.z);
    }
    return true;
  }

  /** Had out of the car by `by`, if it is standing still: thrown down on the road beside it. */
  private dragOut(by: Fighter) {
    const car = this.car;
    this.carHits = 0;
    if (!car || Math.hypot(car.body.linvel().x, car.body.linvel().z) > 1.5 || !this.exit()) return;
    this.hooks.pulledOut();
    this.hooks.say('Dragged out of the car!');
    const me = this.player, dx = me.pos.x - by.pos.x, dz = me.pos.z - by.pos.z, d = Math.hypot(dx, dz) || 1;
    me.body.body.setLinvel({ x: (dx / d) * 3, y: 1, z: (dz / d) * 3 }, true);
    me.hurt(10);
    me.fall();
    this.hooks.shake(0.25);
  }

  /** A fight at (x, z): the people round about take it each in their own way, and the boldest wade in. */
  private alarm(x: number, z: number) {
    if (this.scared > 0) return;
    this.scared = 1.5;
    this.people.scare(x, z, 12, (w) => !!this.promote(w, true));
  }

  /** Someone off the pavement becomes someone who can fight and fall; null if there is no room for another. */
  private promote(w: Walker, hostile = false) {
    const slot = this.free();
    if (!slot) return null;
    const [file, height] = this.people.kindOf(w), figure = this.figureFor(file, height);
    if (!figure) return null;
    this.people.take(w);
    figure.dress(w.top, w.bottom);
    slot.spawn(figure, w.x, 0, w.z, w.yaw);
    slot.voice = this.voiceOf(file);
    const brain = new Brain(w.nerve);
    if (hostile) brain.target = this.player;
    this.npcs.set(slot, { brain, walker: w, file, out: 0 });
    return slot;
  }

  /** The player's car has hit `w` at (vx, vz) m/s: thrown for real, if there is a body free to throw. */
  private runDown(w: Walker, vx: number, vz: number) {
    const slot = this.free(), car = this.car;
    if (!slot || !car) return false;
    const [file, height] = this.people.kindOf(w), figure = this.figureFor(file, height);
    if (!figure) return false;
    figure.dress(w.top, w.bottom);
    // set down just clear of the bumper that hit them, already moving with it: the car and the road do the rest
    const speed = Math.hypot(vx, vz), dx = vx / speed, dz = vz / speed, c = car.body.translation();
    const across = clamp((w.x - c.x) * dz - (w.z - c.z) * dx, -car.spec.width / 2, car.spec.width / 2);
    const ahead = car.spec.length / 2 + 0.4;
    slot.spawnDown(figure, c.x + dx * ahead + dz * across, car.ground, c.z + dz * ahead - dx * across, w.yaw, { x: vx * 1.1, y: Math.min(3, speed * 0.25), z: vz * 1.1 });
    slot.hurt(speed * speed * 0.35);
    slot.voice = this.voiceOf(file);
    this.hooks.sound(slot.health <= 0 ? 'death' : 'scream', 1.4, 0, slot.voice);
    this.blood.spray(_p.set(w.x, 1.1, w.z), _j.set(dx, 0.4, dz).normalize(), speed * 3, car.ground);
    const brain = new Brain(w.nerve);
    brain.onHit(null);
    this.npcs.set(slot, { brain, walker: w, file, out: 0 });
    this.hooks.sound('body', speed, 0);
    return true;
  }

  /** Done with: back to being one of the crowd, walking off or still running. */
  private release(f: Fighter, running: boolean) {
    const npc = this.npcs.get(f);
    const { x, z } = f.pos, yaw = f.yaw;
    this.putBack(f.despawn());
    this.npcs.delete(f);
    if (!npc) return;
    const from = running ? this.where(_p) : undefined;
    if (npc.walker) this.people.give(npc.walker, x, z, yaw, from);
    else this.people.adopt(npc.file, x, z, yaw, from);
  }

  /** A body taken away: the figure back on the shelf, and whoever they were gone from the street for good. */
  private bury(f: Fighter) {
    const npc = this.npcs.get(f);
    this.putBack(f.despawn());
    this.npcs.delete(f);
    if (npc?.walker) this.people.forget(npc.walker);
  }

  /** A driver whose car the player has hit gets out, once it has stopped. */
  private drivers(dt: number) {
    this.angry = this.angry.filter((a) => {
      const p = a.body.translation(), v = a.body.linvel(), q = a.body.rotation();
      if ((a.wait -= dt) < -8 || !a.body.isEnabled() || this.distance(p.x, p.z) > 45) return false;
      const upright = 1 - 2 * (q.x * q.x + q.z * q.z) > 0.9;
      if (a.wait > 0 || Math.hypot(v.x, v.z) > 1.5 || !upright) return true;
      const men = DRIVERS.filter((f) => this.sources.has(f));
      const slot = this.free(), file = men[Math.floor(Math.random() * men.length)] ?? PLAYER;
      if (!slot || !this.sources.has(file) || !a.leave()) return false;
      // out of the right-hand door: the wheel is on the right here
      const h = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)), out = a.width / 2 + DOOR;
      slot.spawn(this.figureFor(file, 1.7 + Math.random() * 0.08)!, p.x - Math.cos(h) * out, Math.max(0, p.y), p.z + Math.sin(h) * out, h);
      slot.voice = this.voiceOf(file);
      // and has something to say about it
      this.hooks.sound('grunt', 1.2, this.distance(p.x, p.z), slot.voice);
      const brain = new Brain(0.45 + Math.random() * 0.55);
      brain.target = this.player;
      this.npcs.set(slot, { brain, walker: null, file, out: 0 });
      return false;
    });
  }

  /**
   * Every frame. `input` is what the player's hands are doing and `look` the way the camera faces, both only
   * used on foot; `blend` is how far between two physics steps the picture is.
   */
  update(dt: number, blend: number, input: FootInput, look: number) {
    const me = this.player, car = this.car;
    this.scared -= dt;
    this.prompt = '';
    this.cries = this.cries.filter((c) => {
      if ((c.wait -= dt) > 0) return true;
      this.hooks.sound('scream', 1, this.distance(c.x, c.z), c.voice);
      return false;
    });
    if (dt > 0) this.drivers(dt);

    if (this.onFoot && dt > 0) {
      // the player: the way they push is taken from the way they are looking
      const fx = Math.sin(look), fz = Math.cos(look);
      let mx = fx * input.y - fz * input.x, mz = fz * input.y + fx * input.x;
      const push = Math.hypot(mx, mz), pace = input.sprint ? SPRINT : push < 0.55 ? WALK : JOG;
      if (push > 1) [mx, mz] = [mx / push, mz / push];
      const it = me.intent;
      it.vx = push > 0.1 ? (mx / Math.min(1, push)) * pace : 0;
      it.vz = push > 0.1 ? (mz / Math.min(1, push)) * pace : 0;
      if (this.entering >= 0) {
        // walking to the door, whatever the hands are doing; in once there, or after a moment however near
        this.entering += dt;
        const dx = this.doorAt.x - me.pos.x, dz = this.doorAt.z - me.pos.z, d = Math.hypot(dx, dz);
        if (d < 0.3 || this.entering > 0.7 || !me.standing) this.getIn();
        else [it.vx, it.vz] = [(dx / d) * Math.min(JOG, d * 6), (dz / d) * Math.min(JOG, d * 6)];
      }
      it.block = input.block;
      // squared up, they face whoever is nearest in front of them, or else where they are looking
      it.face = null;
      if (input.block || me.state !== 'move' || me.calm < 2.5) {
        let best = 2.6;
        it.face = look;
        for (const f of this.fighters) {
          if (f === me || !f.on) continue;
          // someone on the ground only when nobody is standing to be squared up to
          const dx = f.pos.x - me.pos.x, dz = f.pos.z - me.pos.z, d = Math.hypot(dx, dz) + (f.standing ? 0 : 1.2);
          if (d < best && Math.abs(wrap(Math.atan2(dx, dz) - look)) < 1.2) [best, it.face] = [d, Math.atan2(dx, dz)];
        }
      }
      // a rifle points where the camera looks, so the body does too
      if (this.weapon) it.face = look;
      if (me.unhurt > 6 && me.health > 0) me.health = Math.min(100, me.health + 4 * dt);

      // knocked down with the stick in hand: it goes its own way
      if (me.state === 'down' && me.armed) {
        me.armed = false;
        this.stick.drop({ x: Math.sin(me.yaw) * 2, y: 2, z: Math.cos(me.yaw) * 2 });
      }
      // knocked out: the screen goes dark, and they come round beside the car
      if (me.state === 'down' && me.health <= 0) {
        this.outCold += dt;
        if (this.outCold > 2.2 && !this.dark) this.hooks.fade((this.dark = true));
        if (this.outCold > 3.3 && car) this.comeRound(car);
      }
    }

    // a kick is a stamp for whoever has someone lying just in front of them, a knee for whoever has someone right up against them
    for (const f of this.fighters) {
      if (!f.on || !f.standing) continue;
      f.close = this.fighters.some((o) => {
        if (o === f || !o.on || !o.standing) return false;
        const dx = o.pos.x - f.pos.x, dz = o.pos.z - f.pos.z, d = Math.hypot(dx, dz);
        return d < 0.95 && (dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw)) / d > 0.6;
      });
      f.stompable = this.fighters.some((o) => {
        if (o === f || !o.on || o.state !== 'down') return false;
        const head = o.doll.parts[CHEST].translation(), dx = head.x - f.pos.x, dz = head.z - f.pos.z, d = Math.hypot(dx, dz);
        return d < 1.4 && (dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw)) / d > 0.4;
      });
    }
    // blood: a pool under anyone out cold, and drips from anyone badly hurt
    this.drips -= dt;
    for (const f of this.fighters) {
      if (!f.on) continue;
      if (f.bleeding > 0) f.bleeding -= dt;
      if (f.state === 'down' && f.health <= 0 && !f.pooled && f.doll.speed < 0.4 && f.t > 1) {
        f.pooled = true;
        // from the head of someone beaten down, from the body of someone shot, and more of it
        const shot = f.bleeding > 0, h = f.doll.parts[shot ? CHEST : HEAD].translation();
        this.blood.pool(h.x, h.z, Math.max(0, f.pos.y), shot ? 0.45 + Math.random() * 0.3 : 0.28 + Math.random() * 0.2);
      } else if (f.standing && this.drips <= 0 && (f.bleeding > 0 ? Math.random() < 0.8 : f.health < 45 && Math.random() < 0.3)) {
        this.blood.drip(_door.copy(f.pos).setY(f.pos.y + (f.bleeding > 0 ? 1.1 : 1.45)), f.pos.y);
      }
    }
    if (this.drips <= 0) this.drips = 0.35;
    this.blood.update(dt);

    // everyone else
    // at the wheel, the player is got at through the driver's door
    const p = this.onFoot || !car ? this.where(_p) : this.door(car, car.bike || car.spec.cockpitCamera[0] >= 0 ? 1 : -1, _p);
    const c = car?.group.position ?? p;
    const scene = { player: me, x: p.x, z: p.z, onFoot: this.onFoot, cx: c.x, cz: c.z };
    for (const [f, npc] of this.npcs) {
      const away = Math.hypot(f.pos.x - p.x, f.pos.z - p.z);
      const dead = f.state === 'down' && f.health <= 0;
      if (dead && dt > 0) npc.out += dt;
      // The dead stay dead. The body lies where it fell for a while, then it and the blood round it are taken away:
      // sooner once the player has walked off, and never while they stand over it.
      if (dead && ((npc.out > 20 && away > 25) || npc.out > 60 || away > 75)) {
        this.blood.clean(f.pos.x, f.pos.z, 3);
        this.bury(f);
        continue;
      }
      if (away > 75) {
        this.release(f, false);
        continue;
      }
      if (dt > 0 && f.standing && npc.brain.think(f, dt, scene) && f.state === 'move') {
        this.release(f, npc.brain.mode === 'flee');
        continue;
      }
      f.update(dt, blend, this);
    }
    if (me.on) {
      me.update(dt, blend, this);
      if (me.armed) this.stick.hold(me.hand, me.stickDir);
      // the rifle at the shoulder, put away while they are down
      const shown = this.onFoot && !!this.weapon && me.standing;
      if (shown !== this.armoury.group.visible) {
        this.armoury.group.visible = shown;
        this.showGun();
      }
      if (shown) this.armoury.hold(me.gunAt, me.gunTurn, me.magOut, this.muzzle);
    }
    this.armoury.update(dt);
    this.stick.update();

    this.obstacles.length = 0;
    for (const f of this.fighters) if (f.on && f !== me) this.obstacles.push({ x: f.pos.x, z: f.pos.z });
    if (this.onFoot && car) {
      // the car left standing in the road: its nose, its middle and its tail
      const c = car.group.position, hx = (Math.sin(car.heading) * car.spec.length) / 3, hz = (Math.cos(car.heading) * car.spec.length) / 3;
      for (const k of [-1, 0, 1]) this.obstacles.push({ x: c.x + hx * k, z: c.z + hz * k });

      const at = me.armed ? this.stick.home(_door) : this.stick.place(_door);
      if (me.state !== 'move') this.prompt = '';
      else if (at && Math.hypot(at.x - me.pos.x, at.z - me.pos.z) < 1.9) this.prompt = me.armed ? 'E|put the stick back' : this.stick.where === 'ground' ? 'E|pick up the stick' : 'E|take the hockey stick';
      else if (this.canEnter) this.prompt = 'F|get in';
    }
  }

  /** Knocked out, and brought round beside the car with nobody left who wants a fight. */
  private comeRound(car: CarRef) {
    const me = this.player, figure = this.self!;
    const side = car.bike || car.spec.cockpitCamera[0] >= 0 ? 1 : -1;
    const at = [side, -side].map((s) => this.door(car, s, new THREE.Vector3())).find((p) => this.clear(p, car)) ?? this.door(car, side, new THREE.Vector3());
    me.spawn(figure, at.x, at.y, at.z, car.heading);
    for (const npc of this.npcs.values()) if (npc.brain.mode === 'fight') npc.brain.mode = 'leave';
    // a stick dropped far off is not gone for good
    const lying = this.stick.place(_p);
    if (this.stick.where === 'ground' && lying && Math.hypot(lying.x - at.x, lying.z - at.z) > 20) this.stick.toCar();
    this.outCold = 0;
    this.hooks.fade((this.dark = false));
    this.hooks.say('Knocked out');
  }
}
