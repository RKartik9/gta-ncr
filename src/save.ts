/**
 * Progress kept in the browser between visits: where the car is, which car, camera, clock and waypoint.
 * Storage can be blocked or wiped (private windows, cleared site data), so every read and write is guarded
 * and the game simply starts fresh when there is nothing usable.
 */
export interface Progress {
  car: string;
  x: number;
  z: number;
  /** radians */
  heading: number;
  camera: string;
  hour: number;
  clockRunning: boolean;
  waypoint: [number, number] | null;
  /** null: headlights on by themselves after dark */
  headlights: boolean | null;
}

import { CITY } from './config.ts';

const KEY = `delhi-drive:progress:v1${CITY === 'delhi' ? '' : `:${CITY}`}`;
const finite = (...n: unknown[]) => n.every((v) => typeof v === 'number' && Number.isFinite(v));

export function loadProgress(): Progress | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Progress | null;
    // anything malformed (an older format, a hand edit) is ignored rather than trusted
    if (!p || typeof p.car !== 'string' || !finite(p.x, p.z, p.heading, p.hour)) return null;
    if (p.waypoint && !(Array.isArray(p.waypoint) && finite(p.waypoint[0], p.waypoint[1]))) p.waypoint = null;
    return p;
  } catch {
    return null;
  }
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage full or blocked: carry on without saving
  }
}

export function clearProgress() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
