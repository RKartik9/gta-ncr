import * as THREE from 'three/webgpu';
import { luminance, materialColor, mix as blend, step, uniform } from 'three/tsl';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { type Pose, applyPose, loadFigure } from '../vehicle/rider.ts';
import { ARM_L, ARM_R, CHEST, FORE_L, FORE_R, HEAD, PELVIS, SHIN_L, SHIN_R, THIGH_L, THIGH_R } from './ragdoll.ts';
import { CYCLES, POSES, type PoseName } from './poses.ts';

// A figure that moves: the same people as on the pavements and at the wheel, but with their bones left in, so
// they can be bent from one pose to another every frame, or laid along the pieces of a falling body.

/** The bones that are moved, parents first; the fingers and the rest stay as they were made. */
const BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
] as const;
const PARENT = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 0, 14, 15, 0, 17, 18];
/** which piece of a falling body (ragdoll.ts) each bone lies along */
const PIECE = [PELVIS, PELVIS, CHEST, CHEST, HEAD, HEAD, CHEST, ARM_L, FORE_L, FORE_L, CHEST, ARM_R, FORE_R, FORE_R, THIGH_L, SHIN_L, SHIN_L, THIGH_R, SHIN_R, SHIN_R];
export const HIPS = 0, SPINE = 1, SPINE1 = 2, SPINE2 = 3, NECK = 4, HEAD_BONE = 5, LEFT_HAND = 9, RIGHT_HAND = 13, LEFT_FOOT = 16, RIGHT_FOOT = 19;
/** the bones above the hips: what a punch or a guard takes over while the legs go on walking */
export const UPPER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/** A pose as it is kept: each moved bone's turn against its parent. */
export type Baked = THREE.Quaternion[];

const clean = (name: string) => name.replace(/^mixamorig:?/i, '').replace(/_\d+$/, '');

/** What is worked out once for each figure file and shared by every copy of it. */
export interface Source {
  file: string;
  scene: THREE.Object3D;
  /** every bone's turn as the figure was made, by the bone's own name */
  rest: Map<string, THREE.Quaternion>;
  poses: Record<PoseName, Baked>;
  walk: Baked[];
  run: Baked[];
  /** which way round the hips' parent is: the figure's files differ in what they hang the skeleton from */
  root: THREE.Quaternion;
  /** each bone's turn in the world when the figure stands straight: what a fallen body's pieces are measured from */
  straight: THREE.Quaternion[];
  /** as modelled: how tall the figure stands, how far its soles are from its origin, and how high its hips are above them */
  tall: number;
  sole: number;
  hips: number;
}

const sources = new Map<string, Promise<Source>>();

/** A figure file under public/models, read and measured: every pose worked out for its skeleton. */
export function loadSource(file: string): Promise<Source> {
  let source = sources.get(file);
  if (!source) sources.set(file, (source = loadFigure(file).then(({ root, bones, rest }) => {
    const moved = BONES.map((name) => {
      const bone = bones.get(name);
      if (!bone) throw new Error(`${file} has no ${name} bone`);
      return bone;
    });
    if (moved.some((b, i) => i > 0 && b.parent !== moved[PARENT[i]])) throw new Error(`${file} has a skeleton joined up differently`);
    const reset = () => {
      for (const [bone, q] of rest) bone.quaternion.copy(q);
    };
    const bake = (pose: Pose): Baked => {
      reset();
      applyPose(bones, pose);
      return moved.map((b) => b.quaternion.clone());
    };
    const poses = Object.fromEntries(Object.entries(POSES).map(([name, pose]) => [name, bake(pose)])) as Record<PoseName, Baked>;
    const walk = CYCLES.walk.map(bake), run = CYCLES.run.map(bake);
    root.updateWorldMatrix(true, true);
    const hipsParent = moved[0].parent!.getWorldQuaternion(new THREE.Quaternion());
    const straight: THREE.Quaternion[] = [];
    poses.straight.forEach((q, i) => straight.push((i ? straight[PARENT[i]] : hipsParent).clone().multiply(q)));

    // measured standing: every few vertices is plenty to find the top of the head and the soles of the feet
    reset();
    applyPose(bones, POSES.stand);
    root.updateWorldMatrix(true, true);
    let top = -Infinity, sole = Infinity;
    const p = new THREE.Vector3();
    root.traverse((o) => {
      const skinned = o as THREE.SkinnedMesh;
      if (!skinned.isSkinnedMesh) return;
      const pos = skinned.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 5) {
        skinned.applyBoneTransform(i, p.fromBufferAttribute(pos, i)).applyMatrix4(skinned.matrixWorld);
        top = Math.max(top, p.y);
        sole = Math.min(sole, p.y);
      }
    });
    const hips = moved[0].getWorldPosition(p).y - sole;
    reset();
    return {
      file, scene: root, rest: new Map([...rest].map(([bone, q]) => [bone.name, q.clone()])), poses, walk, run,
      root: hipsParent, straight, tall: top - sole, sole, hips,
    };
  })));
  return source;
}

const _q = new THREE.Quaternion(), _parent = new THREE.Quaternion(), _turn = new THREE.Quaternion();
const _world = BONES.map(() => new THREE.Quaternion());

/** One person, bones and all. `group` stands on the ground where the person does, turned the way they face. */
export class Figure {
  readonly group = new THREE.Group();
  readonly source: Source;
  /** metres the hips are let down: crouching, or lying where the physics left them */
  drop = 0;
  /** metres from the soles to the hips, standing, at this figure's size */
  hipHeight = 1;
  private inner: THREE.Object3D;
  private bones: THREE.Object3D[];
  private scale = 1;
  /** what they are wearing, as on the pavement (pedestrians.ts dyes the same way); black is the clothes as made */
  private top = uniform(new THREE.Color(0, 0, 0));
  private bottom = uniform(new THREE.Color(0, 0, 0));

  constructor(source: Source) {
    this.source = source;
    this.inner = clone(source.scene);
    const byName = new Map<string, THREE.Object3D>();
    this.inner.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        // its bounds are where it stood when it was made, not where its bones have carried it since
        mesh.frustumCulled = false;
        if (!Array.isArray(mesh.material) && /teeth/i.test(mesh.material.name)) mesh.visible = false;
        const m = mesh.material as THREE.MeshStandardMaterial;
        const dye = /Outfit_Top/.test(m.name) ? this.top : /Outfit_Bottom/.test(m.name) ? this.bottom : null;
        if (dye) {
          // this figure's own clothes, dyed: the texture's light and shade, the copy's colour
          const node = new THREE.MeshStandardNodeMaterial();
          node.copy(m as unknown as THREE.MeshStandardNodeMaterial);
          node.colorNode = blend(materialColor, luminance(materialColor).mul(1.7).mul(dye).min(1), step(0.001, dye.x.add(dye.y).add(dye.z)).mul(0.85));
          mesh.material = node;
        }
      }
      if (!(o as THREE.Bone).isBone) return;
      // the copy is taken from a figure that may have been left in any pose
      const rest = source.rest.get(o.name);
      if (rest) o.quaternion.copy(rest);
      // hands that are fists
      if (/Hand(Index|Middle|Ring|Pinky)[123]$/.test(clean(o.name))) o.rotateX(0.95);
      byName.set(clean(o.name), o);
    });
    this.bones = BONES.map((name) => byName.get(name)!);
    this.group.add(this.inner);
    this.setHeight(1.75);
    this.snap(source.poses.stand);
  }

  /** Dressed as someone on the pavement was; null or black for the clothes as made. */
  dress(top: THREE.Color | null, bottom: THREE.Color | null) {
    this.top.value.copy(top ?? new THREE.Color(0, 0, 0));
    this.bottom.value.copy(bottom ?? new THREE.Color(0, 0, 0));
  }

  /** Stands the figure `metres` tall. */
  setHeight(metres: number) {
    this.scale = metres / this.source.tall;
    this.hipHeight = this.source.hips * this.scale;
    this.inner.scale.setScalar(this.scale);
  }

  /** Into a pose at once. */
  snap(pose: Baked) {
    this.bones.forEach((b, i) => b.quaternion.copy(pose[i]));
  }

  /** Eases every bone a share `k` of the way to `pose`. */
  ease(pose: Baked, k: number) {
    this.bones.forEach((b, i) => b.quaternion.slerp(pose[i], k));
  }

  /**
   * Eases the bones towards the pieces of a falling body: `rotation(piece)` is how each piece has turned from
   * standing straight, facing the way the world's z runs. The group is left where it is, and must not be turned.
   */
  follow(rotation: (piece: number) => { x: number; y: number; z: number; w: number }, k: number) {
    const { straight, root } = this.source;
    this.bones.forEach((b, i) => {
      const r = rotation(PIECE[i]);
      _world[i].set(r.x, r.y, r.z, r.w).multiply(straight[i]);
      if (i) _parent.copy(_world[PARENT[i]]);
      else _parent.copy(this.group.quaternion).multiply(root);
      b.quaternion.slerp(_q.copy(_parent).invert().multiply(_world[i]), k);
    });
  }

  /**
   * Turns one bone, and everything hanging from it, by `angle` about `axis` (in the world): for what is laid over
   * a pose rather than part of it, such as a body twisting into a punch or a head snapped back by one.
   */
  bend(bone: number, axis: THREE.Vector3, angle: number) {
    if (Math.abs(angle) < 1e-4) return;
    const b = this.bones[bone];
    b.parent!.getWorldQuaternion(_parent);
    _turn.setFromAxisAngle(axis, angle);
    b.quaternion.premultiply(_q.copy(_parent).invert().multiply(_turn).multiply(_parent));
  }

  /** Turns the group to face `yaw` and leaves the body exactly as it lay: for getting up from where it fell. */
  turnKeeping(yaw: number) {
    const { root } = this.source, hips = this.bones[HIPS];
    _q.copy(this.group.quaternion).multiply(root).multiply(hips.quaternion);
    this.group.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    hips.quaternion.copy(_parent.copy(this.group.quaternion).multiply(root).invert().multiply(_q));
  }

  /** After the bones and the group have been moved this frame: everything below is put where it now belongs. */
  refresh() {
    this.inner.position.y = -this.source.sole * this.scale - this.drop;
    this.group.updateMatrixWorld(true);
  }

  /** Where a moved bone is in the world, as of the last `refresh`. */
  at(bone: number, out: THREE.Vector3) {
    return out.setFromMatrixPosition(this.bones[bone].matrixWorld);
  }
}

/** Fills `out` with the pose a share `t` of the way from `a` to `b`. */
export function mix(out: Baked, a: Baked, b: Baked, t: number, only?: number[]) {
  if (only) for (const i of only) out[i].copy(a[i]).slerp(b[i], t);
  else for (let i = 0; i < out.length; i++) out[i].copy(a[i]).slerp(b[i], t);
  return out;
}

export const blank = (): Baked => BONES.map(() => new THREE.Quaternion());
