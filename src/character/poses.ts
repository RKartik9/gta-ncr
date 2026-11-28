import type { Pose, V3 } from '../vehicle/rider.ts';
import { runPose, walkPose } from '../world/pedestrians.ts';

// How people on foot hold themselves, in the same terms as the driver's seat (rider.ts): where each bone points,
// x to the figure's left, y up, z the way it faces. Parents come before children. There are no recorded
// movements in the figures' files: everything a fighter does is an easing from one of these to another.

/** frames to a stride, walking and running */
export const FRAMES = 8;

const UPRIGHT: Pose = { Hips: [0, 1, 0], Spine: [0, 1, 0.02], Spine1: [0, 1, 0.02], Spine2: [0, 1, 0], Neck: [0, 1, 0.08], Head: [0, 1, 0] };
const LEGS: Pose = { UpLeg: [0.04, -1, 0], Leg: [0, -1, 0], Foot: [0.03, -0.3, 1] };
/** leaning into it, chin down */
const SET: Pose = { Hips: [0, 1, 0.04], Spine: [0, 1, 0.1], Spine1: [0, 1, 0.14], Spine2: [0, 1, 0.14], Neck: [0, 1, 0.22], Head: [0, 1, 0.05] };
const LEFT_UP: Pose = { LeftArm: [0.22, -0.8, 0.55], LeftForeArm: [-0.25, 0.85, 0.55] };
const RIGHT_UP: Pose = { RightArm: [-0.28, -0.9, 0.2], RightForeArm: [0.25, 0.92, 0.3] };
/** A fighter's feet: the left foot leading, the right a step behind and turned out, both knees soft, weight low. */
const STANCE: Pose = {
  LeftUpLeg: [0.1, -1, 0.32], LeftLeg: [0, -1, -0.12], LeftFoot: [0.08, -0.3, 1],
  RightUpLeg: [-0.14, -1, -0.12], RightLeg: [0, -1, -0.32], RightFoot: [-0.3, -0.3, 1],
};
/** pushing off the back foot into a blow from the right: the heel up and the knee turned in */
const DRIVE: Pose = { ...STANCE, RightUpLeg: [-0.08, -1, -0.28], RightLeg: [0.1, -1, -0.15], RightFoot: [0.1, -0.7, 1] };

export const POSES = {
  stand: { ...UPRIGHT, ...LEGS, Arm: [0.16, -1, 0.02], ForeArm: [0.06, -1, 0.2] },
  /** straight as a post, arms by the sides: how a body knocked down is laid out before the physics has it (ragdoll.ts) */
  straight: {
    Hips: [0, 1, 0], Spine: [0, 1, 0], Spine1: [0, 1, 0], Spine2: [0, 1, 0], Neck: [0, 1, 0], Head: [0, 1, 0],
    UpLeg: [0, -1, 0], Leg: [0, -1, 0], Foot: [0, -0.25, 1], Arm: [0, -1, 0], ForeArm: [0, -1, 0],
  },
  /** fists up, the left leading */
  guard: { ...SET, ...LEGS, ...LEFT_UP, ...RIGHT_UP },
  /** squared up and still: the guard on bent legs, the left foot forward */
  fightStance: { ...SET, ...STANCE, ...LEFT_UP, ...RIGHT_UP },
  /** the left snapped straight out from the shoulder, the shoulder up to cover the chin, the right kept home */
  jab: { ...SET, Neck: [0, 1, 0.3], ...STANCE, LeftUpLeg: [0.1, -1, 0.42], LeftArm: [-0.1, 0.12, 1], LeftForeArm: [-0.08, 0.1, 1], ...RIGHT_UP },
  /** the right drawn back, and thrown across off the back foot */
  cock: { ...SET, ...STANCE, ...LEFT_UP, RightArm: [-0.42, -0.6, -0.3], RightForeArm: [0.2, 0.6, 0.75] },
  cross: { ...SET, Spine2: [0.08, 1, 0.3], Neck: [0, 1, 0.3], ...DRIVE, ...LEFT_UP, RightArm: [0.2, 0.12, 1], RightForeArm: [0.12, 0.08, 1] },
  /** both forearms up in front of the face */
  block: { ...SET, Neck: [0, 1, 0.3], ...LEGS, Arm: [0.2, -0.5, 0.85], ForeArm: [-0.25, 1, 0.12] },
  /** rocked back by a blow */
  flinch: {
    Hips: [0, 1, -0.05], Spine: [0, 1, -0.2], Spine1: [0, 1, -0.28], Spine2: [0, 1, -0.3], Neck: [0, 1, -0.3], Head: [0, 1, -0.25],
    ...LEGS, Arm: [0.6, -0.7, 0.2], ForeArm: [0.3, -0.4, 0.8],
  },
  /** a hockey stick in both hands: carried low across the body, drawn back over the right shoulder, and swung through */
  stickCarry: { ...UPRIGHT, ...LEGS, LeftArm: [0.2, -0.85, 0.4], LeftForeArm: [-0.4, -0.1, 1], RightArm: [-0.2, -0.9, 0.3], RightForeArm: [0.25, -0.2, 1] },
  stickCock: {
    Hips: [0, 1, -0.02], Spine: [-0.06, 1, -0.04], Spine1: [-0.1, 1, -0.06], Spine2: [-0.12, 1, -0.06], Neck: [0.05, 1, 0.12], Head: [0, 1, 0],
    ...STANCE, LeftUpLeg: [0.12, -1, 0.2], LeftArm: [-0.35, 0.35, 0.85], LeftForeArm: [-0.85, 0.55, -0.15], RightArm: [-0.65, 0.4, 0.05], RightForeArm: [0.05, 1, -0.45],
  },
  stickSwing: {
    Hips: [0, 1, 0.06], Spine: [0.03, 1, 0.18], Spine1: [0.05, 1, 0.25], Spine2: [0.06, 1, 0.28], Neck: [0, 1, 0.18], Head: [0, 1, 0],
    ...DRIVE, LeftArm: [0.3, -0.55, 0.75], LeftForeArm: [0.25, -0.15, 1], RightArm: [0.2, -0.3, 1], RightForeArm: [0.55, -0.05, 0.85],
  },
  /** after the swing: carried on through, the stick wrapped round to the left, the back foot come up onto its toe */
  stickFollow: {
    Hips: [0, 1, 0.04], Spine: [0.05, 1, 0.12], Spine1: [0.08, 1, 0.15], Spine2: [0.1, 1, 0.15], Neck: [-0.05, 1, 0.12], Head: [0, 1, 0],
    ...DRIVE, LeftArm: [0.75, -0.3, 0.3], LeftForeArm: [0.5, 0.35, -0.6], RightArm: [0.6, -0.15, 0.75], RightForeArm: [0.8, 0.3, -0.25],
  },
  /** a left hook: the elbow up and out, the fist coming round at the jaw */
  hookCock: { ...SET, ...STANCE, LeftArm: [0.6, -0.4, 0.5], LeftForeArm: [-0.2, 0.75, 0.6], ...RIGHT_UP },
  hook: { ...SET, Spine2: [-0.08, 1, 0.22], ...STANCE, LeftFoot: [-0.25, -0.3, 1], LeftArm: [0.6, 0.05, 0.8], LeftForeArm: [-0.97, 0.05, 0.25], ...RIGHT_UP },
  /** a right elbow: the arm folded tight and the point of it brought across at head height */
  elbowCock: { ...SET, ...STANCE, ...LEFT_UP, RightArm: [-0.75, 0.1, -0.2], RightForeArm: [0.3, -0.2, 0.9] },
  elbow: { ...SET, Spine2: [0.1, 1, 0.25], ...DRIVE, ...LEFT_UP, RightArm: [0.55, 0.12, 0.85], RightForeArm: [0.85, 0.15, -0.5] },
  /** a knee: hands round the other's neck pulling down, the right knee driven up into the belly */
  kneeCock: {
    ...SET, ...STANCE, LeftArm: [-0.05, 0.25, 1], LeftForeArm: [-0.45, 0.2, 0.9], RightArm: [0.05, 0.25, 1], RightForeArm: [0.45, 0.2, 0.9],
  },
  knee: {
    Hips: [0, 1, -0.08], Spine: [0, 1, -0.05], Spine1: [0, 1, 0.08], Spine2: [0, 1, 0.15], Neck: [0, 1, 0.25], Head: [0, 1, 0.05],
    LeftUpLeg: [0.06, -1, -0.05], LeftLeg: [0, -1, 0.05], LeftFoot: [0.03, -0.5, 1],
    RightUpLeg: [-0.05, 0.3, 1], RightLeg: [0, -1, -0.1], RightFoot: [0, -0.8, 0.5],
    LeftArm: [-0.05, 0.05, 1], LeftForeArm: [-0.4, -0.4, 0.8], RightArm: [0.05, 0.05, 1], RightForeArm: [0.4, -0.4, 0.8],
  },
  /** a right uppercut: dipped at the knees, then up from the hip under the chin */
  upperCock: {
    ...SET, Spine1: [-0.05, 1, 0.28], Spine2: [-0.05, 1, 0.25], UpLeg: [0.05, -1, 0.2], Leg: [0, -1, -0.12], Foot: [0.03, -0.3, 1],
    ...LEFT_UP, RightArm: [-0.25, -1, 0.05], RightForeArm: [0.05, -0.1, 1],
  },
  uppercut: {
    Hips: [0, 1, 0.03], Spine: [0, 1, 0.05], Spine1: [0.03, 1, 0.1], Spine2: [0.05, 1, 0.08], Neck: [0, 1, 0.15], Head: [0, 1, 0],
    ...LEGS, ...LEFT_UP, RightArm: [-0.05, -0.25, 1], RightForeArm: [0.05, 1, 0.35],
  },
  /** a front kick: the right knee brought up, then the foot driven out at the belly, leaning back to balance it */
  kickCock: {
    Hips: [0, 1, -0.04], Spine: [0, 1, -0.08], Spine1: [0, 1, -0.04], Spine2: [0, 1, 0.02], Neck: [0, 1, 0.12], Head: [0, 1, 0],
    LeftUpLeg: [0.05, -1, 0.02], LeftLeg: [0, -1, 0.04], LeftFoot: [0.03, -0.3, 1],
    RightUpLeg: [-0.06, 0.25, 1], RightLeg: [0, -1, 0.15], RightFoot: [0, -0.4, 1], ...LEFT_UP, ...RIGHT_UP,
  },
  kick: {
    Hips: [0, 1, -0.1], Spine: [0, 1, -0.18], Spine1: [0, 1, -0.15], Spine2: [0, 1, -0.05], Neck: [0, 1, 0.15], Head: [0, 1, 0.05],
    LeftUpLeg: [0.05, -1, -0.1], LeftLeg: [0, -1, 0.12], LeftFoot: [0.03, -0.3, 1],
    RightUpLeg: [-0.05, 0.15, 1], RightLeg: [-0.02, 0.18, 1], RightFoot: [0, 0.6, 0.6],
    LeftArm: [0.45, -0.6, 0.45], LeftForeArm: [-0.1, 0.6, 0.8], RightArm: [-0.45, -0.75, -0.1], RightForeArm: [0.2, 0.5, 0.8],
  },
  /** a roundhouse: the right leg chambered out to the side, then the shin swung across at the ribs, the body turning over it */
  roundCock: {
    Hips: [0.1, 1, 0], Spine: [0.25, 1, -0.02], Spine1: [0.15, 1, 0], Spine2: [0.05, 1, 0.05], Neck: [-0.1, 1, 0.1], Head: [0, 1, 0],
    LeftUpLeg: [0.08, -1, 0], LeftLeg: [0, -1, 0.05], LeftFoot: [0.03, -0.3, 1],
    RightUpLeg: [-0.75, 0.15, 0.55], RightLeg: [-0.3, -0.2, -0.9], RightFoot: [-0.3, -0.3, -1], ...LEFT_UP, ...RIGHT_UP,
  },
  roundhouse: {
    Hips: [0.15, 1, -0.05], Spine: [0.35, 1, -0.05], Spine1: [0.2, 1, 0], Spine2: [0.05, 1, 0.05], Neck: [-0.15, 1, 0.1], Head: [0, 1, 0],
    LeftUpLeg: [0.1, -1, 0], LeftLeg: [0, -1, 0.08], LeftFoot: [0.03, -0.3, 1],
    RightUpLeg: [-0.25, 0.25, 1], RightLeg: [0.5, 0.25, 0.85], RightFoot: [0.7, 0, 0.7],
    LeftArm: [0.5, -0.6, 0.4], LeftForeArm: [-0.2, 0.7, 0.6], RightArm: [-0.6, -0.7, -0.2], RightForeArm: [0, -0.6, 0.8],
  },
  /** a stamp down on someone lying at their feet */
  stomp: {
    Hips: [0, 1, 0.05], Spine: [0, 1, 0.2], Spine1: [0, 1, 0.22], Spine2: [0, 1, 0.2], Neck: [0, 1, 0.35], Head: [0, 1, 0.3],
    LeftUpLeg: [0.05, -1, -0.12], LeftLeg: [0, -1, 0.1], LeftFoot: [0.03, -0.3, 1],
    RightUpLeg: [-0.05, -0.75, 0.65], RightLeg: [0, -1, 0.08], RightFoot: [0, -0.3, 1],
    Arm: [0.35, -0.85, 0.2], ForeArm: [0.1, -0.4, 0.9],
  },
  /** folded over a blow to the belly */
  gut: {
    Hips: [0, 1, 0.1], Spine: [0, 1, 0.45], Spine1: [0, 1, 0.6], Spine2: [0, 1, 0.6], Neck: [0, 1, 0.5], Head: [0, 1, 0.2],
    UpLeg: [0.05, -1, 0.25], Leg: [0, -1, -0.15], Foot: [0.03, -0.3, 1], Arm: [0.1, -0.8, 0.6], ForeArm: [-0.5, 0.1, 0.85],
  },
  /** ducking under a blow: down at the knees, head off the line */
  duck: {
    Hips: [0, 1, 0.15], Spine: [0, 1, 0.4], Spine1: [0.15, 1, 0.45], Spine2: [0.1, 1, 0.4], Neck: [0, 1, 0.3], Head: [0, 1, 0],
    UpLeg: [0.08, -1, 0.5], Leg: [0, -1, -0.3], Foot: [0.03, -0.3, 1], ...LEFT_UP, ...RIGHT_UP,
  },
  /** the stick raised over the head, and brought straight down */
  stickHigh: {
    Hips: [0, 1, -0.02], Spine: [0, 1, -0.1], Spine1: [0, 1, -0.12], Spine2: [0, 1, -0.1], Neck: [0, 1, 0.1], Head: [0, 1, 0],
    ...LEGS, LeftArm: [0.05, 0.9, 0.35], LeftForeArm: [-0.2, 0.9, -0.4], RightArm: [-0.15, 0.9, 0.3], RightForeArm: [0.2, 0.9, -0.4],
  },
  stickChop: {
    Hips: [0, 1, 0.08], Spine: [0, 1, 0.25], Spine1: [0, 1, 0.3], Spine2: [0, 1, 0.25], Neck: [0, 1, 0.2], Head: [0, 1, 0],
    UpLeg: [0.05, -1, 0.15], Leg: [0, -1, -0.05], Foot: [0.03, -0.3, 1],
    LeftArm: [0.1, -0.3, 1], LeftForeArm: [-0.1, -0.5, 1], RightArm: [-0.05, -0.25, 1], RightForeArm: [0.1, -0.45, 1],
  },
  /** a rifle shouldered: the right hand on the grip under the chin, the left out along the handguard, head down to the sights */
  rifle: {
    Hips: [0, 1, 0], Spine: [0, 1, 0.04], Spine1: [0.02, 1, 0.06], Spine2: [0.04, 1, 0.06], Neck: [-0.04, 1, 0.22], Head: [-0.02, 1, 0.1],
    LeftArm: [0.05, -0.45, 1], LeftForeArm: [-0.3, 0.12, 1], RightArm: [-0.55, -0.55, 0.35], RightForeArm: [0.6, 0.15, 0.8],
  },
  /** on the way up off the ground: knees under the body, a hand down */
  crouch: {
    Hips: [0, 1, 0.3], Spine: [0, 1, 0.5], Spine1: [0, 1, 0.55], Spine2: [0, 1, 0.55], Neck: [0, 1, 0.15], Head: [0, 1, -0.2],
    UpLeg: [0.14, -0.2, 1], Leg: [0, -1, -0.75], Foot: [0.03, -0.3, 1], Arm: [0.25, -0.9, 0.45], ForeArm: [0, -1, 0.3],
  },
} satisfies Record<string, Pose>;
export type PoseName = keyof typeof POSES;

/** metres the hips come down in the crouch */
export const CROUCH_DROP = 0.42;

/** the strides, frame by frame */
export const CYCLES = {
  walk: Array.from({ length: FRAMES }, (_, k) => walkPose(k)),
  run: Array.from({ length: FRAMES }, (_, k) => runPose(k, FRAMES)),
};

/** Where the stick points from the hands that hold it, in the figure's space, in each of its three poses. */
export const STICK_AIM = {
  carry: [0.5, -0.3, 0.8], cock: [-0.45, 0.8, -0.5], swing: [0.85, -0.35, 0.4], follow: [0.6, 0.2, -0.8], high: [0.05, 0.55, -0.8], chop: [0.05, -0.6, 0.8],
} satisfies Record<string, V3>;
