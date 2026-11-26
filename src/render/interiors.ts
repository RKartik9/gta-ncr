import * as THREE from 'three/webgpu';
import { cameraPosition, float, floor, fract, hash, max, min, mix, normalWorld, positionWorld, select, sign, smoothstep, step, texture, uniform, uv, vec2, vec3, vertexColor } from 'three/tsl';

/**
 * Rooms behind the windows of a facade, as light: each pane looks into a box of its own (back wall, side walls,
 * floor and ceiling, found by following the view ray in), so the windows have depth as the car drives past. At
 * night each window is lit or dark and lit its own colour, warm bulbs mostly, the odd cool tube or television.
 * By day the rooms show faintly through the glass. After the interior mapping in three.js's skyscraper example
 * and mrdoob's slop-newyork (MIT).
 *
 * The facade's own texture still draws the wall and the frames; `orm`'s blue channel (metalness) marks the panes.
 * Wall UVs run in whole bays and floors (see wall() in buildings.ts), so uv × (bays, floors) counts windows.
 * `bayWidth` and `floorHeight` are a window cell's size in metres. Returns the emissive node and the uniform that sets how lit the city is (0 by day, ~1 at night).
 */
export function windowInteriors(orm: THREE.Texture, bays: number, floors: number, bayWidth: number, floorHeight: number) {
  const glow = uniform(0);
  const grid = uv().mul(vec2(bays, floors));
  const cell = floor(grid);
  const local = fract(grid);
  // one building's tint differs from the next, so its windows do too; the cell sets which window of it this is
  const tint = vertexColor();
  const seed = cell.x.mul(17.13).add(cell.y.mul(91.7)).add(tint.r.mul(733.1)).add(tint.g.mul(311.7)).add(tint.b.mul(157.3));
  const h1 = hash(seed), h2 = hash(seed.add(7.1)), h3 = hash(seed.add(13.7));
  const pane = smoothstep(0.5, 0.8, texture(orm).b);

  // the view ray in the window's own frame: x along the wall, y up, z into the building
  const n = normalWorld;
  const along = vec3(n.z, 0, n.x.negate()).normalize();
  const view = positionWorld.sub(cameraPosition).normalize();
  // in the room's units: it spans the cell, -1..1 each way, and is 4 m deep (so its depth runs 0..1)
  const rx = view.dot(along).div(bayWidth / 2), ry = view.y.div(floorHeight / 2), rz = max(view.dot(n).negate(), 0.05).div(4);
  const depth = float(1);
  const px = local.x.mul(2).sub(1), py = local.y.mul(2).sub(1);
  // distance along the ray to each pair of walls: the side it is heading for, from where it enters
  const sx = select(rx.abs().lessThan(1e-4), float(1e-4), rx), sy = select(ry.abs().lessThan(1e-4), float(1e-4), ry);
  const tx = sign(sx).sub(px).div(sx), ty = sign(sy).sub(py).div(sy);
  const tz = depth.div(rz);
  const t = min(min(tx, ty), tz);
  const hitZ = rz.mul(t).div(depth); // 0 at the glass, 1 at the back wall
  const back = step(tz, min(tx, ty));
  const isFloor = step(ty, min(tx, tz)).mul(step(ry, 0));
  const isCeiling = step(ty, min(tx, tz)).mul(step(0, ry));
  // painted walls in a few household colours; floors darker; the ceiling catches the bulb
  const wallCol = mix(vec3(0.85, 0.78, 0.66), vec3(0.62, 0.72, 0.74), h2);
  let room = mix(wallCol.mul(0.75), wallCol, back);
  room = mix(room, vec3(0.32, 0.24, 0.18), isFloor);
  room = mix(room, vec3(1, 0.97, 0.9), isCeiling);
  // deeper is darker: the light is near the window
  room = room.mul(float(1).sub(hitZ.mul(0.45)));

  const lit = step(h1, 0.48);
  const bulb = select(h3.lessThan(0.12), vec3(0.6, 0.75, 1), mix(vec3(1, 0.68, 0.38), vec3(1, 0.88, 0.7), h3));
  // a room is lit by one bulb, not floodlit: kept under the bloom threshold so its walls stay visible
  const night = room.mul(bulb).mul(lit).mul(glow).mul(mix(0.25, 0.6, h2));
  const day = room.mul(0.05);
  return { emissive: night.add(day).mul(pane), glow };
}
