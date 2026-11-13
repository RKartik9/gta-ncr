import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { pmremTexture } from 'three/tsl';

// A clear blue day with a light haze at the horizon, a warm dusk, and a blue-black night lit by sodium lamps.
const SUN_PEAK = 52; // degrees above the horizon at noon
const HAZE = new THREE.Color(0xb4c6d8); // the horizon's own blue, so distance reads as air rather than smog
const DUSK = new THREE.Color(0x9a7f6c);
const NIGHT = new THREE.Color(0x141a24);
const SUN_LOW = new THREE.Color(0xff9a5a);
const SUN_HIGH = new THREE.Color(0xffe2bd);
const MOON = new THREE.Color(0x9db4ff);

/** Sun direction for an hour of the day: east at 6, south at noon, west at 18, under the ground at night. */
export function sunAt(hour: number, out = new THREE.Vector3()) {
  const t = (hour - 6) / 12;
  const elevation = SUN_PEAK * Math.sin(t * Math.PI);
  const azimuth = 90 + t * 180;
  return { elevation, dir: out.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth)) };
}

function makeSky(showSun: boolean) {
  const sky = new SkyMesh();
  sky.scale.setScalar(10000);
  sky.turbidity.value = 3.5;
  sky.rayleigh.value = 1.8;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.82;
  sky.cloudCoverage.value = 0.28;
  sky.cloudDensity.value = 0.35;
  sky.cloudElevation.value = 0.55;
  sky.showSunDisc.value = showSun ? 1 : 0;
  return sky;
}

function makeStars() {
  const n = 2400;
  const pos = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    do v.set(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1);
    while (v.lengthSq() > 1 || v.y < 0.04);
    v.normalize().multiplyScalar(5000);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const stars = new THREE.Points(g, m);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  return stars;
}

const nightHooks: ((night: number) => void)[] = [];
let currentNight = 0;
/** Anything that glows at night (windows, lamps, signs) registers here; called with 0 by day, 1 at full night. */
export function onNight(fn: (night: number) => void) {
  nightHooks.push(fn);
  fn(currentNight);
}

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);

export class DayNight {
  hour: number;
  /** game hours per real second: one hour a minute */
  speed: number;
  running = true;
  night = 0;
  readonly sun: THREE.DirectionalLight;
  /** where the shadow-casting light (sun or moon) shines from; shadows read it */
  readonly lightDir = new THREE.Vector3();
  private sky: SkyMesh;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.FogExp2;
  private stars: THREE.Points;
  private envs: THREE.Texture[];
  /** lighting environment as a shader input whose texture is swapped in place; see update() */
  private env: ReturnType<typeof pmremTexture>;
  private scene: THREE.Scene;
  private renderer: THREE.WebGPURenderer;
  private lastNight = -1;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer, hour: number, speed: number, fogDensity = 0.00115) {
    this.scene = scene;
    this.renderer = renderer;
    this.hour = hour;
    this.speed = speed;
    this.sky = makeSky(true);
    this.stars = makeStars();
    scene.add(this.sky, this.stars);

    // Three lighting environments made once (day, dusk, night) rather than re-rendering the sky every frame.
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envs = [12, 18.4, 0].map((h) => {
      const envScene = new THREE.Scene();
      const sky = makeSky(false);
      sky.sunPosition.value.copy(sunAt(h).dir);
      envScene.add(sky);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ color: h === 0 ? 0x0c0d10 : 0x5c574d }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -2;
      envScene.add(floor);
      return pmrem.fromScene(envScene, 0, 1, 20000).texture;
    });
    pmrem.dispose();
    this.env = pmremTexture(this.envs[0]);
    scene.environmentNode = this.env;

    this.fog = new THREE.FogExp2(HAZE.getHex(), fogDensity);
    scene.fog = this.fog;
    this.hemi = new THREE.HemisphereLight(0xcfe0f5, 0x7a6f5c, 0.5);
    this.sun = new THREE.DirectionalLight(0xffe2bd, 4.6);
    scene.add(this.hemi, this.sun, this.sun.target);
    this.update(0);
  }

  /** N: jump between midday and late night. */
  toggle() {
    this.hour = this.night > 0.5 ? 12 : 22;
  }

  update(dt: number) {
    if (this.running) this.hour = (this.hour + dt * this.speed) % 24;
    const { elevation, dir } = sunAt(this.hour);
    this.sky.sunPosition.value.copy(dir);

    const day = smooth(-5, 8, elevation);
    this.night = 1 - day;
    const n = this.night;

    // One shadow-casting light: the sun by day, the moon by night, swapped while both are near zero.
    if (elevation > -3) {
      this.lightDir.copy(dir);
      this.sun.intensity = 3.6 * smooth(-3, 10, elevation);
      this.sun.color.copy(SUN_LOW).lerp(SUN_HIGH, smooth(4, 30, elevation));
    } else {
      sunAt(this.hour + 12, this.lightDir);
      if (this.lightDir.y < 0.45) this.lightDir.setY(0.45).normalize();
      this.sun.intensity = 0.45 * smooth(-3, -12, elevation);
      this.sun.color.copy(MOON);
    }
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.lightDir, 400);

    const dusk = 1 - Math.abs(smooth(-8, 14, elevation) * 2 - 1);
    this.fog.color.copy(HAZE).lerp(NIGHT, n).lerp(DUSK, dusk * 0.6);
    // sky fill: enough that shaded walls keep their colour by day, a dim moonlit blue by night
    this.hemi.intensity = 0.55 - 0.4 * n;
    this.hemi.color.setHex(0xcfd8e6).lerp(MOON, n);
    // Swapping scene.environment rebuilt every material's shader (half a second frozen at each dusk and dawn);
    // changing the texture behind one environment node is just a new binding.
    const env = this.envs[elevation > 12 ? 0 : elevation > -6 ? 1 : 2];
    if (this.env.value !== env) this.env.value = env;
    this.scene.environmentIntensity = 0.35 - 0.1 * n;
    this.renderer.toneMappingExposure = 1 + 0.6 * n;
    (this.stars.material as THREE.PointsMaterial).opacity = smooth(0.6, 1, n);

    if (Math.abs(n - this.lastNight) > 0.002) {
      this.lastNight = currentNight = n;
      for (const fn of nightHooks) fn(n);
    }
  }
}
