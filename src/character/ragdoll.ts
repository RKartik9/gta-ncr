import RAPIER from '@dimforge/rapier3d-compat';
import { FIGHTER_GROUPS, RAGDOLL_GROUPS } from '../world/physics.ts';

// The bodies of people on foot. Nothing here draws anything, so it runs headless (tools/dev/fight-check.ts).
// Every body is made once and switched on and off: taking a body out of a loaded city costs seconds (see addProps).

type Vec = { x: number; y: number; z: number };

/** kilograms, and metres: the build of the man everyone's body is taken to be */
export const BODY_MASS = 75, BODY_RADIUS = 0.27, BODY_HEIGHT = 1.75;
/** where bodies wait while nobody is using them */
const PARK = -60;

/**
 * Someone on their feet: an upright capsule that cannot tip, standing on its origin. It is pushed towards the
 * speed its legs want, never harder than feet can push on the ground, and not at all in the air.
 */
export class CharacterBody {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  grounded = false;
  /** the velocity it was left with after its own push: anything else after the step is something having hit it */
  private sent: Vec = { x: 0, y: 0, z: 0 };
  private world: RAPIER.World;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(world: RAPIER.World) {
    this.world = world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, PARK, 0).lockRotations().setCanSleep(false).setCcdEnabled(true));
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(BODY_HEIGHT / 2 - BODY_RADIUS, BODY_RADIUS).setTranslation(0, BODY_HEIGHT / 2, 0)
        .setMass(BODY_MASS).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0).setCollisionGroups(FIGHTER_GROUPS),
      this.body,
    );
    this.body.setEnabled(false);
  }

  get on() {
    return this.body.isEnabled();
  }

  place(x: number, y: number, z: number, vel: Vec = { x: 0, y: 0, z: 0 }) {
    this.body.setEnabled(true);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel(vel, true);
    this.sent = { ...vel };
  }

  remove() {
    if (!this.on) return;
    this.body.setTranslation({ x: 0, y: PARK, z: 0 }, false);
    this.body.setEnabled(false);
  }

  /** Before each physics step: push towards (vx, vz) m/s over the ground, by no more than `accel` m/s². */
  drive(vx: number, vz: number, dt: number, accel = 12) {
    const v = this.body.linvel(), t = this.body.translation();
    this.ray.origin = { x: t.x, y: t.y + 0.3, z: t.z };
    this.grounded = !!this.world.castRay(this.ray, 0.45, true, undefined, undefined, undefined, this.body);
    if (this.grounded) {
      let dx = vx - v.x, dz = vz - v.z;
      const d = Math.hypot(dx, dz), most = accel * dt;
      if (d > most) [dx, dz] = [(dx * most) / d, (dz * most) / d];
      this.body.applyImpulse({ x: dx * BODY_MASS, y: 0, z: dz * BODY_MASS }, true);
    }
    const now = this.body.linvel();
    this.sent = { x: now.x, y: now.y, z: now.z };
  }

  /** After the step: m/s by which something else changed its velocity, when that left it moving (a car, not a wall). */
  jolt() {
    const v = this.body.linvel();
    if (Math.hypot(v.x, v.z) < 2.5) return 0;
    return Math.hypot(v.x - this.sent.x, v.z - this.sent.z);
  }
}

export const PELVIS = 0, CHEST = 1, HEAD = 2, ARM_L = 3, FORE_L = 4, ARM_R = 5, FORE_R = 6, THIGH_L = 7, SHIN_L = 8, THIGH_R = 9, SHIN_R = 10;

interface Part {
  /** where its body's origin is on a man standing with his feet at the origin: x to his left, z the way he faces */
  at: [number, number, number];
  /** share of the body's weight (Dempster's figures) */
  share: number;
  shape: () => RAPIER.ColliderDesc;
}

const limb = (half: number, r: number) => () => RAPIER.ColliderDesc.capsule(half, r);
const SHOULDER = 0.2, HIP = 0.09;
const PARTS: Part[] = [
  { at: [0, 0.95, 0], share: 0.142, shape: () => RAPIER.ColliderDesc.cuboid(0.15, 0.09, 0.1).setTranslation(0, 0.04, 0) },
  { at: [0, 1.28, 0], share: 0.355, shape: () => RAPIER.ColliderDesc.cuboid(0.16, 0.18, 0.11) },
  { at: [0, 1.61, 0], share: 0.081, shape: () => RAPIER.ColliderDesc.ball(0.11) },
  { at: [SHOULDER, 1.27, 0], share: 0.028, shape: limb(0.09, 0.045) },
  { at: [SHOULDER, 0.97, 0], share: 0.022, shape: limb(0.125, 0.04) },
  { at: [-SHOULDER, 1.27, 0], share: 0.028, shape: limb(0.09, 0.045) },
  { at: [-SHOULDER, 0.97, 0], share: 0.022, shape: limb(0.125, 0.04) },
  { at: [HIP, 0.715, 0], share: 0.1, shape: limb(0.145, 0.07) },
  { at: [HIP, 0.25, 0], share: 0.061, shape: limb(0.19, 0.055) },
  { at: [-HIP, 0.715, 0], share: 0.1, shape: limb(0.145, 0.07) },
  { at: [-HIP, 0.25, 0], share: 0.061, shape: limb(0.19, 0.055) },
];

type Range = [number, number];
interface Link {
  a: number;
  b: number;
  at: [number, number, number];
  /** a hinge about the body's left-right axis, with how far it bends each way (radians; positive swings what hangs below it backwards) */
  hinge?: Range;
  /** a ball joint (which every joint that is not a hinge is): how far it turns about the left-right, the upright and the fore-aft axis */
  ball?: [Range, Range, Range];
}
// Rotation about x (to the left): positive takes what hangs down backwards, and what stands up forwards.
// About z (forwards): positive lifts the left arm or leg out sideways, so the right side's range is mirrored.
const side = (s: number, lo: number, hi: number): Range => (s > 0 ? [lo, hi] : [-hi, -lo]);
const LINKS: Link[] = [
  { a: PELVIS, b: CHEST, at: [0, 1.08, 0], ball: [[-0.3, 0.8], [-0.4, 0.4], [-0.3, 0.3]] },
  { a: CHEST, b: HEAD, at: [0, 1.48, 0], ball: [[-0.5, 0.6], [-0.7, 0.7], [-0.4, 0.4]] },
  ...[1, -1].flatMap((s): Link[] => {
    const arm = s > 0 ? ARM_L : ARM_R, thigh = s > 0 ? THIGH_L : THIGH_R;
    return [
      // A shoulder turns nearly every way, and limits that wide on three axes at once set the arm twitching: it is left free,
      // held only by its muscle.
      { a: CHEST, b: arm, at: [s * SHOULDER, 1.4, 0] },
      { a: arm, b: arm + 1, at: [s * SHOULDER, 1.14, 0], hinge: [-2.4, 0] },
      { a: PELVIS, b: thigh, at: [s * HIP, 0.93, 0], ball: [[-1.7, 0.45], [-0.4, 0.4], side(s, -0.2, 0.7)] },
      { a: thigh, b: thigh + 1, at: [s * HIP, 0.5, 0], hinge: [0, 2.3] },
    ];
  }),
];

const sub = (p: [number, number, number], o: [number, number, number]): Vec => ({ x: p[0] - o[0], y: p[1] - o[1], z: p[2] - o[2] });

/**
 * Someone knocked off their feet: eleven weighted pieces (pelvis, chest, head, two pieces to each limb) joined at
 * the waist, neck, shoulders, elbows, hips and knees. Knees and elbows are hinges that bend one way only; the
 * rest are ball joints held within a living body's range, with a little muscle in them so a fallen man is not a rag.
 */
export class Ragdoll {
  readonly parts: RAPIER.RigidBody[];
  readonly colliders: RAPIER.Collider[];
  /** each joint, and where it sits on each of its two bodies: for checking that none has pulled apart */
  readonly links: { a: number; b: number; pa: Vec; pb: Vec }[] = [];
  active = false;
  /** seconds the trunk has lain more or less still */
  private rest = 0;

  constructor(world: RAPIER.World) {
    this.parts = PARTS.map((p) => world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(p.at[0], PARK + p.at[1], p.at[2]).setLinearDamping(0.05).setAngularDamping(1.2).setCanSleep(false).setCcdEnabled(true),
    ));
    this.colliders = PARTS.map((p, i) => {
      const c = world.createCollider(p.shape().setMass(p.share * BODY_MASS).setFriction(0.8).setRestitution(0.05).setCollisionGroups(RAGDOLL_GROUPS), this.parts[i]);
      if (i === SHIN_L || i === SHIN_R) world.createCollider(RAPIER.ColliderDesc.cuboid(0.045, 0.035, 0.11).setTranslation(0, -0.215, 0.06).setMass(0).setFriction(0.9).setCollisionGroups(RAGDOLL_GROUPS), this.parts[i]);
      return c;
    });
    for (const l of LINKS) {
      const pa = sub(l.at, PARTS[l.a].at), pb = sub(l.at, PARTS[l.b].at);
      const data = l.hinge ? RAPIER.JointData.revolute(pa, pb, { x: 1, y: 0, z: 0 }) : RAPIER.JointData.spherical(pa, pb);
      const joint = world.createImpulseJoint(data, this.parts[l.a], this.parts[l.b], false);
      joint.setContactsEnabled(false);
      if (l.hinge) (joint as RAPIER.RevoluteImpulseJoint).setLimits(l.hinge[0], l.hinge[1]);
      else {
        // The ball joint's own class has no limits to set; the joint underneath takes them axis by axis.
        const raw = joint as unknown as { rawSet: { jointSetLimits(handle: number, axis: number, min: number, max: number): void; jointConfigureMotor(handle: number, axis: number, pos: number, vel: number, stiffness: number, damping: number): void } };
        [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ].forEach((axis, k) => {
          if (l.ball) raw.rawSet.jointSetLimits(joint.handle, axis, l.ball[k][0], l.ball[k][1]);
          // muscle tone: a weak pull back towards standing straight, and enough drag that limbs do not flail
          raw.rawSet.jointConfigureMotor(joint.handle, axis, 0, 0, 18, 5);
        });
      }
      this.links.push({ a: l.a, b: l.b, pa, pb });
    }
    for (const b of this.parts) {
      b.setAdditionalSolverIterations(12);
      b.setEnabled(false);
    }
  }

  /** Standing at (x, y, z) facing `yaw`, already moving at `vel`: from here on the physics has it. */
  activate(x: number, y: number, z: number, yaw: number, vel: Vec) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    this.parts.forEach((b, i) => {
      const [ox, oy, oz] = PARTS[i].at;
      b.setEnabled(true);
      b.setTranslation({ x: x + ox * c + oz * s, y: y + oy, z: z - ox * s + oz * c }, true);
      b.setRotation(rot, true);
      b.setLinvel(vel, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    });
    this.active = true;
    this.rest = 0;
    this.drag(0);
  }

  private drag(k: number) {
    for (const b of this.parts) {
      b.setLinearDamping(0.05 + 4 * k);
      b.setAngularDamping(1.2 + 14 * k);
    }
  }

  /**
   * Every physics step while it is down. Once the trunk has stopped, the limbs are stilled too: jointed bodies
   * lying on the ground with a joint against its limit otherwise go on twitching for ever.
   */
  settle(dt: number) {
    const before = Math.min(1, this.rest / 0.6);
    let trunk = 0;
    for (const i of [PELVIS, CHEST]) {
      const v = this.parts[i].linvel();
      trunk = Math.max(trunk, Math.hypot(v.x, v.y, v.z));
    }
    this.rest = trunk < 0.8 ? this.rest + dt : 0;
    const now = Math.min(1, this.rest / 0.6);
    if (now !== before) this.drag(now);
  }

  deactivate() {
    if (!this.active) return;
    this.parts.forEach((b, i) => {
      b.setTranslation({ x: PARTS[i].at[0], y: PARK + PARTS[i].at[1], z: PARTS[i].at[2] }, false);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      b.setEnabled(false);
    });
    this.active = false;
  }

  /** A blow of `impulse` (N s) landing at `point`: on whichever piece of the body is there. */
  hit(point: Vec, impulse: Vec) {
    let best = this.parts[CHEST], d = Infinity;
    for (const b of this.parts) {
      const t = b.translation(), k = Math.hypot(t.x - point.x, t.y - point.y, t.z - point.z);
      if (k < d) [best, d] = [b, k];
    }
    best.applyImpulseAtPoint(impulse, point, true);
  }

  /** m/s of the fastest-moving piece: still, once this is next to nothing. */
  get speed() {
    let most = 0;
    for (const b of this.parts) {
      const v = b.linvel();
      most = Math.max(most, Math.hypot(v.x, v.y, v.z));
    }
    return most;
  }
}
