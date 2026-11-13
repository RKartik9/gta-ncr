export interface CarSpec {
  id: string;
  name: string;
  /** folder under public/models holding scene.gltf. Absent: the built-in hatchback. */
  model?: string;
  credit?: string;

  /** kilograms and metres */
  mass: number;
  length: number;
  width: number;
  height: number;
  groundClearance: number;
  /** height of the centre of mass above the road */
  centreOfMass: number;

  wheelRadius: number;
  /** half the distance between the left and right wheels */
  track: number;
  /** distance of each axle from the middle of the car; front is +z */
  axleFront: number;
  axleRear: number;
  suspensionRest: number;
  suspensionStiffness: number;

  drive: 'fwd' | 'awd';
  /** newtons at full throttle, shared between the driven wheels */
  engineForce: number;
  reverseForce: number;
  /** metres per second squared */
  brakeDecel: number;
  /** metres per second */
  topSpeed: number;
  reverseSpeed: number;
  maxSteer: number;
  gripFront: number;
  gripRear: number;

  /** engine recording's pitch for this car: above 1 sounds higher and more highly strung */
  enginePitch: number;

  /** camera positions in car space: x left, y above the road, z towards the nose */
  hoodCamera: [number, number, number];
  cockpitCamera: [number, number, number];
}

/** Height of the chassis origin above the road when the car sits at rest. */
export const rideHeight = (c: CarSpec) => c.groundClearance + (c.height - c.groundClearance) * 0.42;

/** Suspension length at rest: the spring sags until four wheels carry the car's weight. */
export const restLength = (c: CarSpec) => c.suspensionRest - 9.81 / (4 * c.suspensionStiffness);

/** Where the suspension meets the chassis, in chassis space. */
export const axleHeight = (c: CarSpec) => c.wheelRadius - rideHeight(c) + restLength(c);

// Published figures: 4.98 x 2.10 x 1.13 m, 2.70 m wheelbase, about 1.6 t dry, 0-100 km/h in 2.8 s, 350 km/h.
export const SIAN: CarSpec = {
  id: 'sian',
  enginePitch: 1.25,
  name: 'Lamborghini Sián FKP 37',
  model: 'sian',
  credit: '"2020 Lamborghini Sián FKP 37" by Ddiaz Design (sketchfab.com/ddiaz-design), CC BY 4.0',
  mass: 1700,
  length: 4.98,
  width: 2.1,
  height: 1.133,
  groundClearance: 0.12,
  centreOfMass: 0.33,
  wheelRadius: 0.355,
  track: 0.85,
  axleFront: 1.3,
  axleRear: -1.4,
  suspensionRest: 0.2,
  suspensionStiffness: 60,
  drive: 'awd',
  engineForce: 19000,
  reverseForce: 6000,
  brakeDecel: 12,
  topSpeed: 97,
  reverseSpeed: 10,
  maxSteer: 0.5,
  gripFront: 2.4,
  gripRear: 2.3,
  hoodCamera: [0, 0.98, 0.75],
  cockpitCamera: [0.37, 0.93, 0.02],
};

// Published figures: 4.87 x 1.98 x 1.97 m, 2.89 m wheelbase, about 2.6 t, 0-100 km/h in 4.4 s, limited to 220 km/h.
export const G63: CarSpec = {
  id: 'g63',
  enginePitch: 0.85,
  name: 'Mercedes-AMG G 63',
  model: 'g63',
  credit: '"2025 Mercedes-Benz G-Class AMG G 63" by Ddiaz Design (sketchfab.com/ddiaz-design), CC BY-NC-SA 4.0',
  mass: 2640,
  length: 4.873,
  width: 1.984,
  height: 1.966,
  groundClearance: 0.24,
  centreOfMass: 0.52,
  wheelRadius: 0.39,
  track: 0.83,
  axleFront: 1.6,
  axleRear: -1.29,
  suspensionRest: 0.34,
  suspensionStiffness: 26,
  drive: 'awd',
  engineForce: 20000,
  reverseForce: 9000,
  brakeDecel: 9.5,
  topSpeed: 61,
  reverseSpeed: 10,
  maxSteer: 0.55,
  gripFront: 1.45,
  gripRear: 1.4,
  hoodCamera: [0, 1.72, 0.85],
  cockpitCamera: [0.42, 1.5, 0.1],
};

/** Stand-in used when a model file is missing: a small hatchback built from code. */
export const HATCHBACK: CarSpec = {
  id: 'hatchback',
  enginePitch: 1.05,
  name: 'Hatchback',
  mass: 1080,
  length: 3.84,
  width: 1.68,
  height: 1.5,
  groundClearance: 0.2,
  centreOfMass: 0.36,
  wheelRadius: 0.31,
  track: 0.74,
  axleFront: 1.24,
  axleRear: -1.22,
  suspensionRest: 0.26,
  suspensionStiffness: 34,
  drive: 'fwd',
  engineForce: 5200,
  reverseForce: 3000,
  brakeDecel: 8.5,
  topSpeed: 38,
  reverseSpeed: 9,
  maxSteer: 0.56,
  gripFront: 1.8,
  gripRear: 1.7,
  hoodCamera: [0, 1.16, 0.78],
  cockpitCamera: [-0.37, 1.2, -0.12],
};

export const CARS: CarSpec[] = [SIAN, G63];
