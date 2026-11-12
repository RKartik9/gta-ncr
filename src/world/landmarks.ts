import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { onNight } from '../render/sky.ts';

// Positions in map metres from the CP origin (x east, z south), projected from OpenStreetMap.
const INDIA_GATE = { x: 1251.6, z: 2069.2 };
const CANOPY = { x: 1407, z: 2070 };

/** Neighbourhoods for the place label, in map metres; the nearest one within reach names where the car is. */
export const NEIGHBOURHOODS: [string, number, number][] = [
  ['Connaught Place', 290, -147],
  ['Janpath', 225, 891],
  ['Barakhamba Road', 801, 200],
  ['Mandi House', 1690, 634],
  ['India Gate', 1251, 2069],
  ['Kartavya Path', -166, 2004],
  ['Rashtrapati Bhavan', -1690, 1915],
  ['Gol Market', -1143, -278],
  ['Paharganj', -302, -1463],
  ['Khan Market', 1006, 3462],
  ['Lodhi Garden', 293, 4252],
  ['Lutyens\' Delhi', -700, 2900],
];

export function neighbourhood(x: number, z: number) {
  let best = 'Central Delhi', d = 1100;
  for (const [name, nx, nz] of NEIGHBOURHOODS) {
    const dist = Math.hypot(x - nx, z - nz);
    if (dist < d) [best, d] = [name, dist];
  }
  return best;
}

/** Places where a hand-built landmark replaces whatever footprint OpenStreetMap has. */
export const CLEARINGS: [number, number, number][] = [
  [INDIA_GATE.x, INDIA_GATE.z, 30],
  [CANOPY.x, CANOPY.z, 12],
];

/** The 42 m war memorial arch at the east end of Kartavya Path. Its opening looks along the avenue, east to west. */
function indiaGate() {
  const span = 24, height = 30, depth = 10, half = 4.6, spring = 18;
  const shape = new THREE.Shape();
  shape.moveTo(-span / 2, 0);
  shape.lineTo(span / 2, 0);
  shape.lineTo(span / 2, height);
  shape.lineTo(-span / 2, height);
  shape.closePath();
  const arch = new THREE.Path();
  arch.moveTo(-half, 0);
  arch.lineTo(-half, spring);
  arch.absarc(0, spring, half, Math.PI, 0, true);
  arch.lineTo(half, 0);
  arch.closePath();
  shape.holes.push(arch);
  // the shape is drawn across the avenue (north-south) and pushed along it (east-west)
  const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 }).rotateY(Math.PI / 2).translate(-depth / 2, 0, 0);
  for (const name of Object.keys(body.attributes)) if (name !== 'position' && name !== 'normal') body.deleteAttribute(name);
  const box = (w: number, h: number, d: number, y: number) => {
    const g = new THREE.BoxGeometry(d, h, w).translate(0, y + h / 2, 0);
    g.deleteAttribute('uv');
    return g;
  };
  const top = [
    box(span + 2, 1.2, depth + 2, height), // cornice
    box(span - 4, 6, depth - 1, height + 1.2), // attic, where INDIA is carved
    box(span - 8, 2, depth - 2.5, height + 7.2),
  ];
  const dome = new THREE.CylinderGeometry(3.2, 4.4, 2.8, 24).translate(0, height + 10.6, 0);
  dome.deleteAttribute('uv');
  const geo = mergeGeometries([body.index ? body.toNonIndexed() : body, ...top.map((g) => g.toNonIndexed()), dome.toNonIndexed()])!;
  // buff Bharatpur sandstone, floodlit warm after dark
  const mat = new THREE.MeshStandardMaterial({ color: 0xcaa883, roughness: 0.85, emissive: 0xffc58a, emissiveIntensity: 0 });
  onNight((n) => (mat.emissiveIntensity = 0.22 * n));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.position.set(INDIA_GATE.x, 0, INDIA_GATE.z);
  mesh.name = 'india-gate';
  return { mesh, piers: [-1, 1].map((side) => ({ x: INDIA_GATE.x, z: INDIA_GATE.z + side * (half + span / 2) / 2, hx: depth / 2, hz: (span / 2 - half) / 2, hy: height / 2 })) };
}

/** The empty sandstone canopy east of India Gate. */
function canopy() {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) parts.push(new THREE.CylinderGeometry(0.45, 0.55, 12, 12).translate(x, 6, z));
  parts.push(new THREE.BoxGeometry(10.5, 1, 10.5).translate(0, 12.5, 0));
  parts.push(new THREE.ConeGeometry(6.2, 5, 4).rotateY(Math.PI / 4).translate(0, 15.5, 0));
  parts.push(new THREE.BoxGeometry(12, 0.6, 12).translate(0, 0.3, 0));
  for (const p of parts) p.deleteAttribute('uv');
  const mesh = new THREE.Mesh(mergeGeometries(parts.map((p) => p.toNonIndexed()))!, new THREE.MeshStandardMaterial({ color: 0xc49e78, roughness: 0.85 }));
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.position.set(CANOPY.x, 0, CANOPY.z);
  mesh.name = 'canopy';
  return mesh;
}

/** Landmarks are few and always present: they stay loaded wherever the car is, so they are seen from far off. */
export function buildLandmarks(scene: THREE.Scene, world: RAPIER.World) {
  const gate = indiaGate();
  scene.add(gate.mesh, canopy());
  for (const p of gate.piers) world.createCollider(RAPIER.ColliderDesc.cuboid(p.hx, p.hy, p.hz).setTranslation(p.x, p.hy, p.z));
  for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) world.createCollider(RAPIER.ColliderDesc.cylinder(6, 0.55).setTranslation(CANOPY.x + x, 6, CANOPY.z + z));
}
