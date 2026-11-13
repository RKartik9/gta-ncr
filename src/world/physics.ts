import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { Tile } from './tile.ts';

export const STEP = 1 / 60;

/**
 * Collision groups (Rapier packs them as membership << 16 | filter). The road surface is its own group so the
 * cars' solid tyres can pass through it: the suspension's rays already stand the wheels on the road, and the
 * solid tyres are only there to strike kerbs, posts and other cars side-on.
 */
export const GROUND_GROUPS = (0x0002 << 16) | 0xffff;
export const TYRE_GROUPS = (0x0004 << 16) | (0xffff & ~0x0002);

/** The ground and the fence round the edge of the map; everything else arrives cell by cell with `addProps`. */
export async function createPhysics(bounds: Tile['bounds']) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;

  const { minX, maxX, minZ, maxZ } = bounds;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const hx = (maxX - minX) / 2, hz = (maxZ - minZ) / 2;
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx + 50, 1, hz + 50).setTranslation(cx, -1, cz).setFriction(1).setCollisionGroups(GROUND_GROUPS));

  // The edge of the baked map is a wall rather than a drop.
  const t = 2, h = 6;
  for (const [x, z, sx, sz] of [
    [cx, minZ - t, hx + t, t], [cx, maxZ + t, hx + t, t], [minX - t, cz, t, hz + t], [maxX + t, cz, t, hz + t],
  ]) world.createCollider(RAPIER.ColliderDesc.cuboid(sx, h, sz).setTranslation(x, h, z));
  return world;
}

/**
 * One physics step. `world.step()` in this Rapier release goes on to check every body and collider in the world
 * against its JavaScript wrapper (bookkeeping for soft bodies, which this game has none of). With a city of
 * tens of thousands of colliders loaded, that cost several times the physics itself, on every step.
 */
export function stepWorld(world: RAPIER.World) {
  world.physicsPipeline.step(
    world.gravity, world.integrationParameters, world.islands, world.broadPhase, world.narrowPhase, world.bodies, world.colliders,
    world.softBodies, world.impulseJoints, world.multibodyJoints, world.ccdSolver,
  );
}

interface SolidLike {
  x: number;
  z: number;
  r: number;
  h: number;
}

interface PropRef {
  kind: LooseLike;
  i: number;
  toppled: boolean;
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _m = new THREE.Matrix4();
/**
 * Every frame: copy moving street furniture back into its instanced mesh. Rapier hands over only the awake
 * bodies, so a city full of sleeping bins costs nothing.
 */
export function syncProps(world: RAPIER.World) {
  world.forEachActiveRigidBody((body) => {
    const ref = body.userData as PropRef | undefined;
    if (!ref) return;
    const { kind, i } = ref;
    const t = body.translation(), r = body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    // the body is centred on the middle of the thing; a pole's mesh starts at its foot
    _p.set(0, -(kind.drop ?? 0), 0).applyQuaternion(_q);
    _m.compose(_p.set(_p.x + t.x, _p.y + t.y, _p.z + t.z), _q, _s);
    kind.mesh.setMatrixAt(i, _m);
    kind.mesh.instanceMatrix.needsUpdate = true;
    // leaning past about 20 degrees, it is going over
    if (!ref.toppled && kind.onTopple && 1 - 2 * (r.x * r.x + r.z * r.z) < 0.94) {
      ref.toppled = true;
      kind.onTopple(i);
    }
  });
}

interface LooseLike {
  mesh: { setMatrixAt(i: number, m: THREE.Matrix4): void; instanceMatrix: { needsUpdate: boolean } };
  poses: THREE.Matrix4[];
  shape: 'box' | 'cylinder';
  half: [number, number, number];
  lift: number;
  drop?: number;
  mass: number;
  onTopple?: (i: number) => void;
}

/**
 * One map cell's solid parts. Building walls and trunks and poles are fixed; street furniture becomes bodies that sleep until the car hits them.
 * `syncProps` copies the moving ones back into their instanced meshes; `dispose` takes everything out of the world.
 */
export function addProps(world: RAPIER.World, solids: SolidLike[], loose: LooseLike[], walls?: { vertices: Float32Array; indices: Uint32Array }) {
  const colliders: RAPIER.Collider[] = [];
  if (walls?.indices.length) colliders.push(world.createCollider(RAPIER.ColliderDesc.trimesh(walls.vertices, walls.indices).setFriction(0.3)));
  for (const s of solids) {
    colliders.push(world.createCollider(RAPIER.ColliderDesc.cylinder(s.h / 2, s.r).setTranslation(s.x, s.h / 2, s.z).setFriction(0.5)));
  }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1);
  const kinds = loose.map((kind) => {
    const bodies = kind.poses.map((pose, i) => {
      pose.decompose(p, q, scale);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, kind.lift, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinearDamping(0.3).setAngularDamping(0.4).setCanSleep(true),
      );
      const [a, b, c] = kind.half;
      const desc = kind.shape === 'box' ? RAPIER.ColliderDesc.cuboid(a, b, c) : RAPIER.ColliderDesc.cylinder(b, a);
      world.createCollider(desc.setMass(kind.mass).setFriction(0.6).setRestitution(0.15), body);
      body.sleep();
      body.userData = { kind, i, toppled: false } satisfies PropRef;
      return body;
    });
    return { kind, bodies };
  });
  return {
    /** how many pieces of furniture are currently moving or have been knocked out of place */
    get awake() {
      return kinds.reduce((n, k) => n + k.bodies.filter((b) => !b.isSleeping()).length, 0);
    },
    dispose() {
      for (const c of colliders) world.removeCollider(c, false);
      // Removing a body makes Rapier's wrapper look through every collider in the world for ones that went
      // with it: for a cell's worth of furniture that is seconds. Hold that off and do it once at the end.
      const set = world.colliders as unknown as { unmapRemovedColliders(): void };
      const unmap = set.unmapRemovedColliders;
      set.unmapRemovedColliders = () => {};
      try {
        for (const { bodies } of kinds) for (const b of bodies) world.removeRigidBody(b);
      } finally {
        set.unmapRemovedColliders = unmap;
      }
      if (kinds.some((k) => k.bodies.length)) set.unmapRemovedColliders();
    },
  };
}
