import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { type CarSpec, rideHeight } from '../vehicle/cars.ts';

const Z = new THREE.Vector3(0, 0, 1);
/** how far along the car's boot from its tail the stick lies, metres */
const INSET = 0.45;

/**
 * The hockey stick: lying across the boot of the car until it is taken, then in the player's hands, and on the
 * ground if they are knocked down holding it. Its mesh starts at the grip and runs along +z to the hook.
 */
export class Stick {
  readonly mesh = new THREE.Group();
  /** none: this vehicle has no boot to keep it on (a bike) */
  where: 'car' | 'hand' | 'ground' | 'none' = 'none';
  private scene: THREE.Scene;
  private body: RAPIER.RigidBody;
  private car: THREE.Object3D | null = null;
  private boot = new THREE.Vector3();
  /** how high each car's boot lid is, once found */
  private lids = new Map<string, number>();

  constructor(scene: THREE.Scene, world: RAPIER.World) {
    this.scene = scene;
    const wood = new THREE.MeshStandardMaterial({ color: 0xc9a468, roughness: 0.55 }), tape = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.9 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.017, 0.85, 8).rotateX(Math.PI / 2).translate(0, 0, 0.325), wood);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.32, 8).rotateX(Math.PI / 2).translate(0, 0, 0.05), tape);
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.017, 6, 10, Math.PI * 0.9).rotateX(Math.PI / 2).translate(-0.07, 0, 0.75), wood);
    for (const m of [shaft, grip, hook]) m.castShadow = true;
    this.mesh.add(shaft, grip, hook);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -70, 0).setLinearDamping(0.2).setAngularDamping(0.6));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.03, 0.025, 0.47).setTranslation(0, 0, 0.36).setMass(0.55).setFriction(0.8).setRestitution(0.3), this.body);
    this.body.setEnabled(false);
  }

  /** The car being driven: the stick lies on its boot, unless it is out of the car already. A bike has nowhere for it. */
  setCar(group: THREE.Object3D, spec: CarSpec, bike: boolean) {
    this.car = bike ? null : group;
    if (!bike) {
      const z = -spec.length / 2 + INSET;
      let y = this.lids.get(spec.id);
      if (y === undefined) {
        // straight down onto the car near its tail: whatever is on top there is where the stick lies
        group.updateWorldMatrix(true, true);
        const from = group.localToWorld(new THREE.Vector3(0, 4, z)), down = new THREE.Vector3(0, -1, 0).transformDirection(group.matrixWorld);
        const hit = new THREE.Raycaster(from, down, 0, 6).intersectObject(group, true).find((h) => !this.within(h.object, this.mesh) && h.object.parent?.name !== 'rider');
        y = hit ? group.worldToLocal(hit.point).y : spec.height * 0.8 - rideHeight(spec);
        this.lids.set(spec.id, y);
      }
      this.boot.set(0.4, y + 0.022, z);
    }
    if (this.where === 'car' || this.where === 'none') this.toCar();
  }

  private within(o: THREE.Object3D | null, root: THREE.Object3D) {
    for (; o; o = o.parent) if (o === root) return true;
    return false;
  }

  /** Back on the boot. */
  toCar() {
    this.body.setEnabled(false);
    this.mesh.removeFromParent();
    this.where = this.car ? 'car' : 'none';
    if (!this.car) return;
    this.mesh.position.copy(this.boot);
    this.mesh.rotation.set(0, -Math.PI / 2, 0);
    this.car.add(this.mesh);
  }

  toHand() {
    this.body.setEnabled(false);
    this.scene.add(this.mesh);
    this.where = 'hand';
  }

  /** Let go of where it is, moving at `vel`: it falls and lies where it lands. */
  drop(vel: { x: number; y: number; z: number }) {
    const p = this.mesh.position, q = this.mesh.quaternion;
    this.scene.add(this.mesh);
    this.body.setEnabled(true);
    this.body.setTranslation({ x: p.x, y: Math.max(p.y, 0.1), z: p.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel(vel, true);
    this.body.setAngvel({ x: 3, y: 1, z: 0 }, true);
    this.where = 'ground';
  }

  /** In the hands at `hand`, pointing along `dir`. */
  hold(hand: THREE.Vector3, dir: THREE.Vector3) {
    this.mesh.position.copy(hand);
    this.mesh.quaternion.setFromUnitVectors(Z, dir);
  }

  /** Every frame: lying on the ground, it is drawn where the physics has it. */
  update() {
    if (this.where !== 'ground') return;
    const p = this.body.translation(), q = this.body.rotation();
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }

  /** Where it can be picked up from, in the world: on the boot or on the ground. Null while it is in hand, or nowhere. */
  place(out: THREE.Vector3) {
    if (this.where === 'ground') return out.copy(this.mesh.position);
    if (this.where === 'car' && this.car) return this.car.localToWorld(out.copy(this.boot).setX(0));
    return null;
  }

  /** Where it is put back, whether or not it is there now. */
  home(out: THREE.Vector3) {
    return this.car ? this.car.localToWorld(out.copy(this.boot).setX(0)) : null;
  }
}
