import * as THREE from 'three/webgpu';
import { builtinAOContext, float, luminance, mix, mrt, normalView, packNormalToRGB, pass, renderOutput, sample, saturation, screenUV, smoothstep, uniform, unpackRGBToNormal, vec3, vec4 } from 'three/tsl';
import { ssao } from 'three/addons/tsl/display/SSAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import type { Quality } from '../config.ts';

export async function createRenderer(canvas: HTMLCanvasElement, quality: Quality, forceWebGL: boolean) {
  // WebGPU where the browser has it, WebGL 2 otherwise: same scene, same materials.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL, powerPreference: 'high-performance' });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  // ACES gives the shoulder and mid-tone punch; the grade in createPipeline() puts back the saturation it eats.
  // (Neutral kept colours true but flat; AgX washed the city out to grey.) DayNight sets the exposure.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Forward+ on WebGPU: plain point lights (headlight pools, far lamps) cost only where they reach, so there can be
  // dozens. Spots and the sun are lit as before. WebGL has no compute for it.
  if (!forceWebGL && backendName(renderer) === 'WebGPU') renderer.lighting = new ClusteredLighting(256, 32, 24, 32);
  compileInBackground(renderer);
  return renderer;
}

/**
 * The first time anything is drawn in a new way (a cell's walls, a car, a figure, any of them in the shadow pass)
 * the graphics driver compiles a pipeline for it, and three.js waits for that on the spot: the whole game froze for
 * a second or more each time, far longer on Windows, where every shader is compiled again for Direct3D. Here every
 * draw asks for its pipeline the way `compileAsync` does: the driver compiles it in the background and three.js
 * leaves that one object out of the picture until it is ready, a frame or two later.
 * ponytail: reaches into three.js internals (`_pipelines`, r186); recheck on a three.js upgrade.
 */
function compileInBackground(renderer: THREE.WebGPURenderer) {
  const pipelines = (renderer as unknown as { _pipelines: { getForRender(o: unknown, promises: Promise<void>[] | null): unknown; updateForRender(o: unknown): void } })._pipelines;
  // three.js only needs somewhere to put the promises; nobody waits on them
  const ignored: Promise<void>[] = [];
  pipelines.updateForRender = (renderObject) => {
    pipelines.getForRender(renderObject, ignored);
    ignored.length = 0;
  };
}

/**
 * Keeps the frame rate up on a slow graphics card by trading sharpness for speed: when the card cannot keep up the
 * picture is rendered at a lower resolution, and it goes back up when there is headroom. Call once a frame with
 * the seconds since the last one and the milliseconds this page's own code took.
 * Every change of resolution rebuilds every render target (MSAA, bloom, shadows), which flashes the screen and
 * stalls a frame: so it changes rarely, in big steps, never above the preset, and never when the processor is
 * what is slow (a smaller picture does nothing for that but blur it).
 */
export function resolutionGovernor(renderer: THREE.WebGPURenderer, quality: Quality) {
  const top = Math.min(window.devicePixelRatio, quality.pixelRatio);
  const floor = Math.min(top, quality.minPixelRatio);
  let ratio = renderer.getPixelRatio();
  let avg = 1 / 60, cpu = 0, timer = 0, hold = 5;
  return (dt: number, cpuMs: number) => {
    avg += (dt - avg) * 0.05;
    cpu += (cpuMs / 1000 - cpu) * 0.05;
    timer += dt;
    hold -= dt;
    if (timer < 2 || hold > 0) return;
    timer = 0;
    // the graphics card is the bottleneck when the frame takes well over what the page's code does
    const gpuBound = avg - cpu > 1 / 120;
    let next = ratio;
    if (avg > 1 / 50 && gpuBound) next = Math.max(floor, ratio - 0.25);
    else if (avg < 1 / 58) next = Math.min(top, ratio + 0.25);
    if (Math.abs(next - ratio) > 0.01) {
      ratio = next;
      renderer.setPixelRatio(ratio);
      hold = 20; // a while at the new size before it is judged again, so it never see-saws
    }
  };
}

export function backendName(renderer: THREE.WebGPURenderer) {
  return (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
}

/** Sun shadows. Cascades keep them crisp under the car and still present down the street. */
/** `lightDir` is where the light shines from; it moves with the time of day. */
export function setupShadows(sun: THREE.DirectionalLight, lightDir: THREE.Vector3, quality: Quality) {
  if (quality.shadowCascades < 1) return { follow: (_target: THREE.Vector3) => {}, refit: () => {} };
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  const c = sun.shadow.camera;
  c.near = 1;
  c.far = 1200;
  if (quality.shadowCascades > 1) {
    const csm = new CSMShadowNode(sun, { cascades: quality.shadowCascades, maxFar: quality.shadowFar, mode: 'practical', lightMargin: 250 });
    // The node picks up the camera itself on first use; setting it here would skip its own set-up.
    sun.shadow.shadowNode = csm;
    return {
      follow: (_target: THREE.Vector3) => {},
      // the cascades are only built on the first render; before that there is nothing to refit
      refit: () => {
        if (csm.mainFrustum) csm.updateFrustums();
      },
    };
  }
  const half = quality.shadowFar / 2;
  c.left = c.bottom = -half;
  c.right = c.top = half;
  c.updateProjectionMatrix();
  return {
    // one shadow map, kept centred on the car
    follow: (target: THREE.Vector3) => {
      sun.target.position.copy(target);
      sun.position.copy(target).addScaledVector(lightDir, 400);
    },
    refit: () => {},
  };
}

export function createPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, quality: Quality) {
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: quality.msaa });

  if (quality.ambientOcclusion) {
    // Depth and normals first, so contact shadows can darken only the ambient light.
    const prePass = pass(scene, camera);
    prePass.transparent = false;
    prePass.setMRT(mrt({ output: packNormalToRGB(normalView) }));
    prePass.getTexture('output').type = THREE.UnsignedByteType;
    const normals = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
    const aoPass = ssao(prePass.getTextureNode('depth'), normals, camera);
    aoPass.radius.value = 1.4;
    aoPass.intensity.value = 1.6;
    aoPass.resolutionScale = 0.5;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
  }

  const colour = scenePass.getTextureNode('output');
  // Bloom only on what is genuinely bright: the sun on chrome and glass, lamps, brake lights.
  const glow = quality.bloom ? bloom(colour, 0.07, 0.4, 2.2) : null;
  const lit = glow ? colour.add(glow) : colour;
  // Tone map and encode first, then grade on what the eye sees (after mrdoob's slop-newyork, MIT).
  const look = { contrast: uniform(0.22), saturation: uniform(1.08), warmth: uniform(1) };
  const graded = grade(renderOutput(lit), look);
  // No MSAA on low: FXAA smooths the edges for almost nothing.
  pipeline.outputNode = quality.msaa ? graded : fxaa(graded);
  pipeline.outputColorTransform = false;
  return {
    pipeline,
    /** night: 0 by day, 1 at night. Lamps and windows bloom at night without blowing out the daytime sun on glass. */
    setNight(night: number) {
      // nights a touch flatter and cooler, so lamps carry the colour rather than the grade
      look.contrast.value = 0.22 - 0.02 * night;
      look.warmth.value = 1 - night;
      if (!glow) return;
      glow.threshold.value = 2.2 - 1.4 * night;
      glow.strength.value = 0.07 + 0.18 * night;
    },
  };
}

/**
 * The colour grade, on display-encoded colour: cool shadows and warm highlights, a soft S-curve for contrast that
 * never clips, saturation plus vibrance (which lifts dull colours more than vivid ones), and a light vignette.
 */
function grade(input: ReturnType<typeof renderOutput>, look: { contrast: UniformNumber; saturation: UniformNumber; warmth: UniformNumber }) {
  const c = input.rgb;
  const l = luminance(c);
  // by day only a breath of warmth in the highlights: the sun is already warm, and more turned noon into evening
  const cool = vec3(0.985, 1, 1.02), warm = vec3(1.02, 1.003, 0.98);
  const split = mix(cool, mix(vec3(1), warm, look.warmth), smoothstep(0.2, 0.8, l));
  let o = c.mul(split).clamp(0, 1);
  o = mix(o, smoothstep(0, 1, o), look.contrast);
  o = saturation(o, look.saturation);
  const edge = smoothstep(0.35, 0.95, screenUV.sub(0.5).length().mul(1.4));
  return vec4(o.mul(float(1).sub(edge.mul(0.12))), 1);
}
type UniformNumber = ReturnType<typeof uniform<'float'>>;
