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

  /** share of the car's weight on the front wheels, standing still */
  weightFront: number;
  /** how strongly each axle's anti-roll bar ties its two wheels, in the units of the suspension stiffness */
  antiRoll: number;
  /** share of that roll stiffness at the front (default 0.575). More at the front makes a car steadier, less eager to spin. */
  antiRollFront?: number;

  /** share of the engine's push sent to the front wheels: 1 front-wheel drive, 0 rear */
  driveFront: number;
  /** newtons at full throttle, shared between the driven wheels */
  engineForce: number;
  reverseForce: number;
  /** metres per second squared the brakes would manage if the tyres held: more than they can, so the anti-lock has work to do */
  brakeDecel: number;
  /** share of the braking done by the front wheels */
  brakeFront: number;
  /** metres per second */
  topSpeed: number;
  reverseSpeed: number;
  maxSteer: number;
  /** the tyres' peak grip as a share of the weight on them: about 1 for a road tyre, more for a supercar's */
  gripFront: number;
  gripRear: number;
  /** air drag, and the push down from wings and floor, in newtons per (m/s) squared */
  drag: number;
  downforce: number;

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
  centreOfMass: 0.44,
  wheelRadius: 0.355,
  track: 0.85,
  axleFront: 1.3,
  axleRear: -1.4,
  suspensionRest: 0.2,
  suspensionStiffness: 60,
  weightFront: 0.43,
  antiRoll: 20,
  driveFront: 0.3,
  engineForce: 19000,
  reverseForce: 6000,
  brakeDecel: 18,
  brakeFront: 0.62,
  topSpeed: 97,
  reverseSpeed: 10,
  maxSteer: 0.5,
  gripFront: 1.4,
  gripRear: 1.48,
  drag: 0.42,
  downforce: 0.5,
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
  centreOfMass: 0.78,
  wheelRadius: 0.39,
  track: 0.83,
  axleFront: 1.6,
  axleRear: -1.29,
  suspensionRest: 0.34,
  // Soft, as a tall body-on-frame car's is: 7-8 degrees of lean in a hard corner. With its weight 0.78 m up over
  // a 1.66 m track it is close to going over: a full-lock swerve one way and back from 90 km/h rolls it. The
  // roll stiffness it has is mostly at the front, which keeps it from spinning when it is thrown about.
  suspensionStiffness: 20,
  weightFront: 0.53,
  antiRoll: 2.2,
  antiRollFront: 0.85,
  driveFront: 0.4,
  engineForce: 20000,
  reverseForce: 9000,
  brakeDecel: 14,
  brakeFront: 0.64,
  topSpeed: 61,
  reverseSpeed: 10,
  maxSteer: 0.55,
  gripFront: 1.08,
  gripRear: 1.1,
  drag: 0.85,
  downforce: 0,
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
  centreOfMass: 0.54,
  wheelRadius: 0.31,
  track: 0.74,
  axleFront: 1.24,
  axleRear: -1.22,
  suspensionRest: 0.26,
  suspensionStiffness: 34,
  weightFront: 0.62,
  antiRoll: 6,
  driveFront: 1,
  engineForce: 5200,
  reverseForce: 3000,
  brakeDecel: 13,
  brakeFront: 0.68,
  topSpeed: 38,
  reverseSpeed: 9,
  maxSteer: 0.56,
  gripFront: 1.04,
  gripRear: 1.04,
  drag: 0.38,
  downforce: 0,
  hoodCamera: [0, 1.16, 0.78],
  cockpitCamera: [-0.37, 1.2, -0.12],
};

export const CARS: CarSpec[] = [SIAN, G63];
