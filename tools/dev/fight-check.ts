// Headless check of the bodies used on foot: the capsule that walks, the blows, and the jointed body that falls.
// Run with: node tools/dev/fight-check.ts
import RAPIER from '@dimforge/rapier3d-compat';
import { BODY_MASS, CharacterBody, Ragdoll, SHIN_L, THIGH_L } from '../../src/character/ragdoll.ts';
import { GROUND_GROUPS, stepWorld } from '../../src/world/physics.ts';

await RAPIER.init();
const dt = 1 / 60;
let world!: RAPIER.World;
/** every jointed body in the world under test */
let dolls: Ragdoll[] = [];
const fresh = () => {
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  dolls = [];
  world.createCollider(RAPIER.ColliderDesc.cuboid(8000, 0.5, 8000).setTranslation(0, -0.5, 0).setFriction(1).setCollisionGroups(GROUND_GROUPS));
};
const steps = (seconds: number, each?: (t: number) => void) => {
  for (let t = 0; t < seconds; t += dt) {
    each?.(t);
    for (const d of dolls) if (d.active) d.settle(dt);
    stepWorld(world);
  }
};
let failed = 0;
const check = (ok: boolean, text: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failed++;
};
const turned = (q: RAPIER.Rotation, v: [number, number, number]) => {
  const [x, y, z] = v, tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + q.y * tz - q.z * ty, y + q.w * ty + q.z * tx - q.x * tz, z + q.w * tz + q.x * ty - q.y * tx];
};
/** metres by which the worst joint of a fallen body has pulled apart */
const apart = (r: Ragdoll) => Math.max(...r.links.map((l) => {
  const a = r.parts[l.a], b = r.parts[l.b];
  const pa = turned(a.rotation(), [l.pa.x, l.pa.y, l.pa.z]), pb = turned(b.rotation(), [l.pb.x, l.pb.y, l.pb.z]);
  const ta = a.translation(), tb = b.translation();
  return Math.hypot(ta.x + pa[0] - tb.x - pb[0], ta.y + pa[1] - tb.y - pb[1], ta.z + pa[2] - tb.z - pb[2]);
}));
/** how far the left knee is bent, radians: the shin's turn about the thigh's left-right axis */
const knee = (r: Ragdoll) => {
  const a = r.parts[THIGH_L].rotation(), b = r.parts[SHIN_L].rotation();
  // conj(a) * b
  const x = a.w * b.x - a.x * b.w - a.y * b.z + a.z * b.y, w = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  return 2 * Math.atan2(x, w);
};
const finite = (r: Ragdoll) => r.parts.every((b) => Number.isFinite(b.translation().x + b.translation().y + b.translation().z));

console.log('\nOn their feet');
{
  fresh();
  const man = new CharacterBody(world);
  man.place(0, 0, 0);
  steps(0.5, () => man.drive(0, 0, dt));
  check(Math.abs(man.body.translation().y) < 0.02 && man.grounded, `stands on the ground (y ${man.body.translation().y.toFixed(3)})`);
  steps(1, () => man.drive(0, 1.6, dt));
  check(Math.abs(man.body.linvel().z - 1.6) < 0.05, `walks at ${man.body.linvel().z.toFixed(2)} m/s`);
  steps(1, () => man.drive(0, 5.5, dt));
  check(Math.abs(man.body.linvel().z - 5.5) < 0.05, `sprints at ${man.body.linvel().z.toFixed(2)} m/s`);
  const z = man.body.translation().z;
  steps(1, () => man.drive(0, 0, dt));
  check(Math.hypot(man.body.linvel().x, man.body.linvel().z) < 0.02, `stops in ${(man.body.translation().z - z).toFixed(2)} m`);
  man.body.applyImpulse({ x: 0, y: 0, z: 25 }, true);
  check(Math.abs(man.body.linvel().z - 25 / BODY_MASS) < 0.01, `a 25 N s punch moves him at ${man.body.linvel().z.toFixed(2)} m/s`);
  // a wall: running into it is not being hit
  world.createCollider(RAPIER.ColliderDesc.cuboid(5, 3, 0.5).setTranslation(0, 3, man.body.translation().z + 4));
  let jolt = 0;
  steps(2, () => {
    jolt = Math.max(jolt, man.jolt());
    man.drive(0, 5.5, dt);
  });
  check(jolt < 1 && Math.abs(man.body.linvel().z) < 0.1, `runs into a wall and just stops (felt ${jolt.toFixed(2)}, left at ${man.body.linvel().z.toFixed(2)} m/s)`);
}

console.log('\nRun down');
{
  fresh();
  const man = new CharacterBody(world);
  man.place(0, 0, 0);
  const car = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.7, -8).setCanSleep(false));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.6, 2.1).setMass(1300).setFriction(0.3), car);
  let jolt = 0;
  steps(1.2, () => {
    jolt = Math.max(jolt, man.jolt());
    car.setLinvel({ x: 0, y: 0, z: 40 / 3.6 }, true);
    car.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (!jolt) man.drive(0, 0, dt);
  });
  check(jolt > 3, `a car at 40 km/h is felt as a blow of ${jolt.toFixed(1)} m/s`);

  fresh();
  const doll = new Ragdoll(world);
  dolls.push(doll);
  doll.activate(0, 0, 0, 0, { x: 0, y: 0, z: 0 });
  const car2 = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.7, -6).setCanSleep(false));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.6, 2.1).setMass(1300).setFriction(0.3), car2);
  let worst = 0, fast = 0;
  steps(0.8, () => car2.setLinvel({ x: 0, y: 0, z: 40 / 3.6 }, true));
  steps(6, () => {
    // the driver brakes
    const v = car2.linvel();
    car2.setLinvel({ x: 0, y: v.y, z: Math.max(0, v.z - 8 * dt) }, true);
    worst = Math.max(worst, apart(doll));
    fast = Math.max(fast, doll.speed);
  });
  const p = doll.parts[0].translation();
  check(finite(doll) && fast < 40, `thrown at up to ${fast.toFixed(1)} m/s, lands ${p.z.toFixed(1)} m on`);
  check(worst < 0.1, `joints held under the car (worst ${(worst * 100).toFixed(1)} cm apart)`);
  check(doll.speed < 0.5 && p.y < 0.5 && p.y > 0, `comes to rest on the ground (pelvis ${p.y.toFixed(2)} m up, ${doll.speed.toFixed(2)} m/s)`);
}

console.log('\nKnocked down');
for (const [name, at, impulse] of [
  ['a punch on the jaw', [0.05, 1.6, 0.1], [8, 4, -45]],
  ['a stick across the shins', [0, 0.3, -0.1], [10, 0, 60]],
  ['a shove in the back', [0, 1.3, -0.1], [0, 0, 55]],
  ['let go where he stands', [0, 1.3, 0], [0, 0, 0]],
] as [string, number[], number[]][]) {
  fresh();
  const doll = new Ragdoll(world);
  dolls.push(doll);
  doll.activate(0, 0, 0, 0.7, { x: 0, y: 0, z: 0 });
  doll.hit({ x: at[0], y: at[1], z: at[2] }, { x: impulse[0], y: impulse[1], z: impulse[2] });
  let worst = 0, fast = 0, lo = 0, hi = 0, still = -1;
  steps(7, (t) => {
    worst = Math.max(worst, apart(doll));
    fast = Math.max(fast, doll.speed);
    lo = Math.min(lo, knee(doll));
    hi = Math.max(hi, knee(doll));
    if (doll.speed > 0.3) still = -1;
    else if (still < 0) still = t;
  });
  const p = doll.parts[0].translation();
  console.log(`  ${name}`);
  check(finite(doll) && fast < 25, `  nothing flew off (fastest piece ${fast.toFixed(1)} m/s)`);
  check(worst < 0.03, `  joints held (worst ${(worst * 100).toFixed(1)} cm apart)`);
  check(lo > -0.25 && hi < 2.55, `  the knee bent only the way knees do (${lo.toFixed(2)} to ${hi.toFixed(2)} rad)`);
  check(still >= 0 && p.y < 0.45, `  down and still after ${still.toFixed(1)} s (pelvis ${p.y.toFixed(2)} m up, ${doll.speed.toFixed(2)} m/s at the end)`);
}

console.log('\nKept and used again');
{
  fresh();
  const man = new CharacterBody(world);
  dolls.push(new Ragdoll(world), new Ragdoll(world));
  const bodies = world.bodies.len(), joints = world.impulseJoints.len();
  for (let k = 0; k < 20; k++) {
    for (const d of dolls) d.activate(k, 0, k * 2, k, { x: 1, y: 0, z: 0 });
    man.place(k, 0, 0);
    steps(0.5);
    for (const d of dolls) d.deactivate();
    man.remove();
    steps(0.1);
  }
  check(world.bodies.len() === bodies && world.impulseJoints.len() === joints, `${bodies} bodies and ${joints} joints before and after 20 rounds`);
  dolls[0].activate(0, 0, 0, 0, { x: 0, y: 0, z: 0 });
  let worst = 0;
  steps(4, () => (worst = Math.max(worst, apart(dolls[0]))));
  check(finite(dolls[0]) && worst < 0.03, `a body used again falls as it did the first time (${(worst * 100).toFixed(1)} cm)`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll good');
process.exit(failed ? 1 : 0);
