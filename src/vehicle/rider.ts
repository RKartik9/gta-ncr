import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rideHeight } from './cars.ts';
import type { CarModel } from './carModel.ts';
import { mergeInto } from './gltfCar.ts';

// Whoever is driving: one rigged figure (public/models/rider/model.glb, the usual Mixamo skeleton), bent into a
// seat or over a bike's bars when a vehicle is loaded and then frozen into plain meshes, so it costs what a
// wing mirror costs. He does not move: no hands turning the wheel, no head turning.

type V3 = [number, number, number];
/** Where each bone points, in the figure's own space: x to his left, y up, z the way he faces. Right limbs mirror the left. */
type Pose = Record<string, V3>;

const DRIVING: Pose = {
  Hips: [0, 0.95, -0.3], Spine: [0, 0.96, -0.27], Spine1: [0, 0.97, -0.24], Spine2: [0, 1, -0.12], Neck: [0, 1, 0.06], Head: [0, 1, 0],
  // the shin is set per car, below
  UpLeg: [0.12, 0.12, 1], Leg: [0, -1, 0], Foot: [0.02, -0.25, 1],
  Arm: [0.18, -0.6, 0.75], ForeArm: [-0.22, 0.28, 1],
};
const RIDING: Pose = {
  Hips: [0, 0.9, 0.42], Spine: [0, 0.88, 0.47], Spine1: [0, 0.88, 0.47], Spine2: [0, 0.9, 0.42], Neck: [0, 1, 0.2], Head: [0, 1, -0.05],
  // the arms are not here: they reach for the grips, wherever this bike has them
  UpLeg: [0.24, -0.28, 1], Leg: [0, -0.85, -0.5], Foot: [0.05, -0.2, 1],
};

let figure: Promise<{ root: THREE.Object3D; bones: Map<string, THREE.Object3D>; rest: Map<THREE.Object3D, THREE.Quaternion> }> | undefined;
const load = () =>
  (figure ??= new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/rider/model.glb`).then((gltf) => {
    const bones = new Map<string, THREE.Object3D>(), rest = new Map<THREE.Object3D, THREE.Quaternion>();
    gltf.scene.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      // "mixamorig:LeftArm", "LeftArm_27": the exporters each add their own wrapping
      bones.set(o.name.replace(/^mixamorig:?/i, '').replace(/_\d+$/, ''), o);
      rest.set(o, o.quaternion.clone());
    });
    if (!bones.has('Hips') || !bones.has('LeftUpLeg')) throw new Error('the rider figure has no skeleton this knows');
    return { root: gltf.scene, bones, rest };
  }));

const a = new THREE.Vector3(), b = new THREE.Vector3(), turn = new THREE.Quaternion(), world = new THREE.Quaternion(), parent = new THREE.Quaternion();

/** Turns one bone, by the shortest way round, until it points along `to`. Parents first. */
function aim(bone: THREE.Object3D, to: V3) {
  bone.updateWorldMatrix(true, true);
  bone.getWorldPosition(a);
  bone.children[0].getWorldPosition(b);
  turn.setFromUnitVectors(b.sub(a).normalize(), a.set(...to).normalize());
  bone.getWorldQuaternion(world).premultiply(turn);
  bone.parent!.getWorldQuaternion(parent);
  bone.quaternion.copy(parent.invert().multiply(world));
}

/** Where a bike's grips are, in the space of its leaning frame: half the distance between them, their height, and how far forward. */
function findGrips(frame: THREE.Object3D, hips: THREE.Vector3, shoulderUp: number): V3 {
  // The bar ends are the widest part of the bike a hand could rest on: ahead of the rider and a forearm or so
  // below his shoulders. (The mirrors are wider still, but higher.)
  const v = new THREE.Vector3();
  let wide = 0, up = 0, along = 0, n = 0;
  for (let pass = 0; pass < 2; pass++) {
    frame.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        frame.worldToLocal(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
        if (v.z < hips.z + 0.3 || v.z > hips.z + 0.95 || v.y < shoulderUp - 0.5 || v.y > shoulderUp - 0.25) continue;
        if (pass === 0) wide = Math.max(wide, Math.abs(v.x));
        else if (Math.abs(v.x) > wide - 0.03) (up += v.y), (along += v.z), n++;
      }
    });
  }
  // nothing there to hold: a bar of the usual size where it usually is
  return n && wide > 0.2 ? [wide - 0.07, up / n, along / n] : [0.3, shoulderUp - 0.35, hips.z + 0.6];
}

/**
 * Puts the driver in a car, his eyes where the cockpit camera is, or the rider on a bike's saddle.
 * A vehicle that cannot have him (the figure failed to load) simply goes without.
 */
export async function seatRider(model: CarModel): Promise<CarModel> {
  try {
    const { root, bones, rest } = await load();
    const spec = model.spec, bike = !!model.lean;
    for (const [bone, q] of rest) bone.quaternion.copy(q);
    const pose: Pose = { ...(bike ? RIDING : DRIVING) };
    const [eyeX, eyeY, eyeZ] = spec.cockpitCamera;
    if (!bike) {
      // The lower the seat, the further the legs stretch: in a supercar they lie almost flat, and never go through the floor.
      const shin = bones.get('LeftLeg')!.children[0].position.length();
      const drop = THREE.MathUtils.clamp(eyeY - 0.62 - spec.groundClearance - 0.14, 0.04, shin * 0.9) / shin;
      pose.Leg = [0, -drop, Math.sqrt(1 - drop * drop)];
    }
    for (const [name, [x, y, z]] of Object.entries(pose)) {
      const centre = bones.get(name);
      if (centre) aim(centre, [x, y, z]);
      else {
        aim(bones.get(`Left${name}`)!, [x, y, z]);
        aim(bones.get(`Right${name}`)!, [-x, y, z]);
      }
    }
    const hipsAt = bones.get('Hips')!.getWorldPosition(new THREE.Vector3());
    if (bike) {
      const [up, along] = spec.imported?.seat ?? [spec.height * 0.72, -spec.length * 0.13];
      model.lean!.updateWorldMatrix(true, true);
      const shoulder = bones.get('LeftArm')!.getWorldPosition(new THREE.Vector3());
      const seat = new THREE.Vector3(0, up, along);
      const [gx, gy, gz] = spec.imported?.grips ?? findGrips(model.lean!, seat, up + shoulder.y - hipsAt.y);
      for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
        // Shoulder, elbow, wrist: the wrist goes a palm's width short of the grip, and the elbow hangs down and out.
        const arm = bones.get(`${side}Arm`)!, fore = bones.get(`${side}ForeArm`)!, hand = bones.get(`${side}Hand`)!;
        const s = arm.getWorldPosition(new THREE.Vector3()), e = fore.getWorldPosition(new THREE.Vector3()), h = hand.getWorldPosition(new THREE.Vector3());
        const upper = s.distanceTo(e), lower = e.distanceTo(h);
        const to = new THREE.Vector3(sign * gx, gy, gz).sub(seat).add(hipsAt).sub(s);
        const reach = Math.min(to.length() - 0.07, (upper + lower) * 0.995);
        to.normalize();
        const near = (upper * upper - lower * lower + reach * reach) / (2 * reach);
        const out = new THREE.Vector3(sign * 0.5, -1, -0.2).addScaledVector(to, -to.dot(new THREE.Vector3(sign * 0.5, -1, -0.2))).normalize();
        const elbow = to.clone().multiplyScalar(near).addScaledVector(out, Math.sqrt(Math.max(0, upper * upper - near * near)));
        aim(arm, elbow.toArray());
        aim(fore, to.multiplyScalar(reach).sub(elbow).toArray());
      }
    }
    // hands that hold something: the fingers curl
    for (const [name, bone] of bones) if (/Hand(Index|Middle|Ring|Pinky)[123]$/.test(name)) bone.rotateX(0.85);
    root.updateWorldMatrix(true, true);

    // Frozen: every vertex goes where its bones have carried it, and the skeleton is left behind.
    const still = new THREE.Group();
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    root.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (!skinned.isSkinnedMesh || Array.isArray(skinned.material) || /teeth/i.test(skinned.material.name)) return;
      const from = skinned.geometry, pos = from.attributes.position, nor = from.attributes.normal;
      const g = new THREE.BufferGeometry();
      const at = new Float32Array(pos.count * 3), up = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        n.fromBufferAttribute(nor, i).multiplyScalar(0.01).add(p);
        skinned.applyBoneTransform(i, p).applyMatrix4(skinned.matrixWorld);
        skinned.applyBoneTransform(i, n).applyMatrix4(skinned.matrixWorld).sub(p).normalize();
        p.toArray(at, i * 3);
        n.toArray(up, i * 3);
      }
      g.setAttribute('position', new THREE.BufferAttribute(at, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(up, 3));
      if (from.attributes.uv) g.setAttribute('uv', from.attributes.uv);
      g.setIndex(from.index);
      still.add(new THREE.Mesh(g, skinned.material));
    });

    const rider = new THREE.Group();
    rider.name = 'rider';
    const hips = bones.get('Hips')!.getWorldPosition(new THREE.Vector3());
    const eyes = bones.get('Head')!.children[0].getWorldPosition(new THREE.Vector3()).lerp(bones.get('Head')!.getWorldPosition(p), 0.55);
    eyes.z += 0.09;
    if (bike) {
      // on the saddle, and the cockpit camera becomes his eyes
      const [up, along] = spec.imported?.seat ?? [spec.height * 0.72, -spec.length * 0.13];
      still.position.copy(hips).negate();
      mergeInto(still, rider);
      rider.position.set(0, up, along);
      spec.cockpitCamera = [0, up + eyes.y - hips.y + 0.04, along + eyes.z - hips.z + 0.1];
      model.lean!.add(rider);
    } else {
      still.position.copy(eyes).negate();
      mergeInto(still, rider);
      rider.position.set(eyeX, eyeY - rideHeight(spec), eyeZ);
      model.group.add(rider);
    }
    model.rider = rider;
  } catch (err) {
    console.warn('No driver: the figure could not be seated', err);
  }
  return model;
}
