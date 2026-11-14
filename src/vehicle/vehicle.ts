import RAPIER from '@dimforge/rapier3d-compat';
import { type CarSpec, axleHeight, rideHeight } from './cars.ts';
import { TYRE_GROUPS } from '../world/physics.ts';

export interface DriveInput {
  /** -1 (brake / reverse) to 1 (accelerate) */
  throttle: number;
  /** -1 (right) to 1 (left) */
  steer: number;
  handbrake: boolean;
}

/** Chassis-space wheel order: front-left, front-right, rear-left, rear-right. Forward is +z, so left is +x. */
export function wheelLayout(c: CarSpec) {
  return [
    { x: c.track, z: c.axleFront, front: true },
    { x: -c.track, z: c.axleFront, front: true },
    { x: c.track, z: c.axleRear, front: false },
    { x: -c.track, z: c.axleRear, front: false },
  ];
}

type Vec = { x: number; y: number; z: number };

const G = 9.81;
/** A tyre grips hardest when it is slipping a little: about 11% faster or slower than the road, or 7.5 degrees off its heading. */
const PEAK_RATIO = 0.11;
const PEAK_ANGLE = Math.tan((7.5 * Math.PI) / 180);
/** Share of its peak grip a tyre keeps once it is sliding outright. */
const SLIDE = 0.8;
/** Below this road speed (m/s) slip is measured against this speed instead, or it would blow up as the car stops. */
const CRAWL = 1.5;
/** A wheel is so much lighter than the car that it needs smaller time steps of its own. */
const SUBSTEPS = 4;
/** kg m2: a wheel and tyre, and what the engine and gearbox add to the wheels they turn. */
const WHEEL_INERTIA = 1.4, DRIVE_INERTIA = 2.4;
/** N m of torque a limited-slip differential passes across for each rad/s its two sides differ by. */
const LIMITED_SLIP = 90;

/** Grip against slip, both as a share of their peak: rises to 1 at 1, then eases down to SLIDE. */
const tyreCurve = (s: number) => (s < 1 ? s * (2 - s) : SLIDE + (1 - SLIDE) / (1 + ((s - 1) / 2) ** 2));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (v: number, to: number, step: number) => v + clamp(to - v, -step, step);
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z;
/** Vector (x, y, z) turned by quaternion q. */
function turn(q: { x: number; y: number; z: number; w: number }, x: number, y: number, z: number): Vec {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + q.y * tz - q.z * ty, y: y + q.w * ty + q.z * tx - q.x * tz, z: z + q.w * tz + q.x * ty - q.y * tx };
}

/**
 * The car. Rapier holds the body up on four sprung wheels; the tyres are worked out here.
 * Each wheel turns at its own speed, driven by the engine and slowed by its brake, and pushes on the road by how
 * much it is slipping over it. So a wheel can spin under power or lock under the brake, a sliding tyre grips
 * less than a rolling one, and hard braking or cornering shifts the car's weight onto the tyres that then do the work.
 */
export class Vehicle {
  readonly spec: CarSpec;
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  steer = 0;
  braking = false;
  /** how hard the tyres are sliding: 0 gripping, 1 howling. For the tyre sound and the controller's rumble. */
  skid = 0;
  /** the anti-lock brakes are letting a wheel go this step */
  abs = false;
  /** how far each wheel has turned about its axle, radians: a locked wheel stops, a spinning one races */
  readonly wheelAngle = [0, 0, 0, 0];
  /** speed of the driven wheels' tread, m/s: what the engine is turning at, which is not the car's speed when they spin */
  wheelSpeed = 0;
  /** angle between where the nose points and where the car is going, radians, positive when it slides to its left */
  drift = 0;
  private spin = [0, 0, 0, 0];
  /** how far each tyre is off its heading, as a share of the angle where it grips hardest; from the last step */
  private slip = [0, 0, 0, 0];
  /** the handbrake has thrown the car into a slide: stability control stands back until it is straight again */
  private loose = false;
  private cut = 0;
  private gas = 0;
  private brake = 0;
  private reverse = false;
  private world: RAPIER.World;

  constructor(world: RAPIER.World, spec: CarSpec, x: number, z: number, heading: number) {
    this.world = world;
    this.spec = spec;
    // The tyres and the air do the slowing down; damping here is only to settle a car tumbling through the air.
    const desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setAngularDamping(0.12).setLinearDamping(0).setCcdEnabled(true);
    this.body = world.createRigidBody(desc);

    const ride = rideHeight(spec);
    const halfH = ((spec.height - spec.groundClearance) / 2) * 0.82;
    const m = spec.mass * 0.7;
    // A car is not a brick: its bumpers, sills and roof are rounded. With rounded edges a car that slides sideways
    // into something low is lifted over it and goes over, and one already rolling keeps rolling rather than
    // stopping dead on a flat side; with square ones it would just stop. Steel and glass on tarmac grip about 0.5.
    const edge = Math.min(0.25, halfH * 0.5);
    const collider = RAPIER.ColliderDesc.roundCuboid(spec.width / 2 - edge, halfH - edge, spec.length / 2 - edge, edge)
      .setTranslation(0, spec.groundClearance + halfH - ride, 0)
      .setFriction(0.5)
      .setRestitution(0.1)
      // The centre of mass is where the real car's is: a tall car leans, and goes over if it is thrown about.
      .setMassProperties(
        spec.mass,
        { x: 0, y: spec.centreOfMass - ride, z: spec.axleRear + spec.weightFront * (spec.axleFront - spec.axleRear) },
        { x: (m * (spec.height ** 2 + spec.length ** 2)) / 12, y: (m * (spec.width ** 2 + spec.length ** 2)) / 12, z: (m * (spec.width ** 2 + spec.height ** 2)) / 12 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    world.createCollider(collider, this.body);

    // Solid tyres, standing where the wheels sit at rest. The suspension's rays carry the car on the road and
    // these pass through it (TYRE_GROUPS); they are what strikes a kerb, a post or another car side-on. A car
    // sliding sideways whose tyres catch on something is tripped and goes over, which is how nearly every real
    // rollover starts. They add no weight: the body's mass and balance are set above.
    const axis = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
    for (const w of wheelLayout(spec)) {
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(spec.wheelRadius * 0.38, spec.wheelRadius)
          .setTranslation(w.x, spec.wheelRadius - ride, w.z)
          .setRotation(axis)
          .setDensity(0)
          .setFriction(0.9)
          .setRestitution(0.2)
          .setCollisionGroups(TYRE_GROUPS),
        this.body,
      );
    }

    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    wheelLayout(spec).forEach((w, n) => {
      this.controller.addWheel({ x: w.x, y: axleHeight(spec), z: w.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, spec.suspensionRest, spec.wheelRadius);
      this.controller.setWheelSuspensionStiffness(n, spec.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(n, 0.55 * Math.sqrt(spec.suspensionStiffness));
      this.controller.setWheelSuspensionRelaxation(n, 0.72 * Math.sqrt(spec.suspensionStiffness));
      this.controller.setWheelMaxSuspensionTravel(n, spec.suspensionRest * 0.85);
      this.controller.setWheelMaxSuspensionForce(n, spec.mass * 28);
      // Rapier's own tyres are switched off: it does the springs, `update` does the grip.
      this.controller.setWheelFrictionSlip(n, 0);
    });
    this.place(x, z, heading);
  }

  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
  }

  place(x: number, z: number, heading: number) {
    this.body.setTranslation({ x, y: rideHeight(this.spec) + 0.05, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = this.gas = this.brake = this.skid = this.drift = this.wheelSpeed = this.cut = 0;
    this.loose = false;
    this.slip.fill(0);
    this.spin.fill(0);
  }

  /** Signed speed along the car's nose, metres per second. */
  get speed(): number {
    const v = this.body.linvel();
    const q = this.body.rotation();
    // third column of the rotation matrix: the chassis +z axis in world space
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fy = 2 * (q.y * q.z - q.w * q.x);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    return v.x * fx + v.y * fy + v.z * fz;
  }

  get heading(): number {
    const q = this.body.rotation();
    return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
  }

  update(input: DriveInput, dt: number) {
    const c = this.spec, body = this.body, ctl = this.controller;
    const q = body.rotation(), vel = body.linvel();
    const up = turn(q, 0, 1, 0), nose = turn(q, 0, 0, 1), left = turn(q, 1, 0, 0);
    const v = dot(vel, nose), sideways = dot(vel, left);

    // Pedals. The same control brakes when the car is rolling the other way, and drives once it has stopped.
    let gas = 0, brake = 0;
    if (input.throttle > 0) {
      if (v < -0.8) brake = input.throttle;
      else [gas, this.reverse] = [input.throttle, false];
    } else if (input.throttle < 0) {
      if (v > 0.8) brake = -input.throttle;
      else [gas, this.reverse] = [-input.throttle, true];
    }
    // A foot takes a moment to press a pedal; a key does not. Without this every touch of a key is a stamp.
    this.gas = approach(this.gas, gas, (gas > this.gas ? 5 : 10) * dt);
    this.brake = approach(this.brake, brake, (brake > this.brake ? 6 : 14) * dt);
    this.braking = this.brake > 0.05 || input.handbrake;

    // Steering. Less lock at speed, so a held arrow key does not spin the car out. In a slide the wheels are
    // let run towards the way the car is going, as a real car's do when the wheel is let slip through the hands:
    // steering then works from there, which is what makes a slide catchable.
    // Backing up is not a slide: read as one (tail first is 180 degrees of it) the wheels were thrown from lock to
    // lock and the chase camera swung from side to side.
    this.drift = Math.hypot(v, sideways) > 4 && !(this.reverse && v < 0) ? Math.atan2(sideways, v) : 0;
    const sliding = clamp((Math.abs(this.drift) - 0.05) / 0.12, 0, 1);
    if (input.handbrake) this.loose = true;
    else if (Math.abs(this.drift) < 0.05) this.loose = false;
    // At speed the lock comes down to just past the angle where the tyres grip hardest: any more only scrubs them.
    const least = Math.atan(PEAK_ANGLE) * 1.2;
    const lock = least + (c.maxSteer - least) / (1 + (Math.abs(v) / 13) ** 1.6);
    const target = clamp(input.steer * lock + this.drift * 0.8 * sliding, -c.maxSteer, c.maxSteer);
    // and it goes on more gently, but comes back to catch a slide as fast as ever
    const rate = (input.steer === 0 || sliding > 0 ? 3.2 : 2.2 / (1 + Math.abs(v) / 30)) * dt;
    this.steer += clamp(target - this.steer, -rate, rate);

    for (let n = 0; n < 4; n++) ctl.setWheelSteering(n, n < 2 ? this.steer : 0);
    ctl.updateVehicle(dt);

    // What each wheel is standing on, and how hard it is pressed down.
    // Every push on the body is worked out from how it is moving now, and only then applied: applied one by
    // one, each wheel would feel the wheels before it, and the car would pull to one side.
    const pushes: [Vec, Vec][] = [];
    const load = [0, 0, 0, 0];
    for (let n = 0; n < 4; n++) load[n] = ctl.wheelIsInContact(n) ? (ctl.wheelSuspensionForce(n) ?? 0) : 0;
    // Anti-roll bars: each axle's two wheels are tied so the car leans less, which also moves weight across the axle.
    const front = c.antiRollFront ?? 0.575;
    for (const [l, r, share] of [[0, 1, 2 * front], [2, 3, 2 * (1 - front)]]) {
      if (!load[l] && !load[r]) continue;
      const lean = (ctl.wheelSuspensionLength(r) ?? 0) - (ctl.wheelSuspensionLength(l) ?? 0);
      // it can lift a wheel's load off, no more
      const f = clamp(lean * c.antiRoll * share * c.mass, -load[l], load[r]);
      load[l] += f;
      load[r] -= f;
      const pl = ctl.wheelHardPoint(l), pr = ctl.wheelHardPoint(r);
      if (!pl || !pr) continue;
      pushes.push([{ x: up.x * f * dt, y: up.y * f * dt, z: up.z * f * dt }, pl], [{ x: -up.x * f * dt, y: -up.y * f * dt, z: -up.z * f * dt }, pr]);
    }
    const weight = load[0] + load[1] + load[2] + load[3];

    // Engine: full push from rest, tailing off to nothing at top speed. It follows the wheels, so it also
    // tails off when they spin. The air's own drag is added back so the two together still reach top speed.
    const R = c.wheelRadius;
    const axleShare = (n: number) => (n < 2 ? c.driveFront : 1 - c.driveFront);
    const tread = Math.abs(this.wheelSpeed);
    const top = this.reverse ? c.reverseSpeed : c.topSpeed;
    // Stability control, as both real cars have: when the rear tyres are past the angle they grip at (the tail is
    // coming round) or the fronts well past it (the nose is running wide), the engine is held back until they
    // bite again. Without it a floored throttle in a corner spun the car, and the turn was lost catching it.
    // A pull on the handbrake asks for the slide, and switches it off until the car is straight.
    const over = Math.max(Math.abs(this.slip[2]), Math.abs(this.slip[3])) - 1, wide = Math.max(Math.abs(this.slip[0]), Math.abs(this.slip[1])) - 1.6;
    this.cut = approach(this.cut, this.loose ? 0 : clamp(Math.max(over, wide) / 0.6, 0, 1), 8 * dt);
    const push = tread < top ? (1 - this.cut) * this.gas * ((this.reverse ? c.reverseForce : c.engineForce) * (1 - (tread / top) ** 2) + c.drag * tread * tread) : 0;

    // Differentials. Left to itself a driven wheel with no weight on it (the inside one in a hard corner) just
    // spins up and wastes the engine; a limited-slip differential drags it back towards its partner's speed,
    // and on a four-wheel-drive car the centre one does the same between the front and rear axles.
    const start = [...this.spin];
    const front2 = (start[0] + start[1]) / 2, rear2 = (start[2] + start[3]) / 2;
    const tie = (n: number) => {
      if (!axleShare(n)) return 0;
      const across = LIMITED_SLIP * (start[n ^ 1] - start[n]);
      // the handbrake lets the centre one go, as a rally car's does, or locking the rear wheels would brake the front
      const along = c.driveFront > 0 && c.driveFront < 1 && !input.handbrake ? LIMITED_SLIP * ((n < 2 ? rear2 : front2) - (n < 2 ? front2 : rear2)) : 0;
      return across + along;
    };

    let skid = 0, treadSum = 0;
    this.abs = false;
    for (let n = 0; n < 4; n++) {
      const front = n < 2, share = axleShare(n) / 2;
      const inertia = WHEEL_INERTIA + DRIVE_INERTIA * share;
      // the handbrake works the rear wheels, and takes the drive off them
      const held = input.handbrake && !front;
      const drive = held ? 0 : (this.reverse ? -1 : 1) * push * R * share + tie(n);
      // always there: rolling resistance, and off the throttle the engine holding its wheels back
      const dragTorque = c.mass * R * (0.03 + (1 - this.gas) * 0.5 * share);
      const pedalTorque = this.brake * c.mass * c.brakeDecel * R * (front ? c.brakeFront : 1 - c.brakeFront) / 2;
      const handTorque = held ? c.mass * 12 * R : 0;
      let w = this.spin[n];

      const N = load[n];
      const point = N > 0 ? ctl.wheelContactPoint(n) : null, normal = N > 0 ? ctl.wheelContactNormal(n) : null;
      if (!point || !normal) {
        // in the air: nothing but the engine and the brake act on the wheel
        w += (drive * dt) / inertia;
        const stop = ((dragTorque + pedalTorque + handTorque) * dt) / inertia;
        w = Math.abs(w) <= stop ? 0 : w - Math.sign(w) * stop;
        this.spin[n] = w;
        this.slip[n] = 0;
        this.wheelAngle[n] += w * dt;
        treadSum += w * R * share;
        continue;
      }

      // the wheel's heading and its axle, laid flat on whatever it is standing on
      const a = front ? this.steer : 0;
      const h = { x: nose.x * Math.cos(a) + left.x * Math.sin(a), y: nose.y * Math.cos(a) + left.y * Math.sin(a), z: nose.z * Math.cos(a) + left.z * Math.sin(a) };
      const hn = dot(h, normal);
      let fwd = { x: h.x - normal.x * hn, y: h.y - normal.y * hn, z: h.z - normal.z * hn };
      const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
      fwd = { x: fwd.x / fl, y: fwd.y / fl, z: fwd.z / fl };
      const side = { x: normal.y * fwd.z - normal.z * fwd.y, y: normal.z * fwd.x - normal.x * fwd.z, z: normal.x * fwd.y - normal.y * fwd.x };
      const pv = body.velocityAtPoint(point);
      const vLong = dot(pv, fwd), vLat = dot(pv, side);

      // A tyre carrying more than its share grips a little less for each newton, so weight thrown onto one
      // corner loses more grip there than it gains: why a car pushed hard runs wide or steps out.
      const mu = (front ? c.gripFront : c.gripRear) * clamp(1 - 0.12 * (N / ((c.mass * G) / 4) - 1), 0.75, 1.1);
      const ref = Math.max(Math.abs(vLong), CRAWL);
      const sy = vLat / ref / PEAK_ANGLE;
      this.slip[n] = Math.abs(vLong) > 3 ? sy : 0;
      const step = dt / SUBSTEPS;
      let fx = 0, fy = 0, slide = 0;
      for (let k = 0; k < SUBSTEPS; k++) {
        const slip = w * R - vLong;
        const sx = slip / ref / PEAK_RATIO;
        const s = Math.hypot(sx, sy);
        // newtons of grip for each m/s the tread slips: steep while it grips, shallow once it slides
        const stiff = (mu * N * (s > 1e-4 ? tyreCurve(s) / s : 2)) / (ref * PEAK_RATIO);
        // Anti-lock: a wheel that is being braked to a stop while the car is still moving has its brake let off.
        let pedal = pedalTorque;
        const locking = (-slip * Math.sign(vLong)) / ref / PEAK_RATIO - 1.2;
        if (pedal > 0 && Math.abs(vLong) > 2.5 && locking > 0) {
          pedal *= Math.max(0.05, 1 - locking);
          this.abs = true;
        }
        // Solved for the wheel's speed at the end of the step rather than the start: the tyre is far too
        // stiff a spring for so light a wheel to be stepped forward any other way.
        const resist = inertia / step + R * R * stiff;
        w = ((inertia * w) / step + drive + R * stiff * vLong) / resist;
        const stop = (dragTorque + pedal + handTorque) / resist;
        w = Math.abs(w) <= stop ? 0 : w - Math.sign(w) * stop;

        const slip2 = w * R - vLong, sx2 = slip2 / ref / PEAK_RATIO, s2 = Math.hypot(sx2, sy);
        if (s2 > 1e-4) {
          const f = (mu * N * tyreCurve(s2)) / s2;
          fx += f * sx2;
          fy -= f * sy;
        }
        slide = s2;
      }
      fx /= SUBSTEPS;
      fy /= SUBSTEPS;
      this.spin[n] = w;
      this.wheelAngle[n] += w * dt;
      treadSum += w * R * share;

      // Never more than would stop the slip dead in this one step: at a crawl the tyre would otherwise
      // overshoot and shake the car to and fro.
      const carried = (c.mass * N) / weight / dt;
      fx = clamp(fx, -carried * Math.abs(w * R - vLong), carried * Math.abs(w * R - vLong));
      fy = clamp(fy, -carried * Math.abs(vLat), carried * Math.abs(vLat));
      pushes.push([{ x: (fwd.x * fx + side.x * fy) * dt, y: (fwd.y * fx + side.y * fy) * dt, z: (fwd.z * fx + side.z * fy) * dt }, point]);

      const scrub = Math.hypot(w * R - vLong, vLat);
      skid = Math.max(skid, clamp((slide - 1.3) / 2.5, 0, 1) * clamp(scrub / 3, 0, 1) * clamp(N / ((c.mass * G) / 8), 0, 1));
    }
    this.wheelSpeed = treadSum;
    this.skid = skid;
    for (const [impulse, at] of pushes) body.applyImpulseAtPoint(impulse, at, true);

    // The air: drag against the way the car is going, and for a car with wings, a push down onto its tyres.
    const air = Math.hypot(vel.x, vel.y, vel.z);
    const down = weight > 0 ? c.downforce * v * v : 0;
    body.applyImpulse({
      x: (-vel.x * c.drag * air - up.x * down) * dt, y: (-vel.y * c.drag * air - up.y * down) * dt, z: (-vel.z * c.drag * air - up.z * down) * dt,
    }, true);
  }

  /** On its roof or its side: the reset key is the way out. */
  get isFlipped(): boolean {
    const q = this.body.rotation();
    return 1 - 2 * (q.x * q.x + q.z * q.z) < 0.3;
  }

  /** Distance to the first thing a ray hits, ignoring the car itself. */
  castRay(from: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxToi: number): number | null {
    const hit = this.world.castRay(new RAPIER.Ray(from, dir), maxToi, true, undefined, undefined, undefined, this.body);
    return hit ? hit.timeOfImpact : null;
  }
}
