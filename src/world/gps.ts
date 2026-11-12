import * as THREE from 'three/webgpu';
import { GeoBuilder, ribbon } from './geo.ts';
import { type RoadGraph, pathLength } from './route.ts';
import { ROUTE_COLOUR } from '../hud/hud.ts';

/** Metres from the end of the route that count as having arrived. */
const ARRIVE = 22;

/**
 * The waypoint and the road route to it: a purple line painted along the road, a beam of light over the
 * destination, and the polyline the minimap and the big map draw.
 * ponytail: re-routes from scratch once a second (a few ms on this map); go incremental if the map grows a lot.
 */
export class Gps {
  waypoint: [number, number] | null = null;
  route: number[] | null = null;
  length: number | null = null;
  private graph: RoadGraph | null = null;
  private timer = 0;
  private line: THREE.Mesh;
  private beacon: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const lineMat = new THREE.MeshBasicMaterial({ color: ROUTE_COLOUR, transparent: true, opacity: 0.55, depthWrite: false });
    lineMat.polygonOffset = true;
    lineMat.polygonOffsetFactor = -10;
    lineMat.polygonOffsetUnits = -40;
    this.line = new THREE.Mesh(new THREE.BufferGeometry(), lineMat);
    this.line.renderOrder = 3;
    this.line.frustumCulled = false;
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 180, 20, 1, true).translate(0, 90, 0),
      new THREE.MeshBasicMaterial({ color: ROUTE_COLOUR, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    this.line.visible = this.beacon.visible = false;
    scene.add(this.line, this.beacon);
  }

  get ready() {
    return this.graph !== null;
  }

  setGraph(graph: RoadGraph, car: THREE.Vector3) {
    this.graph = graph;
    if (this.waypoint) this.reroute(car);
  }

  /** New waypoint, or null to clear it. */
  set(p: [number, number] | null, car: THREE.Vector3) {
    this.waypoint = p;
    this.reroute(car);
  }

  /** Once a frame. Returns true on the frame the car reaches the waypoint. */
  update(dt: number, car: THREE.Vector3) {
    if (!this.waypoint) return false;
    this.timer -= dt;
    if (this.timer <= 0) this.reroute(car);
    const route = this.route;
    if (route && Math.hypot(car.x - route[route.length - 2], car.z - route[route.length - 1]) < ARRIVE) {
      this.set(null, car);
      return true;
    }
    return false;
  }

  private reroute(car: THREE.Vector3) {
    this.timer = 1;
    const p = this.waypoint;
    this.route = p && this.graph ? this.graph.route(car.x, car.z, p[0], p[1]) : null;
    this.length = this.route ? pathLength(this.route) : null;
    this.line.geometry.dispose();
    if (this.route && this.route.length >= 4) {
      const b = new GeoBuilder();
      ribbon(b, this.route, 1.8, 0.12, 10, false);
      this.line.geometry = b.build();
    } else this.line.geometry = new THREE.BufferGeometry();
    this.line.visible = !!this.route;
    this.beacon.visible = !!p;
    if (p) {
      // the beam stands where the route ends: on the road nearest the point picked
      const r = this.route;
      this.beacon.position.set(r ? r[r.length - 2] : p[0], 0, r ? r[r.length - 1] : p[1]);
    }
  }
}
