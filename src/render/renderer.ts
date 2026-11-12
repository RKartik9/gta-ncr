import * as THREE from 'three/webgpu';
import { builtinAOContext, mrt, normalView, packNormalToRGB, pass, renderOutput, sample, screenUV, unpackRGBToNormal } from 'three/tsl';
import { ssao } from 'three/addons/tsl/display/SSAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { Quality } from '../config.ts';

export async function createRenderer(canvas: HTMLCanvasElement, quality: Quality, forceWebGL: boolean) {
  // WebGPU where the browser has it, WebGL 2 otherwise: same scene, same materials.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL, powerPreference: 'high-performance' });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

/**
 * Keeps the frame rate up on any machine by trading sharpness for speed: when frames run slow the picture is
 * rendered at a lower resolution, and it creeps back up when there is headroom. Call once a frame.
 */
export function resolutionGovernor(renderer: THREE.WebGPURenderer, quality: Quality) {
  const top = Math.min(window.devicePixelRatio, quality.maxPixelRatio);
  const floor = Math.min(top, quality.minPixelRatio);
  let ratio = renderer.getPixelRatio();
  let avg = 1 / 60, timer = 0, holdUp = 0;
  return (dt: number) => {
    avg += (dt - avg) * 0.05;
    timer += dt;
    holdUp -= dt;
    if (timer < 1.5) return;
    timer = 0;
    let next = ratio;
    if (avg > 1 / 45) {
      next = Math.max(floor, ratio * 0.85);
      holdUp = 10; // after a drop, wait a while before trying higher again, or it see-saws
    } else if (avg < 1 / 56 && holdUp <= 0) next = Math.min(top, ratio * 1.08);
    if (Math.abs(next - ratio) > 0.01) {
      ratio = next;
      renderer.setPixelRatio(ratio);
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
  // No MSAA on low: FXAA smooths the edges for almost nothing.
  pipeline.outputNode = quality.msaa ? lit : fxaa(renderOutput(lit));
  if (!quality.msaa) pipeline.outputColorTransform = false;
  return {
    pipeline,
    /** night: 0 by day, 1 at night. Lamps and windows bloom at night without blowing out the daytime sun on glass. */
    setNight(night: number) {
      if (!glow) return;
      glow.threshold.value = 2.2 - 1.4 * night;
      glow.strength.value = 0.07 + 0.18 * night;
    },
  };
}
