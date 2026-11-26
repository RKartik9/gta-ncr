import * as THREE from 'three/webgpu';
import { luminance, materialColor, mix as blend, step, uniform } from 'three/tsl';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { type Pose, applyPose, loadFigure } from '../vehicle/rider.ts';
import { ARM_L, ARM_R, CHEST, FORE_L, FORE_R, HEAD, PELVIS, SHIN_L, SHIN_R, THIGH_L, THIGH_R } from './ragdoll.ts';
import { CYCLES, POSES, type PoseName } from './poses.ts';
import { clamp } from '../util.ts';
import { blot } from './blood.ts';

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
export const HIPS = 0, SPINE = 1, SPINE1 = 2, SPINE2 = 3, NECK = 4, HEAD_BONE = 5, LEFT_ARM = 7, LEFT_HAND = 9, RIGHT_ARM = 11, RIGHT_HAND = 13, LEFT_FOOT = 16, RIGHT_FOOT = 19;
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
  /**
   * each hand's own frame, left then right, in the space of its bone: x along the fingers, y out of the palm.
   * Null for a figure with no fingers to tell it by.
   */
  grips: (THREE.Quaternion | null)[];
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
    // which way round each hand is, from where its middle finger and its thumb leave the wrist
    const grips = ['Left', 'Right'].map((side, right) => {
      const middle = bones.get(`${side}HandMiddle1`), thumb = bones.get(`${side}HandThumb1`);
      if (!middle || !thumb) return null;
      const fingers = middle.position.clone().normalize(), palm = new THREE.Vector3();
      if (right) palm.crossVectors(thumb.position, fingers);
      else palm.crossVectors(fingers, thumb.position);
      palm.normalize();
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fingers, palm, new THREE.Vector3().crossVectors(fingers, palm)));
    });
    return {
      file, scene: root, rest: new Map([...rest].map(([bone, q]) => [bone.name, q.clone()])), poses, walk, run,
      root: hipsParent, straight, grips, tall: top - sole, sole, hips,
    };
  })));
  return source;
}

const _q = new THREE.Quaternion(), _parent = new THREE.Quaternion(), _turn = new THREE.Quaternion();
const _world = BONES.map(() => new THREE.Quaternion());
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _to = new THREE.Vector3(), _pole = new THREE.Vector3(), _elbow = new THREE.Vector3();
const _upper = new THREE.Quaternion(), _fore = new THREE.Quaternion(), _hand = new THREE.Quaternion(), _twist = new THREE.Quaternion();
const _basis = new THREE.Matrix4(), _same = new THREE.Quaternion();
/** how tightly the fingers are closed, radians at each joint: a fist */
const FIST = 0.95;

/** wounds one body can show at once: past that the oldest go */
const WOUNDS = 14;
/** seconds a wound's blood takes to soak out into the clothes round it */
const SOAKS = 5;
const _line = new THREE.Ray(), _normal = new THREE.Vector3(), _point = new THREE.Vector3(), _near = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3(), _met = new THREE.Vector3(), _inverse = new THREE.Matrix4();
const FACING = new THREE.Vector3(0, 0, 1);
/** metres from a line within which a bone's skin may lie across it, and a triangle's corner must be for the triangle to */
const BONE_REACH = 0.32, CORNER_REACH = 0.07;

/** For each bone of a skin, the triangles it moves most: worked out once for each shape, which every copy of a figure shares. */
function trianglesByBone(skin: THREE.SkinnedMesh): Uint32Array[] {
  const g = skin.geometry;
  if (g.userData.byBone) return g.userData.byBone;
  const index = g.attributes.skinIndex, weight = g.attributes.skinWeight, lists: number[][] = skin.skeleton.bones.map(() => []);
  const corners = g.index ? g.index.count : g.attributes.position.count;
  for (let t = 0; t < corners; t += 3) {
    const a = g.index ? g.index.getX(t) : t;
    let most = 0;
    for (let k = 1; k < 4; k++) if (weight.getComponent(a, k) > weight.getComponent(a, most)) most = k;
    lists[index.getComponent(a, most)].push(t);
  }
  return (g.userData.byBone = lists.map((l) => Uint32Array.from(l)));
}
// the hole a round leaves, and the blood round it: both lie on the skin, drawn just over it
const over = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
const HOLE = new THREE.CircleGeometry(1, 10), SOAK = blot();
const holeMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x140101, roughness: 0.6, ...over });
const soakMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x5c0705, roughness: 0.3, ...over });

/** A wound as it is drawn, a metre across: for the renderer to build its shaders with before anyone is hurt. */
export function woundSample() {
  const mark = new THREE.Group(), soak = new THREE.Mesh(SOAK, soakMaterial), hole = new THREE.Mesh(HOLE, holeMaterial);
  hole.position.z = 0.0015;
  mark.add(soak, hole);
  return mark;
}

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
  /** the finger joints of each hand, left then right, and how each lay open */
  private fingers: { bone: THREE.Object3D; open: THREE.Quaternion }[][] = [[], []];
  private closed = [FIST, FIST];
  /** the bones as they were before something was laid over the pose for one frame (`overlay`) */
  private kept = BONES.map(() => new THREE.Quaternion());
  private laid = false;
  private skins: THREE.SkinnedMesh[] = [];
  private wounds: { mark: THREE.Group; soak: THREE.Mesh; age: number; size: number }[] = [];
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
        if (mesh.isSkinnedMesh && mesh.visible) this.skins.push(mesh);
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
      const finger = /^(Left|Right)Hand(Index|Middle|Ring|Pinky)[123]$/.exec(clean(o.name));
      if (finger) {
        this.fingers[finger[1] === 'Left' ? 0 : 1].push({ bone: o, open: o.quaternion.clone() });
        o.rotateX(FIST);
      }
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

  /**
   * A wound where the line from `from` along `dir` first meets the skin (as of the last `refresh`): a hole if
   * `hole` is its size in metres, and blood that soaks out to `soak` metres round it. It stays on that part of
   * the body from then on. Returns where it is, or null if the line misses them.
   */
  wound(from: THREE.Vector3, dir: THREE.Vector3, soak = 0.045, hole = 0.011) {
    // Every triangle of the skin, moved by its bones, is a lot to try: only those of the bones near the line are,
    // and of those only the ones with a corner near it. The wound belongs to the bone whose triangle it is.
    let nearest = 1.6, bone: THREE.Object3D | null = null;
    for (const skin of this.skins) {
      const g = skin.geometry, byBone = trianglesByBone(skin);
      _line.set(from, dir).applyMatrix4(_inverse.copy(skin.matrixWorld).invert());
      const shrunk = _line.direction.length();
      _line.direction.divideScalar(shrunk);
      skin.skeleton.bones.forEach((b, i) => {
        if (!byBone[i].length || _line.distanceSqToPoint(_near.setFromMatrixPosition(b.matrixWorld).applyMatrix4(_inverse)) > (BONE_REACH * shrunk) ** 2) return;
        for (const t of byBone[i]) {
          const a = g.index ? g.index.getX(t) : t, b2 = g.index ? g.index.getX(t + 1) : t + 1, c = g.index ? g.index.getX(t + 2) : t + 2;
          if (_line.distanceSqToPoint(skin.getVertexPosition(a, _va)) > (CORNER_REACH * shrunk) ** 2) continue;
          skin.getVertexPosition(b2, _vb);
          skin.getVertexPosition(c, _vc);
          if (!_line.intersectTriangle(_va, _vb, _vc, false, _met)) continue;
          const d = _met.applyMatrix4(skin.matrixWorld).distanceTo(from);
          if (d >= nearest) continue;
          nearest = d;
          bone = b;
          _point.copy(_met);
          _normal.crossVectors(_vb.sub(_va), _vc.sub(_va)).transformDirection(skin.matrixWorld);
        }
      });
    }
    if (!bone) return null;
    if (_normal.dot(dir) > 0) _normal.negate();

    let wound = this.wounds.length >= WOUNDS ? this.wounds.shift()! : null;
    if (!wound) {
      const mark = woundSample();
      wound = { mark, soak: mark.children[0] as THREE.Mesh, age: 0, size: 0 };
    }
    const mark = wound.mark;
    mark.removeFromParent();
    mark.position.copy(_point).addScaledVector(_normal, 0.002);
    mark.quaternion.setFromUnitVectors(FACING, _normal);
    mark.rotateZ(Math.random() * 6.3);
    mark.scale.setScalar(1);
    mark.updateMatrixWorld(true);
    (bone as THREE.Object3D).attach(mark);
    mark.children[1].visible = hole > 0;
    mark.children[1].scale.setScalar(hole);
    Object.assign(wound, { age: 0, size: soak });
    wound.soak.scale.setScalar(soak * 0.4);
    this.wounds.push(wound);
    return _point;
  }

  /** Every frame: the blood of each new wound soaks out round it. */
  bleed(dt: number) {
    for (const w of this.wounds) {
      if (w.age >= SOAKS) continue;
      w.age += dt;
      const k = Math.min(1, w.age / SOAKS);
      w.soak.scale.setScalar(w.size * (0.4 + 0.6 * (1 - (1 - k) ** 2)));
    }
  }

  /** Whole again: for a figure about to be someone else. */
  heal() {
    for (const w of this.wounds) w.mark.removeFromParent();
    this.wounds.length = 0;
  }

  /** How far a hand's fingers are closed (0 the left, 1 the right): radians at each joint, a fist by default. */
  close(hand: number, by = FIST) {
    if (this.closed[hand] === by) return;
    this.closed[hand] = by;
    for (const f of this.fingers[hand]) {
      f.bone.quaternion.copy(f.open);
      f.bone.rotateX(by);
    }
  }

  /**
   * From here until `unlay`, whatever is done to the bones is for this frame's picture only: the pose they were
   * easing through is kept, and put back before the next frame eases it on.
   */
  overlay() {
    if (this.laid) return;
    this.bones.forEach((b, i) => this.kept[i].copy(b.quaternion));
    this.laid = true;
  }

  unlay() {
    if (!this.laid) return;
    this.bones.forEach((b, i) => b.quaternion.copy(this.kept[i]));
    this.laid = false;
  }

  /**
   * An arm reaching: the wrist of the arm whose upper bone is `arm` is put at `target`, the elbow kept to the
   * `pole` side of the line from the shoulder to it, and the hand turned so its fingers run along `fingers` and
   * its palm faces `palm` (all in the world, as of the last `refresh`). The forearm takes most of the hand's turn
   * about its own length, as a real one does.
   */
  reach(arm: number, target: THREE.Vector3, pole: THREE.Vector3, fingers: THREE.Vector3, palm: THREE.Vector3) {
    const upper = this.bones[arm], fore = this.bones[arm + 1], hand = this.bones[arm + 2];
    const a = _a.setFromMatrixPosition(upper.matrixWorld), b = _b.setFromMatrixPosition(fore.matrixWorld), c = _c.setFromMatrixPosition(hand.matrixWorld);
    const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
    _to.copy(target).sub(a);
    // never quite straight: an arm at full stretch snaps about as the target moves
    const d = clamp(_to.length(), Math.abs(l1 - l2) + 0.01, (l1 + l2) * 0.985);
    _to.normalize();
    const along = (l1 * l1 + d * d - l2 * l2) / (2 * d), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    _pole.copy(pole).addScaledVector(_to, -pole.dot(_to)).normalize();
    _elbow.copy(a).addScaledVector(_to, along).addScaledVector(_pole, out);

    upper.getWorldQuaternion(_upper);
    fore.getWorldQuaternion(_fore);
    upper.parent!.getWorldQuaternion(_parent);
    // the upper arm swung to point at the elbow, and the forearm carried round with it and then on to the wrist
    _turn.setFromUnitVectors(b.sub(a).normalize(), _pole.copy(_elbow).sub(a).normalize());
    _upper.premultiply(_turn);
    _fore.premultiply(_turn);
    c.sub(_b.setFromMatrixPosition(fore.matrixWorld)).normalize().applyQuaternion(_turn);
    _turn.setFromUnitVectors(c, _pole.copy(a).addScaledVector(_to, d).sub(_elbow).normalize());
    _fore.premultiply(_turn);

    const grip = this.source.grips[arm === LEFT_ARM ? 0 : 1];
    if (grip) {
      _c.crossVectors(fingers, palm);
      _hand.setFromRotationMatrix(_basis.makeBasis(fingers, palm, _c)).multiply(_q.copy(grip).invert());
      // how much of the hand's turn is about the forearm's own length
      const rel = _q.copy(_fore).invert().multiply(_hand), axis = _c.copy(hand.position).normalize();
      const p = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
      _twist.set(axis.x * p, axis.y * p, axis.z * p, rel.w).normalize();
      _fore.multiply(_same.identity().slerp(_twist, 0.7));
      hand.quaternion.copy(_q.copy(_fore).invert().multiply(_hand));
    }
    upper.quaternion.copy(_parent.invert().multiply(_upper));
    fore.quaternion.copy(_q.copy(_upper).invert().multiply(_fore));
  }

  /** Into a pose at once. */
  snap(pose: Baked) {
    this.laid = false;
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
