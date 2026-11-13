// Headless rollover check: throws each car about at speed and reports how far it rolled.
// Run with: node tools/dev/rollover-check.ts
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, HATCHBACK } from '../../src/vehicle/cars.ts';
import { type DriveInput, Vehicle } from '../../src/vehicle/vehicle.ts';
import { GROUND_GROUPS, stepWorld } from '../../src/world/physics.ts';

await RAPIER.init();
const dt = 1 / 60;
const deg = (r: number) => (r * 180) / Math.PI;

for (const spec of [...CARS, HATCHBACK]) {
  console.log(`\n${spec.name}`);
  let world!: RAPIER.World, car!: Vehicle;
  const fresh = (kmh: number, setup?: (w: RAPIER.World) => void) => {
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = dt;
    world.createCollider(RAPIER.ColliderDesc.cuboid(8000, 0.5, 8000).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS));
    setup?.(world);
    car = new Vehicle(world, spec, 0, 0, 0);
    run(1.5, {});
    // bring it up to speed without the long run-up: set the speed straight
    car.body.setLinvel({ x: 0, y: 0, z: kmh / 3.6 }, true);
    run(0.3, { throttle: 0.4 });
  };
  /** Most the car rolled (its up axis away from straight up), degrees; 180 is on its roof. */
  let roll = 0;
  const run = (seconds: number, input: Partial<DriveInput>) => {
    for (let t = 0; t < seconds; t += dt) {
      car.update({ throttle: 0, steer: 0, handbrake: false, ...input }, dt);
      stepWorld(world);
      const q = car.body.rotation();
      roll = Math.max(roll, Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z)))));
    }
  };
  const report = (what: string) => {
    console.log(`  ${what.padEnd(44)} rolled up to ${deg(roll).toFixed(0).padStart(3)} deg${car.isFlipped ? '  -> OVER' : ''}`);
    roll = 0;
  };

  for (const kmh of [60, 90, 120, 150]) {
    // fishhook: full lock one way, then the other, the swerve that rolls tall cars in tests
    fresh(kmh);
    roll = 0;
    run(0.45, { steer: 1 });
    run(2.5, { steer: -1 });
    run(2, {});
    report(`fishhook at ${kmh} km/h`);
  }
  for (const kmh of [60, 100, 140]) {
    fresh(kmh);
    roll = 0;
    run(3, { steer: 1, handbrake: true });
    report(`handbrake slide at ${kmh} km/h`);
  }
  for (const kmh of [40, 70, 100]) {
    // sliding sideways into a 15 cm kerb running along the road: the commonest way a real car goes over
    fresh(0, (w) => w.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 0.075, 50).setTranslation(-4, 0.075, 0)));
    car.body.setLinvel({ x: -kmh / 3.6, y: 0, z: 0 }, true);
    roll = 0;
    run(4, {});
    report(`sideways into a kerb at ${kmh} km/h`);
  }
  for (const kmh of [60, 100]) {
    // a car parked broadside: hit with one front corner
    fresh(kmh, (w) => {
      const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(1.2, 0.75, 25));
      w.createCollider(RAPIER.ColliderDesc.cuboid(2.2, 0.7, 0.9).setMass(1300).setFriction(0.6), b);
    });
    roll = 0;
    run(4, {});
    report(`corner into a parked car at ${kmh} km/h`);
  }
}
