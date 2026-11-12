// Headless handling check: drives each car through a fixed routine on a flat plane and prints what happened.
// Run with: node tools/dev/vehicle-check.ts
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, HATCHBACK, rideHeight } from '../../src/vehicle/cars.ts';
import { type DriveInput, Vehicle } from '../../src/vehicle/vehicle.ts';
import { addProps } from '../../src/world/physics.ts';
import * as THREE from 'three/webgpu';

await RAPIER.init();
const dt = 1 / 60;

for (const spec of [...CARS, HATCHBACK]) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(1));
  const car = new Vehicle(world, spec, 0, 0, 0);
  const run = (seconds: number, input: Partial<DriveInput>, until?: () => boolean) => {
    let t = 0;
    for (; t < seconds; t += dt) {
      car.update({ throttle: 0, steer: 0, handbrake: false, ...input }, dt);
      world.step();
      if (until?.()) break;
    }
    return t;
  };
  const kmh = () => (car.speed * 3.6).toFixed(0);

  console.log(`\n${spec.name}`);
  run(1.5, {});
  console.log(`  rest height ${car.body.translation().y.toFixed(3)} m (designed ${rideHeight(spec).toFixed(3)})`);
  const t100 = run(30, { throttle: 1 }, () => car.speed * 3.6 >= 100);
  console.log(`  0-100 km/h in ${t100.toFixed(1)} s`);
  run(12, { throttle: 1 });
  console.log(`  after 12 s more: ${kmh()} km/h`);
  const z0 = car.body.translation().z;
  const tStop = run(30, { throttle: -1 }, () => car.speed < 0.5);
  console.log(`  braked to a stop in ${tStop.toFixed(1)} s over ${(car.body.translation().z - z0).toFixed(0)} m`);
  run(3, { throttle: -1 });
  console.log(`  reverse: ${kmh()} km/h`);
  run(4, { throttle: 1 });
  run(6, { throttle: 1, steer: 1 });
  console.log(`  hard left at full throttle: ${kmh()} km/h, flipped ${car.isFlipped}, height ${car.body.translation().y.toFixed(2)}`);
  run(6, { throttle: 1, steer: -1 });
  console.log(`  hard right at full throttle: ${kmh()} km/h, flipped ${car.isFlipped}`);
  run(3, { steer: 1, handbrake: true });
  console.log(`  handbrake turn: ${kmh()} km/h, flipped ${car.isFlipped}`);
}

// Solid world: a row of bins across the lane at 20 m, a tree trunk at 45 m. The bins should scatter; the trunk should stop the car.
{
  const spec = CARS[0];
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(1));
  const bins = [-1.2, 0, 1.2].map((x) => new THREE.Matrix4().makeTranslation(x, 0.5, 20));
  const mesh = { setMatrixAt() {}, instanceMatrix: { needsUpdate: false } };
  const props = addProps(world, [{ x: 0, z: 45, r: 0.35, h: 5 }], [{ mesh, poses: bins, shape: 'cylinder', half: [0.3, 0.5, 0.3], lift: 0.5, mass: 14 }]);
  const car = new Vehicle(world, spec, 0, 0, 0);
  for (let t = 0; t < 10; t += dt) {
    car.update({ throttle: 1, steer: 0, handbrake: false }, dt);
    world.step();
  }
  const front = car.body.translation().z + spec.length / 2;
  console.log(`\nprop crash (${spec.name}): bins knocked ${props.awake}/3, car nose at ${front.toFixed(1)} m (trunk at 45 m), ${(car.speed * 3.6).toFixed(0)} km/h`);
  if (props.awake < 2) throw new Error('the bins did not move');
  if (front > 45.5) throw new Error('the car drove through the tree');
}
