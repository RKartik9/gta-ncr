import RAPIER from '@dimforge/rapier3d-compat';
import { type CarSpec, axleHeight, rideHeight } from './cars.ts';

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

export class Vehicle {
  readonly spec: CarSpec;
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  steer = 0;
  braking = false;
  private world: RAPIER.World;

  constructor(world: RAPIER.World, spec: CarSpec, x: number, z: number, heading: number) {
    this.world = world;
    this.spec = spec;
    const desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setAngularDamping(0.6).setLinearDamping(0.02).setCcdEnabled(true);
    this.body = world.createRigidBody(desc);

    const ride = rideHeight(spec);
    const halfH = ((spec.height - spec.groundClearance) / 2) * 0.82;
    const m = spec.mass * 0.7;
    const collider = RAPIER.ColliderDesc.cuboid(spec.width / 2, halfH, spec.length / 2)
      .setTranslation(0, spec.groundClearance + halfH - ride, 0)
      .setFriction(0.35)
      .setRestitution(0.1)
      // A low centre of mass keeps the car from rolling over in hard turns.
      .setMassProperties(
        spec.mass,
        { x: 0, y: spec.centreOfMass - ride, z: (spec.axleFront + spec.axleRear) / 2 + 0.05 },
        { x: (m * (spec.height ** 2 + spec.length ** 2)) / 12, y: (m * (spec.width ** 2 + spec.length ** 2)) / 12, z: (m * (spec.width ** 2 + spec.height ** 2)) / 12 },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    world.createCollider(collider, this.body);

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
      this.controller.setWheelFrictionSlip(n, w.front ? spec.gripFront : spec.gripRear);
      this.controller.setWheelSideFrictionStiffness(n, 1);
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
    this.steer = 0;
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
    const c = this.spec;
    const v = this.speed;
    // Rapier takes the brake as an impulse per step and per wheel; this turns a deceleration into one.
    const impulse = (decel: number) => (decel * c.mass * dt) / 3.2;
    let engine = 0;
    let brake = impulse(0.3); // rolling resistance and engine braking
    this.braking = false;
    if (input.throttle > 0) {
      if (v < -0.8) {
        brake = impulse(c.brakeDecel);
        this.braking = true;
      } else {
        engine = c.engineForce * input.throttle * Math.max(0, 1 - (v / c.topSpeed) ** 2);
        brake = 0;
      }
    } else if (input.throttle < 0) {
      if (v > 0.8) {
        brake = impulse(c.brakeDecel) * -input.throttle;
        this.braking = true;
      } else {
        engine = c.reverseForce * input.throttle * Math.max(0, 1 - (v / -c.reverseSpeed) ** 2);
        brake = 0;
      }
    }

    // Less lock at speed, so a held arrow key does not spin the car out.
    const lock = c.maxSteer / (1 + (Math.abs(v) / 13) ** 1.6);
    const target = input.steer * lock;
    const rate = (input.steer === 0 ? 3.2 : 2.2) * dt;
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));

    const driven = c.drive === 'awd' ? 4 : 2;
    for (let n = 0; n < 4; n++) {
      const front = n < 2;
      const locked = input.handbrake && !front;
      this.controller.setWheelSteering(n, front ? this.steer : 0);
      this.controller.setWheelEngineForce(n, front || c.drive === 'awd' ? engine / driven : 0);
      this.controller.setWheelBrake(n, locked ? impulse(c.brakeDecel) * 2 : brake * (front ? 1 : 0.6));
      this.controller.setWheelSideFrictionStiffness(n, locked ? 0.35 : 1);
    }
    if (input.handbrake) this.braking = true;
    this.controller.updateVehicle(dt);
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
