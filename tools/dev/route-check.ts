// GPS check: one-way streets are obeyed, and a real trip across the baked map comes out a sensible length.
// Run with: node tools/dev/route-check.ts (after npm run bake)
import { readFileSync } from 'node:fs';
import { RoadGraph, pathLength } from '../../src/world/route.ts';
import type { Road, Tile } from '../../src/world/tile.ts';

const road = (pts: number[], oneway: boolean): Road => ({ id: 0, kind: 'residential', lanes: 1, oneway, width: 6, bridge: false, layer: 0, pts });

// A square block: the short way round from (0,0) to (100,0) is one-way the wrong way, so the route goes round the other three sides.
const block = new RoadGraph([road([100, 0, 0, 0], true), road([0, 0, 0, 100, 100, 100, 100, 0], false)]);
const around = block.route(0, 0, 100, 0)!;
console.log(`one-way block: ${pathLength(around).toFixed(0)} m`);
if (Math.abs(pathLength(around) - 300) > 1) throw new Error('the route took a one-way street the wrong way');
const back = block.route(100, 0, 0, 0)!;
if (Math.abs(pathLength(back) - 100) > 1) throw new Error('the route missed the one-way street going its own way');

const dir = new URL('../../public/tiles/central/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const roads = (index.cells as string[]).flatMap((k) => (JSON.parse(readFileSync(new URL(`${k}.json`, dir), 'utf8')) as Tile).roads);
const city = new RoadGraph(roads);
const t0 = performance.now();
const trip = city.route(410, 3, 1100, 2069)!; // Inner Circle to Kartavya Path
const ms = performance.now() - t0;
const straight = Math.hypot(1100 - 410, 2069 - 3);
console.log(`CP to India Gate: ${pathLength(trip).toFixed(0)} m by road (${straight.toFixed(0)} m straight), ${trip.length / 2} points, ${ms.toFixed(0)} ms`);
if (!trip || pathLength(trip) < straight || pathLength(trip) > straight * 2) throw new Error('the CP to India Gate route is not a sensible length');
