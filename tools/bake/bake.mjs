// Bakes an OpenStreetMap extract (Overpass JSON) into a compact tile the game loads.
// Usage: node tools/bake/bake.mjs [--fetch] [--area central|cp|mumbai] [--pbf extract.osm.pbf]
// --pbf cuts the area out of a local OpenStreetMap extract (e.g. Geofabrik's india-latest) with osmium-tool, for when
// Overpass is too busy to answer.
// `central` is fetched in ~2 km chunks and written as 1 km cells under public/tiles/central/, plus an index.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  // South Bombay: Bandra and the Sea Link, Worli, the Coastal Road, Marine Drive, the Fort and Colaba. Mumbai is
  // 1,150 km from Connaught Place, too far for float32 positions, so it has an origin of its own (the bbox's middle).
  mumbai: { name: 'Mumbai', bbox: [18.89, 72.79, 19.065, 72.86], origin: [18.9775, 72.825], spawn: [19.04176, 72.82121], cell: 1000, chunk: [0.0175, 0.0175], sea: true, highRise: true },
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
/** metres of sea drawn past the map's edge; matches the base plane's run-out in the game */
const SEA_PAD = 2500;
const M_PER_DEG = 111_319.49;

const args = process.argv.slice(2);
const areaId = args.includes('--area') ? args[args.indexOf('--area') + 1] : 'central';
const area = AREAS[areaId];
if (!area) throw new Error(`unknown area ${areaId}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRaw([s, w, n, e], rawPath, depth = 0) {
  const q = `[out:json][timeout:180][bbox:${s},${w},${n},${e}];(way["highway"];way["building"];relation["building"];way["leisure"~"park|garden"];way["landuse"];way["natural"~"water|wood|tree_row"];node["natural"="tree"];node["highway"~"traffic_signals|crossing|street_lamp|bus_stop"];node["barrier"="bollard"];way["barrier"];way["railway"];way["natural"="coastline"];);out body;>;out skel qt;`;
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

/** osmium's OPL text (one element a line) as Overpass JSON elements. */
function fromOpl(text) {
  const unescape = (v) => v.replace(/%([0-9a-f]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  const elements = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const el = { type: { n: 'node', w: 'way', r: 'relation' }[line[0]] };
    for (const [i, f] of line.split(' ').entries()) {
      const k = f[0], v = f.slice(1);
      if (i === 0) el.id = Number(v);
      else if (k === 'T' && v) el.tags = Object.fromEntries(v.split(',').map((kv) => kv.split('=').map(unescape)));
      else if (k === 'x') el.lon = Number(v);
      else if (k === 'y') el.lat = Number(v);
      else if (k === 'N') el.nodes = v ? v.split(',').map((n) => Number(n.slice(1))) : [];
      else if (k === 'M') el.members = v ? v.split(',').map((m) => {
        const [ref, role] = m.split('@');
        return { type: { n: 'node', w: 'way', r: 'relation' }[ref[0]], ref: Number(ref.slice(1)), role: unescape(role ?? '') };
      }) : [];
    }
    elements.push(el);
  }
  return elements;
}

/** Cuts [s, w, n, e] out of a .osm.pbf, keeping what `filters` (osmium tags-filter expressions) match, as Overpass JSON. */
function cutPbf(pbf, [s, w, n, e], filters, outPath) {
  const tmp = `${outPath}.tmp.pbf`;
  execFileSync('osmium', ['extract', '-b', `${w},${s},${e},${n}`, '--strategy', 'complete_ways', '-O', '-o', tmp, pbf], { stdio: 'inherit' });
  const opl = execFileSync('osmium', ['tags-filter', tmp, ...filters, '-f', 'opl,add_metadata=false', '-o', '-'], { maxBuffer: 2 ** 31 - 1 }).toString();
  unlinkSync(tmp);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ elements: fromOpl(opl) }));
}

// One area is fetched as one or more chunks; elements shared by neighbouring chunks are kept once.
const chunks = [];
const pbf = args.includes('--pbf') ? args[args.indexOf('--pbf') + 1] : null;
if (pbf) {
  const path = join(root, 'tools/bake/raw', areaId, 'extract.json');
  cutPbf(pbf, area.bbox, ['w/highway', 'w/building', 'r/building', 'w/leisure', 'w/landuse', 'w/natural', 'n/natural=tree', 'n/highway', 'n/barrier=bollard', 'w/barrier', 'w/railway'], path);
  if (area.sea) {
    const p = SEA_PAD / M_PER_DEG, [s, w, n, e] = area.bbox;
    cutPbf(pbf, [s - p, w - p * 1.1, n + p, e + p * 1.1], ['w/natural=coastline'], join(root, 'tools/bake/raw', areaId, 'coastline.json'));
  }
  chunks.push({ bbox: area.bbox, path });
} else if (existsSync(join(root, 'tools/bake/raw', areaId, 'extract.json'))) {
  // cut from a .osm.pbf before: bake from that again
  chunks.push({ bbox: area.bbox, path: join(root, 'tools/bake/raw', areaId, 'extract.json') });
} else if (area.chunk) {
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
  if (!c.path.endsWith('extract.json') && (args.includes('--fetch') || !existsSync(c.path))) {
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
const [lat0, lon0] = area.origin ?? CP_ORIGIN;
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
  let levels = num(tags['building:levels']);
  // OpenStreetMap's typos: "500" for a 21-storey block, 123 storeys on a 13 m footprint. A height far past its
  // storeys gives way to them, and nothing stands taller than eight times its width or the city's tallest tower.
  const width = Math.sqrt(Math.abs(ringArea(outer)));
  if (height && levels && height > levels * 6) height = null;
  if (levels && levels * LEVEL_HEIGHT > width * 8) levels = null;
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
    if (area.highRise && size >= 60 && !['roof', 'shed', 'garage', 'industrial', 'warehouse', 'service', 'house'].includes(kind)) {
      // Bombay builds up: old four- and five-storey chawls and walk-ups, seven- to twelve-storey housing societies,
      // and on a big plot as often as not a tower of twenty to forty-five floors
      const r = hash(id * 31 + 7);
      const floors = size < 200 ? 3 + Math.floor(r * 3) : size < 700 ? 5 + Math.floor(r * 7) : r < 0.35 ? 20 + Math.floor(hash(id * 7) * 26) : 7 + Math.floor(r * 6);
      height = floors * LEVEL_HEIGHT + 1;
    }
  }
  height = Math.min(height, 320, Math.max(30, width * 8));
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
  } else if (t.natural === 'sand' || t.natural === 'beach') {
    const outer = ring(way);
    if (outer) areas.push({ id: way.id, kind: 'sand', name: t.name, outer });
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

/**
 * The sea. OpenStreetMap has no sea polygons, only the coastline: ways with the land on their left. The coastline
 * is fetched for the area plus `pad` metres (so the sea runs on past the map's edge, as the base plane does), joined
 * into chains, cut where it leaves that rectangle, and closed along the rectangle's edge into polygons of water.
 * Islets wholly inside are left out (they would be holes); a rock or two goes under.
 */
async function seaPolygons(rect) {
  const [s, w, n, e] = area.bbox;
  const padDeg = SEA_PAD / M_PER_DEG;
  const rawPath = join(root, 'tools/bake/raw', areaId, 'coastline.json');
  if (!existsSync(rawPath)) {
    const q = `[out:json][timeout:180];way["natural"="coastline"](${s - padDeg},${w - padDeg * 1.1},${n + padDeg},${e + padDeg * 1.1});out body;>;out skel qt;`;
    const res = await fetch(OVERPASS[0], { method: 'POST', body: new URLSearchParams({ data: q }), headers: { 'User-Agent': 'delhi-drive-bake/0.2' } });
    if (!res.ok) throw new Error(`coastline: HTTP ${res.status}`);
    writeFileSync(rawPath, await res.text());
  }
  const coast = JSON.parse(readFileSync(rawPath, 'utf8')).elements;
  const cn = new Map(coast.filter((el) => el.type === 'node').map((el) => [el.id, el]));
  // join ways end to start into chains of node ids
  const byStart = new Map();
  for (const el of coast) if (el.type === 'way') byStart.set(el.nodes[0], [...el.nodes]);
  const chains = [];
  while (byStart.size) {
    const [first, chain] = byStart.entries().next().value;
    byStart.delete(first);
    for (let next; (next = byStart.get(chain[chain.length - 1])) && chain[0] !== chain[chain.length - 1]; ) {
      byStart.delete(next[0]);
      chain.push(...next.slice(1));
    }
    // a chain whose head another chain ends on is picked up by that one
    const before = [...byStart.values()].find((c) => c[c.length - 1] === chain[0]);
    if (before) before.push(...chain.slice(1));
    else chains.push(chain);
  }
  const { minX, maxX, minZ, maxZ } = rect;
  const inside = ([x, z]) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  // Liang-Barsky: the part of segment a→b inside the rectangle, as [t0, t1], or null
  const clip = (a, b) => {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - minX], [dx, maxX - a[0]], [-dz, a[1] - minZ], [dz, maxZ - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    return t0 <= t1 ? [t0, t1] : null;
  };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const pieces = [];
  for (const chain of chains) {
    const pts = chain.map((id) => cn.get(id)).filter(Boolean).map((nd) => project(nd.lat, nd.lon));
    const closed = chain[0] === chain[chain.length - 1];
    if (closed && pts.every(inside)) continue; // an islet
    let cur = null;
    const mine = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const c = clip(pts[i], pts[i + 1]);
      if (!c) continue;
      if (!cur) mine.push((cur = [lerp(pts[i], pts[i + 1], c[0])]));
      cur.push(lerp(pts[i], pts[i + 1], c[1]));
      if (c[1] < 1) cur = null;
    }
    // a closed chain that starts inside the rectangle: its last piece runs on into its first
    if (closed && mine.length > 1 && inside(pts[0])) mine[0] = [...mine.pop(), ...mine[0].slice(1)];
    pieces.push(...mine);
  }
  // Walk the rectangle's edge with the water on the left (x east, z south: the way that gives a positive area).
  const W = maxX - minX, H = maxZ - minZ, L = 2 * (W + H);
  const edgeT = ([x, z]) => {
    const d = [Math.abs(z - minZ), Math.abs(x - maxX), Math.abs(z - maxZ), Math.abs(x - minX)];
    const k = d.indexOf(Math.min(...d));
    if (d[k] > 1) return null; // the coastline stops short of the edge: broken in OpenStreetMap
    return [x - minX, W + z - minZ, W + H + maxX - x, 2 * W + H + maxZ - z][k];
  };
  const corners = [[W, [maxX, minZ]], [W + H, [maxX, maxZ]], [2 * W + H, [minX, maxZ]], [L, [minX, minZ]]];
  if (!pieces.length) return [];
  const open = pieces.map((p) => ({ p, a: edgeT(p[0]), b: edgeT(p[p.length - 1]) })).filter((o) => o.a !== null && o.b !== null);
  console.log(`sea: ${chains.length} coastline chains, ${open.length} of ${pieces.length} pieces reach the edge`);
  const polys = [];
  const used = new Set();
  for (const start of open) {
    if (used.has(start)) continue;
    const ring = [];
    for (let o = start; !used.has(o); ) {
      used.add(o);
      ring.push(...o.p);
      // the next piece to come in along the edge ahead
      const ahead = (t) => (t - o.b + L) % L;
      const next = open.reduce((best, c) => (ahead(c.a) < ahead(best.a) ? c : best));
      for (const [t, c] of [...corners, ...corners.map(([t, c]) => [t + L, c])]) if (t > o.b && t < o.b + ahead(next.a)) ring.push(c);
      o = next;
    }
    if (ring.length >= 3 && ringArea(ring.flat()) > 0) polys.push(ring);
  }
  return polys;
}

/** Sutherland-Hodgman: the part of a polygon (array of [x, z]) inside a rectangle. */
function clipToRect(poly, { minX, maxX, minZ, maxZ }) {
  let out = poly;
  for (const [inside, cross] of [
    [(p) => p[0] >= minX, (a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= maxX, (a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= minZ, (a, b) => [a[0] + ((b[0] - a[0]) * (minZ - a[1])) / (b[1] - a[1]), minZ]],
    [(p) => p[1] <= maxZ, (a, b) => [a[0] + ((b[0] - a[0]) * (maxZ - a[1])) / (b[1] - a[1]), maxZ]],
  ]) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cross(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cross(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * Flyovers and sea bridges. A road on a bridge (or a layer above the ground), or out over the sea, is raised:
 * `elev` gives the deck's height at each of its points. It stands 6.5 m up (13 m for a second tier, 10 m over the sea) and comes
 * down at 1 in 12 to every point where it meets a road on the ground, measured along the flyover itself, so a
 * flyover cut into several ways in OpenStreetMap stays up across the joins.
 */
function raiseFlyovers(sea) {
  const inRing = (x, z, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (poly[i][1] > z !== poly[j][1] > z && x < ((poly[j][0] - poly[i][0]) * (z - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) inside = !inside;
    }
    return inside;
  };
  // a road whose middle stands in the sea is a sea bridge (the Sea Link), however OpenStreetMap tags each piece
  const overSea = new Set(roads.filter((r) => {
    const m = Math.floor(r.pts.length / 4) * 2;
    return sea.some((poly) => inRing(r.pts[m], r.pts[m + 1], poly));
  }));
  const lifted = (r) => overSea.has(r) || ((r.bridge || r.layer > 0) && r.layer >= 0);
  const key = (x, z) => `${x},${z}`;
  const grounded = new Set();
  for (const r of roads) if (!lifted(r)) for (let i = 0; i < r.pts.length; i += 2) grounded.add(key(r.pts[i], r.pts[i + 1]));
  const up = roads.filter(lifted);
  const edges = new Map();
  const link = (a, b, d) => (edges.get(a) ?? edges.set(a, []).get(a)).push([b, d]);
  const top = new Map();
  for (const r of up) {
    // the Sea Link's deck rides 10 m over the water
    for (let i = 0; i < r.pts.length; i += 2) {
      const k = key(r.pts[i], r.pts[i + 1]);
      top.set(k, Math.max(top.get(k) ?? 0, overSea.has(r) ? 10 : r.layer >= 2 ? 13 : 6.5));
      if (i) {
        const j = key(r.pts[i - 2], r.pts[i - 1]);
        const d = Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]);
        link(k, j, d);
        link(j, k, d);
      }
    }
  }
  // where it comes down: onto a ground road, or at a loose end
  const dist = new Map();
  for (const k of edges.keys()) if (grounded.has(k)) dist.set(k, 0);
  for (const r of up) {
    for (const i of [0, r.pts.length - 2]) {
      const k = key(r.pts[i], r.pts[i + 1]);
      if (edges.get(k).length === 1) dist.set(k, 0);
    }
  }
  // Dijkstra from every touchdown
  const queue = [...dist.entries()];
  while (queue.length) {
    let best = 0;
    for (let q = 1; q < queue.length; q++) if (queue[q][1] < queue[best][1]) best = q;
    const [k, d] = queue.splice(best, 1)[0];
    if (d > dist.get(k)) continue;
    for (const [n, w] of edges.get(k) ?? []) {
      if (d + w < (dist.get(n) ?? Infinity)) {
        dist.set(n, d + w);
        queue.push([n, d + w]);
      }
    }
  }
  let raised = 0;
  for (const r of up) {
    const elev = [];
    for (let i = 0; i < r.pts.length; i += 2) {
      const k = key(r.pts[i], r.pts[i + 1]);
      elev.push(r2(Math.min(top.get(k), (dist.get(k) ?? Infinity) / 12)));
    }
    if (Math.max(...elev) > 0.3) {
      r.elev = elev;
      raised++;
    }
  }
  console.log(`flyovers: ${raised} raised ways`);
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
const seaPolys = area.sea ? await seaPolygons({ minX: minX - SEA_PAD, maxX: maxX + SEA_PAD, minZ: minZ - SEA_PAD, maxZ: maxZ + SEA_PAD }) : [];
raiseFlyovers(seaPolys);
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
  if (area.sea) {
    // each cell gets the sea over its own square; the cells on the map's edge also take the sea beyond it
    const P = SEA_PAD;
    const sea = seaPolys;
    let n = 0;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const rect = {
        minX: i === 0 ? minX - P : minX + i * size, maxX: i === cols - 1 ? maxX + P : minX + (i + 1) * size,
        minZ: j === 0 ? minZ - P : minZ + j * size, maxZ: j === rows - 1 ? maxZ + P : minZ + (j + 1) * size,
      };
      for (const poly of sea) {
        const part = clipToRect(poly, rect);
        if (part.length < 3 || Math.abs(ringArea(part.flat())) < 1) continue;
        const a = { id: -(++n), kind: 'water', name: 'Arabian Sea', sea: true, outer: part.flat().map(r2) };
        // filed by the cell it covers, not by its middle (which for an edge cell may lie off the map)
        const cell = cellOf(minX + (i + 0.5) * size, minZ + (j + 0.5) * size);
        cell.areas.push(a);
        areas.push(a);
      }
    }
    console.log(`sea: ${sea.length} polygons, ${n} pieces over the cells`);
  }
  for (const [list, field] of [[trees, 'trees'], [signals, 'signals'], [bollards, 'bollards'], [busStops, 'busStops']]) {
    for (let i = 0; i < list.length; i += 2) cellOf(list[i], list[i + 1])[field].push(list[i], list[i + 1]);
  }

  const park = areas.find((a) => a.name === 'Rajiv Chowk Central Park');
  const plaza = park ? mid(park.outer).map(r2) : null;
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
