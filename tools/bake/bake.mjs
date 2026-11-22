// Bakes an OpenStreetMap extract (Overpass JSON) into a compact tile the game loads.
// Usage: node tools/bake/bake.mjs [--fetch] [--area central|cp]
// `central` is fetched in ~2 km chunks and written as 1 km cells under public/tiles/central/, plus an index.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// south, west, north, east
// Every area shares Connaught Place's origin, so a position means the same place in all of them.
const CP_ORIGIN = [(28.6245 + 28.6385) / 2, (77.2087 + 77.2247) / 2];
const AREAS = {
  cp: { name: 'Connaught Place', bbox: [28.6245, 77.2087, 28.6385, 77.2247], spawn: [28.6328, 77.2197] },
  // CP, Lutyens' Delhi and India Gate; Old Delhi and the Red Fort to the north, Karol Bagh to the west, the Yamuna and
  // Akshardham to the east, Nizamuddin, Lajpat Nagar and Hauz Khas to the south. Its corners sit on the old chunk grid.
  central: { name: 'Delhi', bbox: [28.54, 77.1311, 28.675, 77.2939], spawn: [28.6328, 77.2197], cell: 1000, chunk: [0.015, 0.0163] },
};

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const ROAD_WIDTH = {
  motorway: 14, trunk: 14, primary: 12, secondary: 10.5, tertiary: 8.5,
  motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 6.5, tertiary_link: 6,
  residential: 6.5, unclassified: 6.5, living_street: 5, service: 4,
};
const PATH_WIDTH = { footway: 2, pedestrian: 5, path: 1.5, steps: 2, cycleway: 2 };
const LEVEL_HEIGHT = 3.4;

const args = process.argv.slice(2);
const areaId = args.includes('--area') ? args[args.indexOf('--area') + 1] : 'central';
const area = AREAS[areaId];
if (!area) throw new Error(`unknown area ${areaId}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRaw([s, w, n, e], rawPath, depth = 0) {
  const q = `[out:json][timeout:180][bbox:${s},${w},${n},${e}];(way["highway"];way["building"];relation["building"];way["leisure"~"park|garden"];way["landuse"];way["natural"~"water|wood|tree_row"];node["natural"="tree"];node["highway"~"traffic_signals|crossing|street_lamp|bus_stop"];node["barrier"="bollard"];way["barrier"];way["railway"];);out body;>;out skel qt;`;
  for (let attempt = 0; attempt < (depth ? 3 : 2); attempt++) {
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': 'delhi-drive-bake/0.2' }, signal: AbortSignal.timeout(200_000) });
        const text = await res.text();
        if (res.ok && text.startsWith('{')) {
          mkdirSync(dirname(rawPath), { recursive: true });
          writeFileSync(rawPath, text);
          return;
        }
        console.warn(`${url}: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`${url}: ${err.message}`);
      }
    }
    await sleep(15000 * (attempt + 1)); // Overpass asks busy clients to back off
  }
  // ponytail: a dense chunk can time out everywhere; split it into quarters (recursively, up to depth 2) and merge
  if (depth >= 2) throw new Error('every Overpass endpoint failed');
  console.warn(`splitting ${s},${w},${n},${e} into quarters`);
  const [ms, mw] = [(s + n) / 2, (w + e) / 2].map((v) => +v.toFixed(5));
  const elements = [];
  for (const [i, q] of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]].entries()) {
    const part = `${rawPath}.part${i}`;
    if (!existsSync(part)) await fetchRaw(q, part, depth + 1);
    elements.push(...JSON.parse(readFileSync(part, 'utf8')).elements);
  }
  writeFileSync(rawPath, JSON.stringify({ elements })); // duplicates are dropped by the merge below
  for (let i = 0; i < 4; i++) unlinkSync(`${rawPath}.part${i}`);
}

// One area is fetched as one or more chunks; elements shared by neighbouring chunks are kept once.
const chunks = [];
if (area.chunk) {
  const [s0, w0, n0, e0] = area.bbox;
  for (let s = s0; s < n0 - 1e-9; s += area.chunk[0]) {
    for (let w = w0; w < e0 - 1e-9; w += area.chunk[1]) {
      chunks.push({ bbox: [s, w, Math.min(n0, s + area.chunk[0]), Math.min(e0, w + area.chunk[1])].map((v) => +v.toFixed(5)), path: join(root, 'tools/bake/raw', areaId, `${s.toFixed(4)}_${w.toFixed(4)}.json`) });
    }
  }
} else chunks.push({ bbox: area.bbox, path: join(root, 'tools/bake/raw', `${areaId}.json`) });

// a second run with --reverse fetches from the other end, so two can share a slow download
if (args.includes('--reverse')) chunks.reverse();

const seen = new Map();
for (const [k, c] of chunks.entries()) {
  if (args.includes('--fetch') || !existsSync(c.path)) {
    console.log(`fetching chunk ${k + 1}/${chunks.length} ${c.bbox.join(',')}`);
    // ponytail: never give up while Overpass is down; wait and go again (saved quarters are reused)
    for (;;) {
      try { await fetchRaw(c.bbox, c.path); break; } catch (err) { console.warn(`${err.message}; retrying in 2 min`); await sleep(120_000); }
    }
    await sleep(2000);
  }
  for (const el of JSON.parse(readFileSync(c.path, 'utf8')).elements) {
    const key = el.type + el.id;
    // a chunk may hold only the skeleton of an element another chunk has in full
    if (!seen.has(key) || (el.tags && !seen.get(key).tags)) seen.set(key, el);
  }
}
const osm = { elements: [...seen.values()] };

const [south, west, north, east] = area.bbox;
const [lat0, lon0] = CP_ORIGIN;
const M_PER_DEG = 111_319.49;
const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
// x is east, z is south, so north is -z (three.js, y up).
const project = (lat, lon) => [(lon - lon0) * kx, -(lat - lat0) * M_PER_DEG];
const r2 = (v) => Math.round(v * 100) / 100;

const nodes = new Map();
const ways = new Map();
for (const el of osm.elements) {
  if (el.type === 'node') nodes.set(el.id, el);
  else if (el.type === 'way') ways.set(el.id, el);
}

const line = (way) => {
  const out = [];
  for (const id of way.nodes) {
    const n = nodes.get(id);
    if (!n) continue;
    const [x, z] = project(n.lat, n.lon);
    out.push(r2(x), r2(z));
  }
  return out;
};
const ring = (way) => {
  if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) return null;
  const pts = line(way);
  return pts.slice(0, -2); // drop the repeated closing point
};
const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
};
const hash = (n) => {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const num = (v) => {
  const f = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(f) ? f : null;
};

const roads = [];
const paths = [];
const buildings = [];
const areas = [];
const trees = [];
const signals = [];
const bollards = [];
const busStops = [];
const stats = { buildings: 0, withHeight: 0, withLevels: 0, guessedHeight: 0, roads: 0, roadKm: 0, namedRoads: 0 };

// Mapped as one 68,000 m² building lying across North Block and the Rashtrapati Bhavan forecourt: it is not there.
const NOT_THERE = new Set([1218426672]);

function buildingFrom(id, tags, outer, holes) {
  if (Math.abs(ringArea(outer)) < 6 || NOT_THERE.has(id)) return;
  // Metro stations are mapped as buildings, below ground (layer -2): Rajiv Chowk's is the whole of Connaught
  // Place's Central Park. Nothing of them stands on the surface.
  if (num(tags.layer) < 0 || tags.location === 'underground') return;
  // Tombs, gates, fort walls, the Jantar Mantar instruments: stone, not a block of flats with lit windows.
  const historic = !!tags.historic;
  const kind = tags.building === 'yes' ? (tags.amenity || tags.shop || tags.office ? 'commercial' : 'yes') : tags.building;
  let height = num(tags.height);
  const levels = num(tags['building:levels']);
  stats.buildings++;
  if (height) stats.withHeight++;
  else if (levels) {
    stats.withLevels++;
    height = levels * LEVEL_HEIGHT + 1;
  } else if (historic) {
    // a stepwell is a pit with a wall round it; the rest are about as tall as they are wide, up to a fort wall's 18 m
    height = tags.man_made === 'water_well' ? 5 : Math.min(18, Math.max(4, Math.sqrt(Math.abs(ringArea(outer))) * 0.6));
  } else {
    stats.guessedHeight++;
    const size = Math.abs(ringArea(outer));
    const big = size > 900;
    const base = kind === 'roof' ? 4 : kind === 'house' || kind === 'residential' ? 7 : big ? 16 : 10;
    // a footprint the size of a room is a kiosk, a guard's hut or a public toilet: one floor, not a tower
    height = size < 60 ? 3.6 : base + Math.floor(hash(id) * (kind === 'roof' ? 1 : 4)) * LEVEL_HEIGHT;
  }
  buildings.push({
    id, kind, name: tags.name, height: r2(height), minHeight: num(tags.min_height) ?? 0,
    guessed: !num(tags.height) && !levels, outer, holes, ...(historic && { historic }),
  });
}

for (const way of ways.values()) {
  const t = way.tags;
  if (!t) continue;
  if (t.building && !t['building:part']) {
    const outer = ring(way);
    if (outer) buildingFrom(way.id, t, outer, []);
  } else if (t.highway) {
    if (t.area === 'yes' || t.highway === 'corridor' || t.tunnel === 'yes' || t.indoor) continue;
    const pts = line(way);
    if (pts.length < 4) continue;
    let km = 0;
    for (let i = 2; i < pts.length; i += 2) km += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]) / 1000;
    if (ROAD_WIDTH[t.highway]) {
      const lanes = num(t.lanes);
      const oneway = t.oneway === 'yes' || t.junction === 'roundabout';
      let width = ROAD_WIDTH[t.highway];
      if (lanes) width = Math.max(width, lanes * 3.3 + 0.6);
      roads.push({
        id: way.id, kind: t.highway, name: t.name, lanes: lanes ?? (width > 9 ? (oneway ? 3 : 4) : oneway ? 1 : 2),
        oneway, width: r2(width), bridge: t.bridge === 'yes', layer: num(t.layer) ?? 0, pts,
      });
      stats.roads++;
      stats.roadKm += km;
      if (t.name) stats.namedRoads++;
    } else if (PATH_WIDTH[t.highway]) {
      paths.push({ id: way.id, kind: t.highway, width: PATH_WIDTH[t.highway], pts });
    }
  } else if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.natural === 'wood') {
    const outer = ring(way);
    if (outer) areas.push({ id: way.id, kind: 'green', name: t.name, outer });
  } else if (t.natural === 'water') {
    const outer = ring(way);
    if (outer) areas.push({ id: way.id, kind: 'water', name: t.name, outer });
  }
}

for (const el of osm.elements) {
  if (el.type === 'relation' && el.tags?.building) {
    const outers = [];
    const holes = [];
    for (const m of el.members ?? []) {
      const w = m.type === 'way' && ways.get(m.ref);
      const r = w && ring(w);
      if (!r) continue;
      (m.role === 'inner' ? holes : outers).push(r);
    }
    outers.forEach((outer, i) => buildingFrom(el.id * 10 + i, el.tags, outer, i === 0 ? holes : []));
  } else if (el.type === 'node' && el.tags) {
    const [x, z] = project(el.lat, el.lon);
    if (el.tags.natural === 'tree') trees.push(r2(x), r2(z));
    else if (el.tags.highway === 'traffic_signals') signals.push(r2(x), r2(z));
    else if (el.tags.highway === 'bus_stop') busStops.push(r2(x), r2(z));
    else if (el.tags.barrier === 'bollard') bollards.push(r2(x), r2(z));
  }
}

/** Metres the colonnade of a Connaught Place block stands out from its wall; the game builds it to match. */
const ARCADE_DEPTH = 2.6;

/**
 * Connaught Place's blocks front the street with a colonnade. Which walls have room for one is worked out here,
 * where every road is to hand: a wall gets it when the columns would stand clear of every carriageway and of the
 * next building. The service lanes behind the blocks and the passages through them get none, as in the place itself.
 * Each such building is given `arcade`: the numbers of the edges of its outline that carry one.
 */
function markArcades(plaza, mid) {
  const near = (pts, reach) => {
    for (let i = 0; i < pts.length; i += 2) if (Math.hypot(pts[i] - plaza[0], pts[i + 1] - plaza[1]) < reach) return true;
    return false;
  };
  const inRing = (x, z, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      if (r[i + 1] > z !== r[j + 1] > z && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
    }
    return inside;
  };
  const toSegment = (x, z, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
    return Math.hypot(x - ax - t * dx, z - az - t * dz);
  };
  const local = roads.filter((r) => near(r.pts, 520));
  const around = buildings.filter((b) => near(b.outer, 520));
  let walls = 0;
  for (const b of around) {
    const [cx, cz] = mid(b.outer);
    // the same buildings the game dresses as white Georgian blocks
    if (Math.hypot(cx - plaza[0], cz - plaza[1]) >= 380 || b.historic || ['roof', 'shed', 'garage'].includes(b.kind)) continue;
    if (Math.abs(ringArea(b.outer)) < 150 || b.minHeight > 0) continue;
    // Where OpenStreetMap gives a block no height, it is what every block here is: two tall storeys.
    if (b.guessed) b.height = Math.min(b.height, 11.2);
    if (b.height > 18) continue;
    const o = b.outer, n = o.length / 2, out = ringArea(o) < 0 ? 1 : -1;
    const arcade = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = o[i * 2], az = o[i * 2 + 1], dx = o[j * 2] - ax, dz = o[j * 2 + 1] - az;
      const len = Math.hypot(dx, dz);
      if (len < 2) continue;
      const nx = (-dz / len) * out, nz = (dx / len) * out;
      let clear = true;
      for (let k = 0; k <= 4 && clear; k++) {
        // where the columns would stand, and a little beyond them
        const wx = ax + (dx * k) / 4, wz = az + (dz * k) / 4;
        const x = wx + nx * (ARCADE_DEPTH + 0.4), z = wz + nz * (ARCADE_DEPTH + 0.4);
        for (const r of local) {
          for (let q = 0; q + 3 < r.pts.length && clear; q += 2) {
            if (toSegment(x, z, r.pts[q], r.pts[q + 1], r.pts[q + 2], r.pts[q + 3]) < r.width / 2 + 0.8) clear = false;
            // a lane that runs between the wall and the columns
            else if (toSegment(wx, wz, r.pts[q], r.pts[q + 1], r.pts[q + 2], r.pts[q + 3]) < ARCADE_DEPTH + 0.4) clear = false;
          }
          if (!clear) break;
        }
        if (clear) clear = !around.some((other) => inRing(x, z, other.outer) && !other.holes.some((h) => inRing(x, z, h)));
      }
      if (clear) arcade.push(i);
    }
    if (arcade.length) {
      b.arcade = arcade;
      walls += arcade.length;
    }
  }
  console.log(`Connaught Place: colonnades on ${walls} walls of ${around.filter((b) => b.arcade).length} blocks`);
}

const [minX, maxZ] = project(south, west);
const [maxX, minZ] = project(north, east);
const [sx, sz] = project(...area.spawn);
stats.roadKm = r2(stats.roadKm);
const bounds = { minX: r2(minX), maxX: r2(maxX), minZ: r2(minZ), maxZ: r2(maxZ) };
const head = { version: 2, area: area.name, attribution: '© OpenStreetMap contributors, ODbL', origin: { lat: lat0, lon: lon0 } };
const kb = (o) => Math.round(JSON.stringify(o).length / 1024);

if (!area.cell) {
  const tile = { ...head, bounds, spawn: [r2(sx), r2(sz)], roads, paths, buildings, areas, trees, signals, bollards, busStops, stats };
  const outPath = join(root, 'public/tiles', `${areaId}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(tile));
  console.log(`${area.name}: ${((maxX - minX) * (maxZ - minZ) / 1e6).toFixed(2)} km², ${kb(tile)} kB -> ${outPath}`);
} else {
  // Each feature goes to the one cell its middle falls in. Coordinates stay absolute, so a road
  // that crosses into the next cell is still drawn whole by the cell that owns it.
  const size = area.cell;
  const cols = Math.ceil((maxX - minX) / size), rows = Math.ceil((maxZ - minZ) / size);
  const cells = new Map();
  const cellOf = (x, z) => {
    const i = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / size)));
    const j = Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / size)));
    const key = `${i}_${j}`;
    if (!cells.has(key)) {
      cells.set(key, {
        ...head, bounds: { minX: r2(minX + i * size), maxX: r2(minX + (i + 1) * size), minZ: r2(minZ + j * size), maxZ: r2(minZ + (j + 1) * size) },
        spawn: [r2(sx), r2(sz)], roads: [], paths: [], buildings: [], areas: [], trees: [], signals: [], bollards: [], busStops: [], stats: {},
      });
    }
    return cells.get(key);
  };
  const mid = (pts) => {
    let x = 0, z = 0;
    for (let i = 0; i < pts.length; i += 2) {
      x += pts[i];
      z += pts[i + 1];
    }
    return [x / (pts.length / 2), z / (pts.length / 2)];
  };
  for (const r of roads) cellOf(...mid(r.pts)).roads.push(r);
  for (const p of paths) cellOf(...mid(p.pts)).paths.push(p);
  for (const b of buildings) cellOf(...mid(b.outer)).buildings.push(b);
  for (const a of areas) cellOf(...mid(a.outer)).areas.push(a);
  for (const [list, field] of [[trees, 'trees'], [signals, 'signals'], [bollards, 'bollards'], [busStops, 'busStops']]) {
    for (let i = 0; i < list.length; i += 2) cellOf(list[i], list[i + 1])[field].push(list[i], list[i + 1]);
  }

  const park = areas.find((a) => a.name === 'Rajiv Chowk Central Park');
  const plaza = park ? mid(park.outer).map(r2) : [0, 0];
  if (park) markArcades(plaza, mid);
  const dir = join(root, 'public/tiles', areaId);
  mkdirSync(dir, { recursive: true });
  let total = 0;
  for (const [key, cell] of cells) {
    cell.stats = { buildings: cell.buildings.length, roads: cell.roads.length };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(cell));
    total += kb(cell);
  }
  const index = { ...head, bounds, cell: size, cols, rows, spawn: [r2(sx), r2(sz)], plaza, cells: [...cells.keys()].sort(), stats };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  // Every road, park and traffic signal in one file, for the GPS, the big map and the traffic: they need the whole city, not just the cells round the car.
  const overview = { ...head, bounds, spawn: index.spawn, roads, areas, paths: [], buildings: [], trees: [], signals, stats: {} };
  writeFileSync(join(dir, 'overview.json'), JSON.stringify(overview));
  console.log(`overview: ${kb(overview)} kB`);
  console.log(`${area.name}: ${((maxX - minX) * (maxZ - minZ) / 1e6).toFixed(1)} km² in ${cells.size} cells of ${size} m (${cols}×${rows}), ${total} kB -> ${dir}`);
}
console.log(stats);
console.log(`paths ${paths.length}, green/water areas ${areas.length}, trees ${trees.length / 2}, signals ${signals.length / 2}, bollards ${bollards.length / 2}, bus stops ${busStops.length / 2}`);
