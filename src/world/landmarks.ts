import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color, normalWorld, positionWorld, uniform } from 'three/tsl';
import { onNight } from '../render/sky.ts';
import { poolTexture } from './props.ts';
import { CITY } from '../config.ts';
import type { Road } from './tile.ts';

// Positions in map metres from the CP origin (x east, z south), projected from OpenStreetMap.
const INDIA_GATE = { x: 1251.6, z: 2069.2 };
const CANOPY = { x: 1408, z: 2077 };
/** Kartavya Path does not run due east: it bears 3 degrees south of it, and everything on its axis is turned to match. */
const AXIS = -0.0535;

/** Mumbai map metres from its own origin (18.9775 N, 72.825 E): the Gateway of India and the Taj beside it. */
const GATEWAY = { x: 1006.5, z: 6182.4 };
/** its 40 m front runs north-east to south-west along the Apollo Bunder, facing the harbour */
const GATEWAY_TURN = 2.23;
/** the Taj's red dome stands over the middle of its sea-facing wing, on a 21 m roof */
const TAJ = { x: 868, z: 6212, roof: 21.4 };
/** Where the Sea Link's two cable-stayed towers stand, roughly: each is set on the deck nearest it. */
const PYLONS: [number, number, number][] = [
  [-790, -6557, 128], // Bandra channel: the 128 m tower
  [-1212, -4915, 55], // Worli channel
];

/** The name the place label falls back on, and adds after the neighbourhood's. */
export const REGION = CITY === 'mumbai' ? 'South Bombay' : 'Central Delhi';

const MUMBAI: [string, number, number][] = [
  ['Bandra Bandstand', -579, -7592],
  ['Bandra West', 474, -9139],
  ['Bandra–Worli Sea Link', -842, -6178],
  ['Mahim', 1684, -7069],
  ['Worli Sea Face', -737, -3729],
  ['Worli', -842, -2950],
  ['Prabhadevi', 421, -4286],
  ['Dadar', 1895, -4620],
  ['Lower Parel', 526, -2059],
  ['Haji Ali', -1684, -579],
  ['Mahalaxmi', -316, -579],
  ['Byculla', 842, -167],
  ['Sewri', 3263, -2505],
  ['Breach Candy', -2105, 835],
  ['Tardeo', -1053, 835],
  ['Malabar Hill', -2842, 2505],
  ['Girgaon Chowpatty', -1105, 2560],
  ['Grant Road', -947, 1614],
  ['Marine Drive', -211, 3729],
  ['Churchgate', 211, 4698],
  ['Nariman Point', -147, 5777],
  ['Crawford Market', 979, 3362],
  ['Chhatrapati Shivaji Terminus', 1084, 4174],
  ['Fort', 1053, 4954],
  ['Kala Ghoda', 705, 5488],
  ['Gateway of India', GATEWAY.x, GATEWAY.z],
  ['Taj Mahal Palace', TAJ.x, TAJ.z],
  ['Colaba Causeway', 211, 6957],
  ['Colaba', -1084, 7881],
  ['Navy Nagar', -1579, 8739],
];

/** Neighbourhoods for the place label, in map metres; the nearest one within reach names where the car is. */
export const NEIGHBOURHOODS: [string, number, number][] = CITY === 'mumbai' ? MUMBAI : [
  ['Connaught Place', 290, -147],
  ['Janpath', 225, 891],
  ['Barakhamba Road', 801, 200],
  ['Mandi House', 1690, 634],
  ['India Gate', 1251, 2069],
  ['National War Memorial', 1600, 2086],
  ['Parliament House', -740, 1596],
  ['Jantar Mantar', -11, 496],
  ['Bangla Sahib', -740, 572],
  ['Agrasen ki Baoli', 811, 598],
  ['Supreme Court', 2216, 1016],
  ['Purana Qila', 2480, 2400],
  ['Safdarjung\'s Tomb', -596, 4705],
  ['Kartavya Path', -166, 2004],
  ['Rashtrapati Bhavan', -1690, 1915],
  ['Gol Market', -1143, -278],
  ['Paharganj', -302, -1463],
  ['Khan Market', 1006, 3462],
  ['Lodhi Garden', 293, 4252],
  ['Lutyens\' Delhi', -700, 2900],
];

export function neighbourhood(x: number, z: number) {
  let best = REGION, d = 1100;
  for (const [name, nx, nz] of NEIGHBOURHOODS) {
    const dist = Math.hypot(x - nx, z - nz);
    if (dist < d) [best, d] = [name, dist];
  }
  return best;
}

/** Places where a hand-built landmark replaces whatever footprint OpenStreetMap has: [x, z, radius]. */
export const CLEARINGS: [number, number, number][] = CITY === 'mumbai' ? [[GATEWAY.x, GATEWAY.z, 22]] : [
  [INDIA_GATE.x, INDIA_GATE.z, 30],
  [CANOPY.x, CANOPY.z, 12],
  [-1456, 1920, 8], // Jaipur Column
  [-10, 494, 16], // Samrat Yantra
  [357, 4282, 26], // Bara Gumbad
  [341, 4201, 12], // Shish Gumbad
  [155, 4507, 14], // Muhammad Shah's tomb
  [474, 3918, 14], // Sikandar Lodi's tomb
  [-596, 4705, 22], // Safdarjung's tomb
  [2632, 4267, 9], // Sabz Burj
];

type Stone = 'buff' | 'red' | 'grey' | 'white' | 'gold' | 'blue' | 'dark' | 'flame';
type Part = [THREE.BufferGeometry, Stone];

const night = uniform(0);
onNight((n) => (night.value = n));

/**
 * Stone that is floodlit after dark, as Delhi's monuments are: warm lamps on the ground looking up, so the foot
 * of a wall is brightest, the light thins with height, and the undersides of arches and cornices catch the most.
 */
function floodlit(colour: number, glow: number, extra: THREE.MeshStandardNodeMaterialParameters = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ color: colour, roughness: 0.85, ...extra });
  const thinning = positionWorld.y.div(45).clamp(0, 1).oneMinus().mul(0.72).add(0.28);
  const underside = normalWorld.y.negate().max(0).mul(1.5).add(1);
  // each lamp throws its own fan up the wall: bright and dark scallops along the foot, gone by 18 m up
  const fans = positionWorld.x.add(positionWorld.z).mul(1.3).sin().mul(0.22).mul(positionWorld.y.div(18).clamp(0, 1).oneMinus()).add(1);
  m.emissiveNode = color(new THREE.Color(colour).lerp(new THREE.Color(0xffd28a), 0.45)).mul(night.mul(glow).mul(thinning).mul(underside).mul(fans));
  return m;
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
/** An upright cylinder, or with few `sides` a prism standing square to the axes; `r` is to its corners. */
const drum = (r: number, h: number, x = 0, y = 0, z = 0, sides = 24, top = r) => new THREE.CylinderGeometry(top, r, h, sides).rotateY(Math.PI / sides).translate(x, y + h / 2, z);
/** `bulb` swells a dome past a hemisphere, as on Mughal tombs and gurdwaras. */
const dome = (r: number, x = 0, y = 0, z = 0, bulb = 0) =>
  new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI * (0.5 + bulb)).translate(x, y + r * Math.sin(Math.PI * bulb), z);

/** A dome on its drum with a finial, sitting at height `y`. */
function cupola(r: number, y: number, body: Stone, cap: Stone, bulb = 0, lift = r * 0.5, x = 0, z = 0): Part[] {
  const top = y + lift + r * (1 + Math.sin(Math.PI * bulb));
  return [
    [drum(r * 1.05, lift, x, y, z), body],
    [dome(r, x, y + lift, z, bulb), cap],
    [new THREE.ConeGeometry(r * 0.09, r * 0.5, 8).translate(x, top + r * 0.2, z), cap],
  ];
}

/** A Sultanate or Mughal tomb: a square or eight-sided hall `width` across, a dome, and a kiosk on every corner. */
function tomb(sides: 4 | 8, width: number, wall: number, domeR: number, body: Stone, cap: Stone, bulb = 0, plinth = 0): Part[] {
  const r = width / 2 / Math.cos(Math.PI / sides);
  const parts: Part[] = [
    [drum(r, wall, 0, plinth, 0, sides), body],
    [drum(r * 1.04, 0.8, 0, plinth + wall, 0, sides), body],
    ...cupola(domeR, plinth + wall, body, cap, bulb),
  ];
  if (plinth) parts.push([box(width * 1.9, plinth, width * 1.9), body]);
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) / sides) * Math.PI * 2;
    parts.push(...cupola(domeR * 0.22, plinth + wall + 0.8, body, cap, bulb, domeR * 0.35, Math.sin(a) * r * 0.84, Math.cos(a) * r * 0.84));
  }
  return parts;
}

/** The 42 m war memorial arch at the east end of Kartavya Path. Its opening looks along the avenue. */
function indiaGate(): { parts: Part[]; piers: [number, number, number, number, number][] } {
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
  // the shape is drawn across the avenue and pushed along it
  const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 }).rotateY(Math.PI / 2).translate(-depth / 2, 0, 0);
  return {
    parts: [
      [body, 'buff'],
      [box(depth + 2, 1.2, span + 2, 0, height), 'buff'], // cornice
      [box(depth - 1, 6, span - 4, 0, height + 1.2), 'buff'], // attic, where INDIA is carved
      [box(depth - 2.5, 2, span - 8, 0, height + 7.2), 'buff'],
      [drum(4.4, 2.8, 0, height + 9.2, 0, 24, 3.2), 'buff'], // the shallow bowl on top
    ],
    // [x, z, half-width, half-height, half-depth] of each pier, for the physics
    piers: [-1, 1].map((side) => [0, (side * (half + span / 2)) / 2, depth / 2, height / 2, (span / 2 - half) / 2]),
  };
}

/** The sandstone canopy east of India Gate, and the granite statue of Subhas Chandra Bose that has stood under it since 2022. */
function canopy(): Part[] {
  return [
    ...[[-4, -4], [4, -4], [-4, 4], [4, 4]].map(([x, z]): Part => [drum(0.55, 12, x, 0, z, 12, 0.45), 'buff']),
    [box(10.5, 1, 10.5, 0, 12), 'buff'],
    [new THREE.ConeGeometry(6.2, 5, 4).rotateY(Math.PI / 4).translate(0, 15.5, 0), 'buff'],
    [box(12, 0.6, 12), 'buff'],
    [box(2.4, 2.2, 2.4, 0, 0.6), 'dark'],
    [drum(1.05, 5, 0, 2.8, 0, 12, 0.75), 'dark'],
    [new THREE.SphereGeometry(0.62, 12, 8).translate(0, 8.3, 0), 'dark'],
  ];
}

/** The National War Memorial: the obelisk and its eternal flame, ringed by the low walls that carry the names. */
function warMemorial(): Part[] {
  const parts: Part[] = [
    [drum(6, 0.5), 'buff'],
    [drum(4, 0.6, 0, 0.5), 'buff'],
    [drum(1.5, 13.5, 0, 1.1, 0, 4, 0.75), 'buff'],
    [new THREE.ConeGeometry(0.75, 1.4, 4).translate(0, 15.3, 0), 'gold'],
    [drum(0.5, 0.9, -2.6, 1.1, 0, 12), 'dark'],
    [new THREE.ConeGeometry(0.32, 0.9, 8).translate(-2.6, 2.45, 0), 'flame'],
  ];
  for (const [r, n] of [[24, 12], [36, 16]]) for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * Math.PI * 2;
    parts.push([new THREE.BoxGeometry(0.7, 1.5, r * ((Math.PI * 2) / n) * 0.72).rotateY(-a).translate(Math.cos(a) * r, 0.75, Math.sin(a) * r), 'red']);
  }
  return parts;
}

/** Jantar Mantar's Samrat Yantra: a sundial whose 20 m gnomon points at the pole, climbing to the north. */
function samratYantra(): Part[] {
  const gnomon = new THREE.Shape([new THREE.Vector2(-17, 0), new THREE.Vector2(17, 0), new THREE.Vector2(17, 20)]);
  return [
    [new THREE.ExtrudeGeometry(gnomon, { depth: 3, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-1.5, 0, 0), 'red'],
    // the quadrants its shadow falls on, either side
    ...[-1, 1].flatMap((side): Part[] => [[box(7, 3.5, 3, side * 5, 0, 2), 'red'], [box(3, 7, 3, side * 10, 0, 2), 'red']]),
  ];
}

/** The Gateway of India: a yellow basalt arch on the Apollo Bunder, its four corner towers capped with little domes. */
function gatewayOfIndia(): { parts: Part[]; piers: [number, number, number, number, number][] } {
  const span = 40, height = 20, depth = 14, half = 5, spring = 11;
  const shape = new THREE.Shape();
  shape.moveTo(-span / 2, 0);
  shape.lineTo(span / 2, 0);
  shape.lineTo(span / 2, height);
  shape.lineTo(-span / 2, height);
  shape.closePath();
  const arch = new THREE.Path();
  arch.moveTo(-half, 0);
  arch.lineTo(-half, spring);
  // a pointed arch: two arcs meeting at the top
  arch.absarc(half * 0.35, spring, half * 1.35, Math.PI, (Math.PI * 105) / 180, true);
  arch.absarc(-half * 0.35, spring, half * 1.35, (Math.PI * 75) / 180, 0, true);
  arch.lineTo(half, 0);
  arch.closePath();
  shape.holes.push(arch);
  const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 }).rotateY(Math.PI / 2).translate(-depth / 2, 0, 0);
  const parts: Part[] = [
    [body, 'buff'],
    [box(depth + 1.5, 1, span + 1.5, 0, height), 'buff'],
    [box(depth - 3, 3.5, span - 6, 0, height + 1), 'buff'], // the parapet hiding the central dome
    ...cupola(5.5, height + 1, 'buff', 'buff', 0, 2.5),
  ];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const px = (x * depth) / 2, pz = (z * span) / 2;
    parts.push([drum(2.4, height + 6, px, 0, pz, 8), 'buff'], ...cupola(2, height + 6, 'buff', 'buff', 0.1, 1.5, px, pz));
  }
  return { parts, piers: [-1, 1].map((side) => [0, (side * (half + span / 2)) / 2, depth / 2, height / 2, (span / 2 - half) / 2]) };
}

/** A Sea Link tower: an inverted Y of concrete straddling the deck, the stays fanning from its head both ways. */
/** `deck` is the height of the road through it: the stays come down to it. */
function seaLinkTower(h: number, deck: number): Part[] {
  const legs = 22, join = h * 0.62;
  const leg = (side: number) => {
    const len = Math.hypot(legs, join);
    return new THREE.BoxGeometry(3, len, 4).rotateZ(Math.atan2(legs, join) * side).translate((side * legs) / 2, join / 2, 0);
  };
  const parts: Part[] = [
    [leg(-1), 'grey'], [leg(1), 'grey'],
    [box(3.4, h - join, 4.5, 0, join), 'grey'],
  ];
  // stays: thin cables from the top third of the tower to the deck, 14 each way, either side of the head
  for (const dir of [-1, 1]) for (let k = 1; k <= 14; k++) {
    const top = join + ((h - join) * (k - 0.5)) / 14.5, reach = k * 11;
    for (const x of [-1.2, 1.2]) {
      const foot = deck + 1;
      const len = Math.hypot(reach, top - foot);
      const cable = new THREE.CylinderGeometry(0.12, 0.12, len, 4)
        .rotateX(-Math.atan2(reach, top - foot) * dir)
        .translate(x, (top + foot) / 2, (dir * reach) / 2);
      parts.push([cable, 'white']);
    }
  }
  return parts;
}

/** The point on the Sea Link between its two carriageways nearest (x, z), and the way the deck runs there. */
function onDeck(roads: Road[], x: number, z: number) {
  const hits: { x: number; z: number; heading: number; y: number }[] = [];
  for (const r of roads) {
    let best: { x: number; z: number; heading: number; d: number; y: number } | null = null;
    const p = r.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1], l = dx * dx + dz * dz;
      if (!l) continue;
      const t = Math.max(0, Math.min(1, ((x - p[i]) * dx + (z - p[i + 1]) * dz) / l));
      const px = p[i] + dx * t, pz = p[i + 1] + dz * t, d = Math.hypot(x - px, z - pz);
      const y = r.elev ? r.elev[i / 2] + (r.elev[i / 2 + 1] - r.elev[i / 2]) * t : 0;
      if (!best || d < best.d) best = { x: px, z: pz, heading: Math.atan2(dx, dz), d, y };
    }
    if (best && best.d < 120) hits.push(best);
  }
  if (!hits.length) return null;
  // the two carriageways run opposite ways; the tower stands between them, square to the deck
  const sx = hits.reduce((a, h) => a + h.x, 0) / hits.length, sz = hits.reduce((a, h) => a + h.z, 0) / hits.length;
  return { x: sx, z: sz, heading: hits[0].heading, y: Math.max(...hits.map((h) => h.y)) };
}

/** Landmarks are few and always present: they stay loaded wherever the car is, so they are seen from far off. */
export function buildLandmarks(scene: THREE.Scene, world: RAPIER.World, roads: Road[]) {
  const stones: Record<Stone, THREE.Material> = {
    buff: floodlit(0xcaa883, 0.55), // Dholpur and Bharatpur sandstone
    red: floodlit(0xa5553c, 0.55),
    grey: floodlit(0x9c8b74, 0.5), // the Lodis' quartzite
    white: floodlit(0xe6e0d2, 0.5),
    blue: floodlit(0x2f86a6, 0.6, { roughness: 0.4 }),
    gold: floodlit(0xd9a531, 0.9, { roughness: 0.3, metalness: 0.9 }),
    dark: floodlit(0x2c2d2e, 0.35, { roughness: 0.5 }),
    flame: new THREE.MeshStandardNodeMaterial({ color: 0xff7a1a, emissive: 0xff6a10, emissiveIntensity: 10 }),
  };
  const put = (name: string, x: number, z: number, parts: Part[], turn = 0, glow?: number) => {
    for (const stone of new Set(parts.map(([, s]) => s))) {
      const geo = mergeGeometries(parts.filter(([, s]) => s === stone).map(([g]) => (g.index ? g.toNonIndexed() : g)))!;
      // India Gate is lit far harder than anything else in the city
      const mesh = new THREE.Mesh(geo, glow && stone === 'buff' ? floodlit(0xcaa883, glow) : stones[stone]);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.set(x, 0, z);
      mesh.rotation.y = turn;
      mesh.name = name;
      scene.add(mesh);
    }
  };
  /** Something solid standing at (x, z): a box of the half-sizes given, turned with its monument. */
  const solid = (x: number, z: number, hx: number, hy: number, hz: number, turn = 0) =>
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, hy, z).setRotation({ x: 0, y: Math.sin(turn / 2), z: 0, w: Math.cos(turn / 2) }));
  /** Offset (dx, dz) in a monument's own frame, as a place on the map. */
  const at = (o: { x: number; z: number }, dx: number, dz: number, turn: number): [number, number] =>
    [o.x + dx * Math.cos(turn) + dz * Math.sin(turn), o.z - dx * Math.sin(turn) + dz * Math.cos(turn)];

  if (CITY === 'mumbai') {
    const gw = gatewayOfIndia();
    put('gateway-of-india', GATEWAY.x, GATEWAY.z, gw.parts, GATEWAY_TURN, 0.8);
    for (const [dx, dz, hx, hy, hz] of gw.piers) solid(...at(GATEWAY, dx, dz, GATEWAY_TURN), hx, hy, hz, GATEWAY_TURN);
    // the Taj's red central dome, on the walls OpenStreetMap gives
    put('taj-dome', TAJ.x, TAJ.z, [[drum(9, 6, 0, TAJ.roof), 'buff'], ...cupola(8, TAJ.roof + 6, 'buff', 'red', 0.08, 5)]);
    const seaLink = roads.filter((r) => /sea link/i.test(r.name ?? ''));
    for (const [gx, gz, h] of PYLONS) {
      const site = onDeck(seaLink, gx, gz);
      if (!site) continue;
      put('sea-link-tower', site.x, site.z, seaLinkTower(h, site.y), site.heading, 0.6);
      for (const side of [-1, 1]) solid(...at(site, side * 22, 0, site.heading), 1.6, h / 2, 2.5, site.heading);
    }
    return;
  }

  const gate = indiaGate();
  put('india-gate', INDIA_GATE.x, INDIA_GATE.z, gate.parts, AXIS, 0.85);
  for (const [dx, dz, hx, hy, hz] of gate.piers) solid(...at(INDIA_GATE, dx, dz, AXIS), hx, hy, hz, AXIS);
  // the light its lamps spill on the paving round it
  const spill = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: poolTexture(), color: 0xffb46b, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -32 }),
  );
  spill.position.set(INDIA_GATE.x, 0.08, INDIA_GATE.z);
  spill.renderOrder = 2;
  onNight((n) => {
    (spill.material as THREE.MeshBasicMaterial).opacity = 0.55 * n;
    spill.visible = n > 0.01;
  });
  scene.add(spill);

  put('canopy', CANOPY.x, CANOPY.z, canopy(), AXIS, 0.7);
  for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4], [0, 0]]) solid(...at(CANOPY, dx, dz, AXIS), dx ? 0.5 : 1.2, 6, dx ? 0.5 : 1.2, AXIS);

  const memorial = { x: 1600, z: 2086 };
  put('war-memorial', memorial.x, memorial.z, warMemorial(), AXIS);
  solid(memorial.x, memorial.z, 3, 8, 3);
  for (const [r, n] of [[24, 12], [36, 16]]) for (let k = 0; k < n; k++) {
    const a = ((k + 0.5) / n) * Math.PI * 2;
    solid(...at(memorial, Math.cos(a) * r, Math.sin(a) * r, AXIS), 0.35, 0.75, r * (Math.PI / n) * 0.72, AXIS - a);
  }

  // Domes on buildings OpenStreetMap already gives the walls of.
  put('rashtrapati-bhavan-dome', -1690, 1915, [[drum(15, 6, 0, 19.4), 'buff'], ...cupola(12.5, 25.4, 'buff', 'dark', 0, 9)]);
  put('north-block-dome', -1058, 1798, [[drum(10.5, 8, 0, 29), 'buff'], ...cupola(8.5, 37, 'buff', 'red', 0, 8)]);
  put('south-block-dome', -1071, 2078, [[drum(10.5, 8, 0, 29), 'buff'], ...cupola(8.5, 37, 'buff', 'red', 0, 8)]);
  put('parliament-dome', -831, 1593, cupola(14, 21, 'buff', 'buff', 0, 3));
  put('supreme-court-dome', 2216, 1016, cupola(7.5, 26, 'white', 'white', 0, 6));
  put('hyderabad-house-dome', 1090, 1727, cupola(7, 26, 'buff', 'buff', 0, 2.5));
  put('bangla-sahib-dome', -740, 572, cupola(6.5, 19.4, 'white', 'gold', 0.14, 3));
  put('rakab-ganj-dome', -1173, 1387, cupola(7, 7.8, 'white', 'white', 0.12, 4));

  // The Jaipur Column in the forecourt of Rashtrapati Bhavan: 44 m of sandstone under a bronze lotus and a star.
  put('jaipur-column', -1456, 1920, [
    [box(6, 5, 6), 'red'], [box(4.4, 3, 4.4, 0, 5), 'buff'], [drum(1.5, 30, 0, 8, 0, 16, 1.1), 'buff'], [box(3, 1, 3, 0, 38), 'buff'],
    [drum(0.4, 2.6, 0, 39, 0, 12, 1.5), 'dark'], [new THREE.OctahedronGeometry(0.9).translate(0, 42.8, 0), 'gold'],
  ]);
  solid(-1456, 1920, 3, 4, 3);

  put('samrat-yantra', -10, 494, samratYantra());
  solid(-10, 494, 1.5, 10, 17);
  solid(-10, 496, 11.5, 1.75, 1.5);

  // Lodhi Garden's tombs, Safdarjung's on its platform, and the blue-domed Sabz Burj on its roundabout.
  const tombs: [string, number, number, Part[], number, number][] = [
    ['bara-gumbad', 357, 4282, [...tomb(4, 19, 14, 8.5, 'grey', 'grey'), [box(8, 7, 26, 15, 0, 0), 'grey']], 9.5, 7],
    ['shish-gumbad', 341, 4201, tomb(4, 17, 12, 7.5, 'grey', 'grey'), 8.5, 6],
    ['muhammad-shah-tomb', 155, 4507, tomb(8, 20, 8, 7, 'grey', 'grey'), 10, 4],
    ['sikandar-lodi-tomb', 474, 3918, tomb(8, 18, 7, 6.5, 'grey', 'grey'), 9, 3.5],
    ['safdarjung-tomb', -596, 4705, tomb(4, 20, 16, 7, 'red', 'white', 0.12, 4), 19, 2],
    ['sabz-burj', 2632, 4267, tomb(8, 11, 9, 4, 'white', 'blue', 0.1), 5.5, 4.5],
  ];
  for (const [name, x, z, parts, half, hy] of tombs) {
    put(name, x, z, parts);
    solid(x, z, half, hy, half);
  }
}
