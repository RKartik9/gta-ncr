import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CRETA, type CarSpec, HATCHBACK, THAR } from './cars.ts';
import { carShape, plainWheel } from './carModel.ts';

/** What the traffic needs to draw a vehicle: its body in one geometry with a group per material, and one wheel. */
export interface TrafficShape {
  shell: THREE.BufferGeometry;
  materials: THREE.Material[];
  wheel: THREE.BufferGeometry;
  wheelMaterials: THREE.Material[];
  /** which of `materials` takes each copy's colour, and which are the head and tail lamps */
  paint: number;
  head: number;
  tail: number;
}

/** A kind of vehicle in the traffic. Metres, kilograms and m/s; the body stands on the road at its origin, nose to +z. */
export interface TrafficKind {
  id: string;
  length: number;
  width: number;
  height: number;
  mass: number;
  centreOfMass: number;
  wheelRadius: number;
  /** where each wheel touches: x to the left, z forward */
  wheels: [number, number][];
  /** never faster than this, whatever the road allows */
  topSpeed: number;
  colours: number[];
  /** keeps to the main roads */
  majorOnly?: boolean;
  shape: () => TrafficShape;
}

// mostly white and silver, as on Delhi's roads
const CAR_COLOURS = [0xf2f2f0, 0xf2f2f0, 0xf2f2f0, 0xb8bcc0, 0xb8bcc0, 0x55595e, 0x1a1c1e, 0x8e1418, 0x1f3f7a, 0x6d6f4a];

const car = (spec: CarSpec): TrafficKind => ({
  id: spec.id, length: spec.length, width: spec.width, height: spec.height, mass: spec.mass, centreOfMass: spec.centreOfMass,
  wheelRadius: spec.wheelRadius,
  wheels: [[spec.track, spec.axleFront], [-spec.track, spec.axleFront], [spec.track, spec.axleRear], [-spec.track, spec.axleRear]],
  topSpeed: Infinity, colours: CAR_COLOURS, shape: () => carShape(spec),
});

type Part = [THREE.BufferGeometry, number];
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** Parts merged into one geometry, a group per material in the order of `materials` (every one must be used). */
function assemble(parts: Part[], materials: THREE.Material[]) {
  const flat = (g: THREE.BufferGeometry) => {
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    return g.index ? g.toNonIndexed() : g;
  };
  return mergeGeometries(materials.map((_, k) => mergeGeometries(parts.filter(([, m]) => m === k).map(([g]) => flat(g)))!), true)!;
}

/** The Delhi auto-rickshaw: a green CNG tub and cowl under a yellow canvas hood, on three small wheels. */
const AUTO: TrafficKind = {
  id: 'auto', length: 2.65, width: 1.32, height: 1.78, mass: 480, centreOfMass: 0.6, wheelRadius: 0.22,
  wheels: [[0, 1.0], [0.56, -0.78], [-0.56, -0.78]],
  topSpeed: 11, colours: [0x2f8f3a, 0x2a8235, 0x3a9a44, 0x24702e],
  shape: () => {
    const [PAINT, HOOD, GLASS, TRIM, HEAD, TAIL] = [0, 1, 2, 3, 4, 5];
    const materials = [
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.25 }),
      new THREE.MeshStandardMaterial({ color: 0xe7b81f, roughness: 0.75, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: 0x0b1014, roughness: 0.05, metalness: 0.3 }),
      new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: 0xf3f6f8, roughness: 0.1, emissive: 0xfff3da, emissiveIntensity: 0.6 }),
      new THREE.MeshStandardMaterial({ color: 0x7a0a0a, roughness: 0.25, emissive: 0xff1a0a, emissiveIntensity: 0.5 }),
    ];
    const parts: Part[] = [
      [box(1.24, 0.5, 1.7, 0, 0.55, -0.35), PAINT],
      [box(0.75, 1.0, 0.45, 0, 0.78, 0.93), PAINT],
      [box(0.34, 0.08, 0.55, 0, 0.47, 1.0), PAINT],
      [box(1.1, 0.1, 2.3, 0, 0.3, 0), TRIM],
      [box(0.9, 0.12, 0.25, 0, 1.05, 0.68), TRIM],
      [box(0.95, 0.55, 0.03, 0, 1.4, 0.78), GLASS],
      [box(1.34, 0.07, 2.0, 0, 1.74, -0.2), HOOD],
      [box(1.32, 0.95, 0.05, 0, 1.28, -1.18), HOOD],
      [box(0.04, 0.35, 1.3, 0.66, 1.55, -0.45), HOOD],
      [box(0.04, 0.35, 1.3, -0.66, 1.55, -0.45), HOOD],
      ...[[0.62, 0.76], [-0.62, 0.76], [0.64, -1.16], [-0.64, -1.16]].map(([x, z]): Part => [box(0.05, 0.95, 0.05, x, 1.25, z), TRIM]),
      [box(1.1, 0.18, 0.55, 0, 0.88, -0.72), TRIM],
      [box(1.1, 0.5, 0.1, 0, 1.15, -1.0), TRIM],
      [box(0.45, 0.12, 0.35, 0, 0.98, 0.15), TRIM],
      [new THREE.CylinderGeometry(0.09, 0.09, 0.05, 16).rotateX(Math.PI / 2).translate(0, 0.95, 1.16), HEAD],
      [box(0.12, 0.08, 0.03, 0.5, 0.62, -1.21), TAIL],
      [box(0.12, 0.08, 0.03, -0.5, 0.62, -1.21), TAIL],
    ];
    return { shell: assemble(parts, materials), materials, ...plainWheel(0.22, 0.07), paint: PAINT, head: HEAD, tail: TAIL };
  },
};

/** A DTC low-floor bus: twelve metres of green (or red, or orange) CNG bus with a band of glass down each side. */
const BUS: TrafficKind = {
  id: 'bus', length: 12, width: 2.55, height: 3.2, mass: 11000, centreOfMass: 1.1, wheelRadius: 0.5,
  wheels: [[1.0, 3.9], [-1.0, 3.9], [1.0, -2.7], [-1.0, -2.7]],
  topSpeed: 10, colours: [0x1d7a3e, 0x1d7a3e, 0x1d7a3e, 0xc0262b, 0xd86a1c], majorOnly: true,
  shape: () => {
    const [PAINT, GLASS, TRIM, HEAD, TAIL, SIGN] = [0, 1, 2, 3, 4, 5];
    const materials = [
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2 }),
      new THREE.MeshStandardMaterial({ color: 0x0d1418, roughness: 0.05, metalness: 0.4 }),
      new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ color: 0xf3f6f8, roughness: 0.1, emissive: 0xfff3da, emissiveIntensity: 0.6 }),
      new THREE.MeshStandardMaterial({ color: 0x7a0a0a, roughness: 0.25, emissive: 0xff1a0a, emissiveIntensity: 0.5 }),
      new THREE.MeshStandardMaterial({ color: 0x1a0d00, roughness: 0.4, emissive: 0xff8c1a, emissiveIntensity: 1.2 }),
    ];
    const parts: Part[] = [
      [box(2.55, 1.0, 12, 0, 0.85, 0), PAINT],
      [box(2.5, 1.15, 11.7, 0, 1.93, -0.05), GLASS],
      [box(2.55, 0.32, 12, 0, 2.66, 0), PAINT],
      [box(2.2, 0.22, 9, 0, 2.93, -0.8), TRIM],
      [box(2.6, 0.25, 0.15, 0, 0.45, 6.05), TRIM],
      [box(2.6, 0.25, 0.15, 0, 0.45, -6.05), TRIM],
      [box(1.8, 0.25, 0.05, 0, 2.62, 6.01), SIGN],
      [box(0.3, 0.15, 0.04, 0.9, 0.75, 6.01), HEAD],
      [box(0.3, 0.15, 0.04, -0.9, 0.75, 6.01), HEAD],
      [box(0.2, 0.3, 0.04, 1.05, 0.9, -6.01), TAIL],
      [box(0.2, 0.3, 0.04, -1.05, 0.9, -6.01), TAIL],
      // window pillars, and dark drums through the body that read as wheel arches
      ...Array.from({ length: 9 }, (_, i): Part => [box(2.56, 1.15, 0.12, 0, 1.93, -5.6 + i * 1.4), PAINT]),
      ...[3.9, -2.7].map((z): Part => [new THREE.CylinderGeometry(0.58, 0.58, 2.57, 20).rotateZ(Math.PI / 2).translate(0, 0.5, z), TRIM]),
    ];
    return { shell: assemble(parts, materials), materials, ...plainWheel(0.5, 0.14), paint: PAINT, head: HEAD, tail: TAIL };
  },
};

export const TRAFFIC_KINDS = [car(HATCHBACK), car(CRETA), car(THAR), AUTO, BUS];
/** The mix on the road, by index into TRAFFIC_KINDS: three autos, three hatchbacks, two Cretas, a Thar and a bus in ten. */
export const TRAFFIC_MIX = [3, 0, 1, 3, 0, 4, 3, 1, 2, 0];
