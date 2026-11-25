import { type Fighter, type MoveName, wrap } from './fighter.ts';

/** What an NPC on foot makes of things each frame. */
export interface Scene {
  player: Fighter;
  /** where the player is: on foot, or their car when they are in it */
  x: number;
  z: number;
  onFoot: boolean;
  /** the middle of the player's car: what is hammered on while they sit in it */
  cx: number;
  cz: number;
}

/** metres between two people at which a punch lands, and a kick */
const REACH = 0.92, KICK = 1.3;
/** what they throw to open with, and how often: mostly jabs and crosses, as in any street fight */
const OPENERS: [MoveName | 'punch' | 'kick', number][] = [['jab', 0.3], ['cross', 0.25], ['hook', 0.17], ['uppercut', 0.08], ['kick', 0.2]];

/**
 * The head of someone the player has fallen out with. They close in, circle, and throw combinations when in
 * reach (the bold more, and longer ones); they see a blow coming and cover up, duck or step back; they give
 * ground for a moment after taking a good one and come again; and the boldest put the boot in on a player who is
 * down. Badly hurt, all but the boldest run. They lose interest in a player who is out cold, gone, or driven off.
 */
export class Brain {
  mode: 'fight' | 'flee' | 'leave';
  target: Fighter | null = null;
  /** 0 to 1 */
  readonly nerve: number;
  private cool = 0.5;
  private combo = 0;
  private side = Math.random() < 0.5 ? 1 : -1;
  private sideTime = 0;
  private guard = 0;
  private back = 0;
  private saw = false;
  private bored = 0;
  private running = 0;
  private stamps = 0;

  constructor(nerve: number, mode: Brain['mode'] = 'fight') {
    this.nerve = nerve;
    this.mode = mode;
  }

  /**
   * Hit by `by` (or by a car, null): most turn on whoever it was, the timid run. A `stray` blow, from someone
   * else in the same scrap, does not change who they are after.
   */
  onHit(by: Fighter | null, stray = false) {
    if (this.nerve > 0.28 && this.mode !== 'flee') {
      [this.mode, this.target, this.bored] = ['fight', stray && this.target ? this.target : by ?? this.target, 0];
      // stung: a step back, unless they are the kind who walk through it
      if (Math.random() > this.nerve) this.back = 0.35 + Math.random() * 0.4;
      this.cool = Math.min(this.cool, 0.25 + Math.random() * 0.3);
    } else this.mode = 'flee';
  }

  private opener(): MoveName | 'punch' | 'kick' {
    let r = Math.random();
    for (const [m, w] of OPENERS) if ((r -= w) < 0) return m;
    return 'jab';
  }

  /** Sets what `f` is trying to do this frame. True when they are done with all this and want to be on their way. */
  think(f: Fighter, dt: number, scene: Scene) {
    const it = f.intent;
    it.vx = it.vz = 0;
    it.block = false;
    it.face = null;
    const foe = this.target?.on ? this.target : scene.player.on ? scene.player : null;
    const tx = foe ? foe.pos.x : scene.x, tz = foe ? foe.pos.z : scene.z;
    const dx = tx - f.pos.x, dz = tz - f.pos.z, d = Math.hypot(dx, dz) || 1;
    if (this.mode === 'leave') return true;
    if (this.mode === 'flee') {
      this.running += dt;
      it.vx = (-dx / d) * 4.6;
      it.vz = (-dz / d) * 4.6;
      return this.running > 7 || d > 35;
    }
    if (f.health < 25 && this.nerve < 0.8) {
      this.mode = 'flee';
      return false;
    }
    if (d > 40) return true;
    const go = (speed: number, along = 1, across = 0) => {
      it.vx = (dx / d) * speed * along + (dz / d) * speed * across;
      it.vz = (dz / d) * speed * along - (dx / d) * speed * across;
    };
    it.face = Math.atan2(dx, dz);
    f.calm = Math.min(f.calm, d < 6 ? 0.5 : f.calm);

    if (!foe) {
      // the player is sitting in their car: up to the driver's door (where (x, z) is), fists and boots on it, and after a while, away
      this.bored += dt;
      if (d > 0.45) go(d > 6 ? 3.6 : 1.8);
      else {
        it.face = Math.atan2(scene.cx - f.pos.x, scene.cz - f.pos.z);
        f.calm = 0;
      }
      // a car's roof is below a punch to the head: mostly it is the boot that goes into the door
      if (d <= 0.6 && (this.cool -= dt) <= 0 && f.state === 'move') {
        f.attack(Math.random() < 0.7 ? 'kick' : 'hook');
        this.cool = 0.5 + Math.random() * 0.8;
      }
      return this.bored > 14;
    }
    if (!foe.standing) {
      // the bold put the boot in, once or twice; the rest stand over him, and go once it is clear he is staying down
      this.bored += foe.health <= 0 ? dt : dt * 0.25;
      if (this.nerve > 0.6 && this.stamps < 2 && foe.state === 'down') {
        if (d > 0.95) go(1.6);
        else if ((this.cool -= dt) <= 0 && f.state === 'move' && f.stompable) {
          f.attack('kick');
          this.stamps++;
          this.cool = 0.9 + Math.random();
        }
      } else if (d > 2.2) go(1.6);
      else if (d < 1.5) go(-1);
      return this.bored > 4;
    }
    this.bored = 0;
    this.stamps = 0;

    // a blow on its way: the quick and the bold see it in time, and cover up or get out of the way
    const coming = foe.threatening && d < 1.9 && Math.abs(wrap(foe.yaw - Math.atan2(-dx, -dz))) < 0.9;
    if (coming && !this.saw && f.state === 'move') {
      const r = Math.random();
      if (r < 0.2 + 0.35 * this.nerve) this.guard = 0.45;
      else if (r < 0.35 + 0.4 * this.nerve) f.dodge(-dx + (Math.random() - 0.5) * 2 * dz, -dz - (Math.random() - 0.5) * 2 * dx);
    }
    this.saw = coming;

    // in and out of reach, round to one side, and back off for a moment when stung
    if ((this.sideTime -= dt) <= 0) [this.side, this.sideTime] = [Math.random() < 0.5 ? 1 : -1, 0.8 + Math.random() * 1.8];
    if ((this.back -= dt) > 0) go(-1.8, 1, this.side * 0.5);
    else if (d > REACH - 0.05) go(d > 3 ? 3.6 : d > KICK + 0.3 ? 2.2 : 1.4);
    else if (d < 0.62) go(-1.2);
    else go(0.6, 0, this.side);

    if ((this.guard -= dt) > 0) it.block = true;
    else if ((this.cool -= dt) <= 0 && f.state === 'move' && this.back <= 0) {
      if (d < REACH + 0.08) {
        // a combination: the bold throw more in a row
        f.attack(this.combo > 0 ? 'punch' : this.opener());
        if (this.combo <= 0) this.combo = Math.floor(Math.random() * (1 + this.nerve * 3));
        else this.combo--;
        this.cool = this.combo > 0 ? 0.08 : 0.55 + Math.random() * (1.4 - this.nerve * 0.7);
      } else if (d < KICK && Math.random() < 0.5) {
        f.attack('kick');
        this.cool = 0.7 + Math.random() * 0.8;
      } else this.cool = 0.15;
    }
    return false;
  }
}
