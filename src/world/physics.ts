import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import type { Tile } from './tile.ts';

export const STEP = 1 / 60;

/** The ground and the fence round the edge of the map; everything else arrives cell by cell with `addProps`. */
export async function createPhysics(bounds: Tile['bounds']) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;

  const { minX, maxX, minZ, maxZ } = bounds;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const hx = (maxX - minX) / 2, hz = (maxZ - minZ) / 2;
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx + 50, 1, hz + 50).setTranslation(cx, -1, cz).setFriction(1));

  // The edge of the baked map is a wall rather than a drop.
  const t = 2, h = 6;
  for (const [x, z, sx, sz] of [
    [cx, minZ - t, hx + t, t], [cx, maxZ + t, hx + t, t], [minX - t, cz, t, hz + t], [maxX + t, cz, t, hz + t],
  ]) world.createCollider(RAPIER.ColliderDesc.cuboid(sx, h, sz).setTranslation(x, h, z));
  return world;
}

interface SolidLike {
  x: number;
  z: number;
  r: number;
  h: number;
}

interface LooseLike {
  mesh: { setMatrixAt(i: number, m: THREE.Matrix4): void; instanceMatrix: { needsUpdate: boolean } };
  poses: THREE.Matrix4[];
  shape: 'box' | 'cylinder';
  half: [number, number, number];
  lift: number;
  mass: number;
}

/**
 * One map cell's solid parts. Building walls and trunks and poles are fixed; street furniture becomes bodies that sleep until the car hits them.
 * `sync` copies the moving ones back into their instanced meshes; `dispose` takes everything out of the world.
 */
export function addProps(world: RAPIER.World, solids: SolidLike[], loose: LooseLike[], walls?: { vertices: Float32Array; indices: Uint32Array }) {
  const colliders: RAPIER.Collider[] = [];
  if (walls?.indices.length) colliders.push(world.createCollider(RAPIER.ColliderDesc.trimesh(walls.vertices, walls.indices).setFriction(0.3)));
  for (const s of solids) {
    colliders.push(world.createCollider(RAPIER.ColliderDesc.cylinder(s.h / 2, s.r).setTranslation(s.x, s.h / 2, s.z).setFriction(0.5)));
  }
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1), m = new THREE.Matrix4();
  const kinds = loose.map((kind) => {
    const bodies = kind.poses.map((pose) => {
      pose.decompose(p, q, scale);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, kind.lift, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinearDamping(0.3).setAngularDamping(0.4).setCanSleep(true),
      );
      const [a, b, c] = kind.half;
      const desc = kind.shape === 'box' ? RAPIER.ColliderDesc.cuboid(a, b, c) : RAPIER.ColliderDesc.cylinder(b, a);
      world.createCollider(desc.setMass(kind.mass).setFriction(0.6).setRestitution(0.15), body);
      body.sleep();
      return body;
    });
    return { kind, bodies };
  });
  return {
    sync() {
      for (const { kind, bodies } of kinds) {
        let moved = false;
        bodies.forEach((body, i) => {
          if (body.isSleeping()) return;
          const t = body.translation(), r = body.rotation();
          kind.mesh.setMatrixAt(i, m.compose(p.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), scale.set(1, 1, 1)));
          moved = true;
        });
        if (moved) kind.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    /** how many pieces of furniture are currently moving or have been knocked out of place */
    get awake() {
      return kinds.reduce((n, k) => n + k.bodies.filter((b) => !b.isSleeping()).length, 0);
    },
    dispose() {
      for (const c of colliders) world.removeCollider(c, false);
      for (const { bodies } of kinds) for (const b of bodies) world.removeRigidBody(b);
    },
  };
}
