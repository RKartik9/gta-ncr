// Headless handling check: drives each car through a fixed routine on a flat plane and prints what happened.
// Run with: node tools/dev/vehicle-check.ts
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, HATCHBACK, rideHeight } from '../../src/vehicle/cars.ts';
import { type DriveInput, Vehicle } from '../../src/vehicle/vehicle.ts';
import { GROUND_GROUPS, addProps, stepWorld, syncProps } from '../../src/world/physics.ts';
import * as THREE from 'three/webgpu';

await RAPIER.init();
const dt = 1 / 60;
const deg = (r: number) => (r * 180) / Math.PI;

for (const spec of [...CARS, HATCHBACK]) {
  let world!: RAPIER.World, car!: Vehicle;
  /** A fresh car on a fresh plane, brought up to `kmh`. */
  const fresh = (kmh = 0) => {
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = dt;
    world.createCollider(RAPIER.ColliderDesc.cuboid(8000, 0.5, 8000).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS));
    car = new Vehicle(world, spec, 0, 0, 0);
    run(1.5, {});
    if (kmh) run(60, { throttle: 1 }, () => car.speed * 3.6 >= kmh);
  };
  const run = (seconds: number, input: Partial<DriveInput>, until?: () => boolean, each?: () => void) => {
    let t = 0;
    for (; t < seconds; t += dt) {
      car.update({ throttle: 0, steer: 0, handbrake: false, ...input }, dt);
      stepWorld(world);
      each?.();
      if (until?.()) break;
    }
    return t;
  };
  const kmh = () => (car.speed * 3.6).toFixed(0);
  const pos = () => car.body.translation();

  console.log(`\n${spec.name}`);
  fresh();
  const carried = [0, 1, 2, 3].reduce((n, i) => n + (car.controller.wheelSuspensionForce(i) ?? 0), 0);
  console.log(`  rest height ${pos().y.toFixed(3)} m (designed ${rideHeight(spec).toFixed(3)}), springs carry ${(carried / (spec.mass * 9.81) * 100).toFixed(0)}% of the weight`);
  const x0 = pos().x, z0 = pos().z;
  run(4, {});
  console.log(`  parked for 4 s: crept ${(Math.hypot(pos().x - x0, pos().z - z0) * 1000).toFixed(0)} mm`);

  const t100 = run(40, { throttle: 1 }, () => car.speed * 3.6 >= 100);
  console.log(`  0-100 km/h in ${t100.toFixed(1)} s`);
  run(30, { throttle: 1 });
  console.log(`  top speed ${kmh()} km/h (designed ${(spec.topSpeed * 3.6).toFixed(0)}), wandered ${Math.abs(pos().x).toFixed(1)} m off line`);
  run(3, {});
  console.log(`  3 s off the throttle: ${kmh()} km/h`);

  fresh(100);
  const zb = pos().z;
  let abs = 0, steps = 0;
  const tStop = run(30, { throttle: -1 }, () => car.speed < 0.3, () => {
    steps++;
    if (car.abs) abs++;
  });
  console.log(`  100-0 km/h in ${tStop.toFixed(1)} s over ${(pos().z - zb).toFixed(1)} m (${(27.78 ** 2 / 2 / (pos().z - zb) / 9.81).toFixed(2)} g), anti-lock working ${(abs / steps * 100).toFixed(0)}% of the time, ${Math.abs(pos().x).toFixed(2)} m off line`);
  run(3, { throttle: -1 });
  console.log(`  reverse: ${kmh()} km/h`);
  // Backing up in a straight line for long enough to reach full reverse speed: it must stay straight, and must not
  // read as a slide (the camera swings on the slide angle).
  fresh();
  let slid = 0;
  run(8, { throttle: -1 }, undefined, () => (slid = Math.max(slid, Math.abs(car.drift))));
  console.log(`  8 s in reverse, hands off: ${kmh()} km/h, ${Math.abs(pos().x).toFixed(2)} m off line, slide angle read up to ${(slid * 57.3).toFixed(0)} deg`);
  if (Math.abs(pos().x) > 0.5 || slid > 0.1) process.exitCode = 1;

  // Turning circle: full lock at a held speed, and from rest with the throttle floored (a key player's U-turn).
  const circles = [10, 30, 50, 80].map((target) => {
    fresh(target);
    let r = 0, n = 0, t = 0;
    for (; t < 7; t += dt) {
      car.update({ throttle: car.speed * 3.6 < target ? 1 : 0, steer: 1, handbrake: false }, dt);
      stepWorld(world);
      const v = car.body.linvel();
      if (t > 3) (r += Math.hypot(v.x, v.z) / Math.max(1e-3, Math.abs(car.body.angvel().y)), n++);
    }
    return `${target} km/h ${(r / n).toFixed(1)} m`;
  });
  fresh();
  let far = 0;
  const h1 = car.heading;
  let swung = 0, prev = h1;
  const tU = run(20, { throttle: 1, steer: 1 }, () => Math.abs(swung) >= Math.PI, () => {
    swung += Math.atan2(Math.sin(car.heading - prev), Math.cos(car.heading - prev));
    prev = car.heading;
    far = Math.max(far, Math.abs(pos().x));
  });
  console.log(`  turning radius at full lock: ${circles.join(', ')}; U-turn from rest, throttle floored: ${far.toFixed(1)} m wide in ${tU.toFixed(1)} s`);

  // Flat out in a circle: what the tyres will hold sideways, and whether the car stays on its wheels.
  fresh(90);
  let g = 0, n = 0, lean = 0;
  run(8, { throttle: 0.6, steer: 1 }, undefined, () => {
    const w = car.body.angvel(), v = car.body.linvel();
    if (++n > 180) g = Math.max(g, (Math.abs(w.y) * Math.hypot(v.x, v.z)) / 9.81);
    const q = car.body.rotation();
    lean = Math.max(lean, Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
  });
  console.log(`  full lock at 90 km/h and held: ${kmh()} km/h, up to ${g.toFixed(2)} g sideways, leaned ${deg(lean).toFixed(1)} deg, slide angle ${deg(car.drift).toFixed(0)} deg, flipped ${car.isFlipped}`);

  // Handbrake turn: the back should come round.
  fresh(70);
  const h0 = car.heading;
  let turned = 0, last = h0, most = 0;
  run(2.5, { steer: 1, handbrake: true }, undefined, () => {
    turned += Math.atan2(Math.sin(car.heading - last), Math.cos(car.heading - last));
    last = car.heading;
    most = Math.max(most, Math.abs(car.drift));
  });
  console.log(`  handbrake turn from 70 km/h: turned ${deg(turned).toFixed(0)} deg in 2.5 s, slide angle up to ${deg(most).toFixed(0)} deg, ${kmh()} km/h left, flipped ${car.isFlipped}`);

  // Drift: flick it in with the handbrake, then hold it on the throttle.
  fresh(80);
  run(0.7, { steer: 1, handbrake: true });
  let held = 0, total = 0;
  run(5, { steer: 1, throttle: 1 }, undefined, () => {
    total++;
    if (Math.abs(car.drift) > 0.17) held++;
  });
  console.log(`  drift on the throttle: sliding more than 10 deg for ${(held / total * 100).toFixed(0)}% of 5 s, ending at ${deg(car.drift).toFixed(0)} deg and ${kmh()} km/h, flipped ${car.isFlipped}`);

  // Swerve at speed and let go: it should settle, not spin.
  fresh(120);
  run(0.5, { throttle: 0.5, steer: 1 });
  run(0.5, { throttle: 0.5, steer: -1 });
  let worst = 0, leaned = 0;
  run(4, { throttle: 0.5 }, undefined, () => {
    worst = Math.max(worst, Math.abs(car.drift));
    const q = car.body.rotation();
    leaned = Math.max(leaned, Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z)))));
  });
  const w = car.body.angvel();
  console.log(`  swerve at 120 km/h then hands off: slide angle up to ${deg(worst).toFixed(0)} deg, leaned up to ${deg(leaned).toFixed(0)} deg, still turning at ${deg(Math.abs(w.y)).toFixed(1)} deg/s after 4 s, ${kmh()} km/h, flipped ${car.isFlipped}`);
}

// Solid world: a row of bins across the lane at 20 m, a lamp post at 30 m, a tree trunk at 45 m.
// The bins should scatter and the post go over; the trunk should stop the car.
{
  const spec = CARS[0];
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS));
  const bins = [-1.2, 0, 1.2].map((x) => new THREE.Matrix4().makeTranslation(x, 0.5, 20));
  const mesh = { setMatrixAt() {}, instanceMatrix: { needsUpdate: false } };
  let toppled = 0;
  const props = addProps(world, [{ x: 0, z: 45, r: 0.35, h: 5 }], [
    { mesh, poses: bins, shape: 'cylinder', half: [0.3, 0.5, 0.3], lift: 0.5, mass: 14 },
    { mesh, poses: [new THREE.Matrix4().makeTranslation(0.4, 0, 30)], shape: 'cylinder', half: [0.11, 4.25, 0.11], lift: 4.25, drop: 4.25, mass: 95, onTopple: () => toppled++ },
  ]);
  const car = new Vehicle(world, spec, 0, 0, 0);
  for (let t = 0; t < 10; t += dt) {
    car.update({ throttle: 1, steer: 0, handbrake: false }, dt);
    stepWorld(world);
    syncProps(world);
  }
  const front = car.body.translation().z + spec.length / 2;
  console.log(`\nprop crash (${spec.name}): knocked ${props.awake}/4, lamp posts down ${toppled}/1, car nose at ${front.toFixed(1)} m (trunk at 45 m), ${(car.speed * 3.6).toFixed(0)} km/h`);
  if (props.awake < 3) throw new Error('the bins did not move');
  if (toppled !== 1) throw new Error('the lamp post did not go over');
  if (front > 45.5) throw new Error('the car drove through the tree');
}
