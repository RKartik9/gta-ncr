import * as THREE from 'three/webgpu';
import type { CarSpec } from '../vehicle/cars.ts';
import { rideHeight } from '../vehicle/cars.ts';
import type { Vehicle } from '../vehicle/vehicle.ts';
import { clamp, damp, lerp } from '../util.ts';

export const CAMERA_MODES = ['top', 'chase', 'hood', 'cockpit', 'cinematic', 'drone'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
export const CAMERA_LABELS: Record<CameraMode, string> = {
  top: 'Top-down', chase: 'Chase', hood: 'Hood', cockpit: 'Cockpit', cinematic: 'Cinematic', drone: 'Drone',
};

const UP = new THREE.Vector3(0, 1, 0);

/** Owns the one camera and moves it according to the active view. */
export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** called when the lens changes, so shadow cascades can be refitted */
  onLensChange: () => void = () => {};

  private snap = true;
  private yaw = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  /** chase camera's place relative to the car, smoothed there rather than in the world so it does not trail behind at speed */
  private chaseOffset = new THREE.Vector3();
  private fov = 55;
  private fitFov = 0;
  private fitNear = 0;

  // cinematic
  private cutAge = Infinity;
  private cutPos = new THREE.Vector3();
  private cutSeed = 1;

  // drone
  private orbitYaw = 0.6;
  private orbitPitch = 0.32;
  private orbitDistance = 11;

  // mouse look: drag to look round the car (or round the cabin), wheel to pull the chase camera in and out
  private lookYaw = 0;
  private lookPitch = 0;
  private lookIdle = 10;
  private chaseZoom = 1;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(this.fov, window.innerWidth / window.innerHeight, 0.15, 6000);
    let dragging = false;
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode === 'cinematic') return;
      dragging = true;
      dom.setPointerCapture(e.pointerId);
      dom.style.cursor = 'grabbing';
    });
    const release = () => {
      dragging = false;
      dom.style.cursor = '';
    };
    dom.addEventListener('pointerup', release);
    dom.addEventListener('pointercancel', release);
    dom.addEventListener('pointermove', (e) => {
      if (dragging) this.turn(e.movementX, e.movementY);
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.mode === 'drone') {
        this.orbitDistance = clamp(this.orbitDistance * Math.exp(e.deltaY * 0.001), 4, 260);
      } else if (this.mode === 'chase') this.chaseZoom = clamp(this.chaseZoom * Math.exp(e.deltaY * 0.001), 0.6, 3);
    }, { passive: false });
  }

  /** Look round by a mouse movement in pixels (or the controller's right stick, scaled to match). */
  turn(dx: number, dy: number) {
    if (this.mode === 'cinematic') return;
    if (this.mode === 'drone') {
      this.orbitYaw -= dx * 0.005;
      this.orbitPitch = clamp(this.orbitPitch + dy * 0.004, 0.03, 1.45);
      return;
    }
    const inside = this.mode === 'hood' || this.mode === 'cockpit';
    this.lookYaw = clamp(this.lookYaw - dx * 0.005, -Math.PI, Math.PI);
    this.lookPitch = clamp(this.lookPitch + dy * (inside ? -0.004 : 0.004), inside ? -0.6 : -0.35, inside ? 0.6 : 1.1);
    this.lookIdle = 0;
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.lookYaw = this.lookPitch = 0;
    this.snap = true;
    this.cutAge = Infinity;
  }

  next() {
    this.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length]);
  }

  /** Call when the car is moved or swapped, so the camera jumps instead of flying across the map. */
  cut() {
    this.snap = true;
    this.cutAge = Infinity;
  }

  update(dt: number, car: THREE.Object3D, vehicle: Vehicle, spec: CarSpec) {
    const cam = this.camera;
    const speed = vehicle.speed;
    const heading = vehicle.heading;
    const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const ground = car.position.y - rideHeight(spec);
    let fov = this.fov;
    let near = 0.15;
    cam.up.copy(UP);

    if (this.snap) this.yaw = heading;
    // Mouse look eases back behind the car once the mouse has been left alone and the car is moving.
    this.lookIdle += dt;
    if (this.lookIdle > 1.5 && Math.abs(speed) > 2) {
      const k = damp(2.5, dt);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
    }

    if (this.mode === 'top') {
      // Straight down from high up with a long lens: the classic view, and towers lean only slightly.
      // Fixed height, centred on the car: nothing moves by itself, so the road stays readable.
      const height = 62 - this.lookPitch * 30;
      this.look.set(car.position.x, ground, car.position.z);
      this.pos.set(car.position.x, ground + height, car.position.z);
      this.yaw = heading;
      cam.position.copy(this.pos);
      const spin = this.yaw + this.lookYaw;
      cam.up.set(Math.sin(spin), 0, Math.cos(spin)); // the car's nose points up the screen, unless turned by the mouse
      cam.lookAt(this.look.x, ground, this.look.z);
      fov = 32;
      near = 10;
    } else if (this.mode === 'chase') {
      // Locked behind the car at a fixed distance and angle. It used to swing with slides, pull back with speed
      // and jump in front of walls, all of which made the car hard to place on the road.
      this.yaw = heading;
      const back = (spec.length * 1.25 + 1.2) * this.chaseZoom;
      const pivot = new THREE.Vector3(car.position.x, ground + spec.height + 0.3, car.position.z);
      // orbit the pivot by the mouse-look angles; at rest this is the usual spot behind and above
      const yaw = this.yaw + this.lookYaw;
      const pitch = Math.atan2(spec.height * 0.75 + 1.05 - spec.height - 0.3, back) + this.lookPitch;
      const want = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(back).add(pivot);
      want.y = Math.max(want.y, ground + 0.4);
      // Smoothing the world position made the camera lag v/k behind the car: 8 m at top speed. Smoothing the
      // offset from the car instead keeps the distance steady at any speed and still eases bumps and turns.
      want.sub(pivot);
      if (this.snap) this.chaseOffset.copy(want);
      else this.chaseOffset.lerp(want, damp(10, dt));
      this.pos.copy(pivot).add(this.chaseOffset);
      cam.position.copy(this.pos);
      const lead = 2.5 * Math.max(0, Math.cos(this.lookYaw));
      cam.lookAt(car.position.x + fwd.x * lead, ground + spec.height * 0.72, car.position.z + fwd.z * lead);
      fov = 56;
    } else if (this.mode === 'hood' || this.mode === 'cockpit') {
      // Bolted to the car, so it leans and pitches with the body.
      const [x, y, z] = this.mode === 'hood' ? spec.hoodCamera : spec.cockpitCamera;
      const ride = rideHeight(spec);
      cam.position.copy(car.localToWorld(new THREE.Vector3(x, y - ride, z)));
      cam.up.set(0, 1, 0).applyQuaternion(car.quaternion);
      const drop = (this.mode === 'hood' ? 0.9 : 0.5) / 12;
      // look direction in car space, turned by the mouse: head turns, not a camera on a pole
      const dir = new THREE.Vector3(0, -drop + Math.tan(this.lookPitch), 1).applyAxisAngle(UP, this.lookYaw).normalize();
      cam.lookAt(car.localToWorld(new THREE.Vector3(x, y - ride, z).addScaledVector(dir, 12)));
      fov = this.mode === 'hood' ? 66 : 70;
      near = this.mode === 'hood' ? 0.1 : 0.06;
    } else if (this.mode === 'cinematic') {
      this.cutAge += dt;
      const distance = this.cutPos.distanceTo(car.position);
      const eye = new THREE.Vector3(car.position.x, ground + spec.height, car.position.z);
      const blocked = () => {
        const d = eye.clone().sub(this.cutPos);
        const len = d.length();
        return vehicle.castRay(this.cutPos, d.divideScalar(len), len - 1) !== null;
      };
      if (this.cutAge > 7 || distance > 95 || (this.cutAge > 0.7 && blocked())) {
        // New roadside position ahead of the car; try a few and keep the first with a clear view.
        for (let attempt = 0; attempt < 8; attempt++) {
          const r = rand(this.cutSeed++);
          const side = r < 0.5 ? -1 : 1;
          const ahead = 14 + rand(this.cutSeed++) * 30 + Math.max(0, speed) * 1.6;
          const out = 4 + rand(this.cutSeed++) * 7;
          const high = rand(this.cutSeed++);
          this.cutPos.set(
            car.position.x + fwd.x * ahead + fwd.z * out * side,
            ground + (high < 0.45 ? 0.5 + high * 2 : 3 + high * 9),
            car.position.z + fwd.z * ahead - fwd.x * out * side,
          );
          if (attempt === 7) this.cutPos.set(car.position.x - fwd.x * 9, ground + 14, car.position.z - fwd.z * 9);
          if (!blocked()) break;
        }
        this.cutAge = 0;
        this.snap = true;
      }
      cam.position.copy(this.cutPos);
      this.look.lerp(eye.setY(ground + spec.height * 0.55), this.snap ? 1 : damp(9, dt));
      cam.lookAt(this.look);
      // Zoom so the car keeps roughly the same size as it comes past.
      const want = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(7.5 / Math.max(6, distance))), 14, 58);
      fov = this.snap ? want : lerp(this.fov, want, damp(4, dt));
    } else {
      const target = new THREE.Vector3(car.position.x, ground + spec.height * 0.6, car.position.z);
      const c = Math.cos(this.orbitPitch);
      const yaw = heading + Math.PI + this.orbitYaw;
      const want = new THREE.Vector3(Math.sin(yaw) * c, Math.sin(this.orbitPitch), Math.cos(yaw) * c).multiplyScalar(this.orbitDistance).add(target);
      want.y = Math.max(want.y, ground + 0.4);
      cam.position.copy(want);
      cam.lookAt(target);
      fov = 50;
    }

    this.snap = false;
    this.fov = fov;
    if (cam.fov !== fov || cam.near !== near) {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    // Refitting the shadow cascades is not free, so only do it once the lens has really moved.
    if (Math.abs(fov - this.fitFov) > 1.5 || near !== this.fitNear) {
      this.fitFov = fov;
      this.fitNear = near;
      this.onLensChange();
    }
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.onLensChange();
  }
}

function rand(n: number) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
