export type QualityName = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_NAMES: QualityName[] = ['low', 'medium', 'high', 'ultra'];

export interface Quality {
  name: QualityName;
  /** starting render scale against the screen; the frame-rate governor moves it between min and max */
  pixelRatio: number;
  minPixelRatio: number;
  maxPixelRatio: number;
  shadowCascades: number;
  shadowMapSize: number;
  shadowFar: number;
  ambientOcclusion: boolean;
  bloom: boolean;
  msaa: number;
  treeDensity: number;
  anisotropy: number;
  /** real lights taken from the street lamps nearest the car; every light costs on every pixel */
  lampLights: number;
  headlightShadow: boolean;
  /** metres from the car within which scenery is drawn; map cells are loaded a little beyond it */
  drawDistance: number;
  /** metres within which close-up detail is drawn: leaf sprays, street furniture, signals */
  detailDistance: number;
  /** cars driving themselves round the streets near the player */
  traffic: number;
  /** people walking the pavements near the player; each is a whole figure, so they cost more than cars */
  pedestrians: number;
  /** haze thick enough that scenery has faded into the sky by the draw distance, so nothing pops in */
  fog: number;
}

// Each step up costs roughly twice the one below. Ambient occlusion and the headlight shadow each draw the
// whole scene again, so they are kept for the top presets.
const PRESETS: Record<QualityName, Quality> = {
  low: {
    name: 'low', pixelRatio: 0.75, minPixelRatio: 0.5, maxPixelRatio: 1, shadowCascades: 1, shadowMapSize: 1024, shadowFar: 70,
    ambientOcclusion: false, bloom: false, msaa: 0, treeDensity: 0.35, anisotropy: 2, lampLights: 2, headlightShadow: false, drawDistance: 240, detailDistance: 90, traffic: 22, pedestrians: 14, fog: 0.005,
  },
  medium: {
    name: 'medium', pixelRatio: 1, minPixelRatio: 0.6, maxPixelRatio: 1.25, shadowCascades: 1, shadowMapSize: 2048, shadowFar: 120,
    ambientOcclusion: false, bloom: true, msaa: 0, treeDensity: 0.6, anisotropy: 4, lampLights: 4, headlightShadow: false, drawDistance: 320, detailDistance: 140, traffic: 32, pedestrians: 26, fog: 0.0037,
  },
  high: {
    name: 'high', pixelRatio: 1.25, minPixelRatio: 0.75, maxPixelRatio: 1.5, shadowCascades: 2, shadowMapSize: 2048, shadowFar: 200,
    ambientOcclusion: false, bloom: true, msaa: 4, treeDensity: 0.85, anisotropy: 8, lampLights: 6, headlightShadow: false, drawDistance: 420, detailDistance: 220, traffic: 44, pedestrians: 40, fog: 0.0029,
  },
  ultra: {
    name: 'ultra', pixelRatio: 2, minPixelRatio: 1, maxPixelRatio: 2, shadowCascades: 3, shadowMapSize: 2048, shadowFar: 320,
    ambientOcclusion: true, bloom: true, msaa: 4, treeDensity: 1, anisotropy: 16, lampLights: 12, headlightShadow: true, drawDistance: 600, detailDistance: 350, traffic: 64, pedestrians: 60, fog: 0.002,
  },
};

export const query = new URLSearchParams(location.search);

const STORE_KEY = 'delhi-drive:quality';
const isName = (q: string | null): q is QualityName => !!q && (QUALITY_NAMES as string[]).includes(q);

export interface Gpu {
  /** the graphics card as the browser names it, or '' when it will not say */
  name: string;
  /** software: no graphics card at all, the processor is drawing. integrated: the small one built into the processor. */
  kind: 'software' | 'integrated' | 'dedicated' | 'unknown';
}

/**
 * Which graphics card the browser has given this page. A page can ask for the fast one (the renderer does) but
 * the browser and the operating system decide: on a laptop with two, Windows hands browsers the slow one unless told otherwise.
 */
export function detectGpu(): Gpu {
  let name = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // no WebGL: nothing to go on
  }
  // "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A68) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "Intel(R) UHD Graphics"
  const angle = /^ANGLE \([^,]*, (.+?)(?: \(0x[0-9a-f]+\))?(?: Direct3D.*| OpenGL.*|, [^,]*)?\)$/i.exec(name);
  if (angle) name = angle[1];
  const kind = !name ? 'unknown'
    : /swiftshader|llvmpipe|software|basic render|warp/i.test(name) ? 'software'
    : /intel(?!.*\barc\b)|radeon\(tm\) graphics|radeon (r\d|hd|vega)|adreno|mali|powervr/i.test(name) ? 'integrated'
    : 'dedicated';
  return { name, kind };
}

/** The preset to start from when nobody has chosen one: light on phones and small machines, high on big ones. */
function autoQuality(gpu: Gpu): QualityName {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const touch = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 8;
  // the graphics card decides far more than the processor: a twelve-core laptop on its built-in graphics is a small machine
  if (touch || memory <= 4 || cores <= 4 || gpu.kind === 'software' || gpu.kind === 'integrated') return 'low';
  // high (4x MSAA, two shadow cascades) only on big machines; 8-core laptops lagged on it
  if (!('gpu' in navigator) || cores <= 8) return 'medium';
  return 'high';
}

/** What the menu's quality picker saved; 'auto' or missing means let the device decide. */
export function savedQuality(): QualityName | 'auto' {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return isName(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveQuality(q: QualityName | 'auto') {
  try {
    if (q === 'auto') localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, q);
  } catch {
    // storage blocked: the choice lasts until the page is reloaded
  }
}

/**
 * ?q=low|medium|high|ultra beats the menu's saved choice, which beats the automatic pick.
 * ?cascades=, ?ao=, ?bloom=, ?msaa=, ?lamps=, ?hls=, ?traffic= and ?peds= override single settings for comparisons.
 */
export function pickQuality(gpu: Gpu): Quality {
  const q = query.get('q');
  const saved = savedQuality();
  const quality = { ...PRESETS[isName(q) ? q : saved !== 'auto' ? saved : autoQuality(gpu)] };
  if (query.has('cascades')) quality.shadowCascades = Number(query.get('cascades'));
  if (query.has('ao')) quality.ambientOcclusion = query.get('ao') !== '0';
  if (query.has('bloom')) quality.bloom = query.get('bloom') !== '0';
  if (query.has('msaa')) quality.msaa = Number(query.get('msaa'));
  if (query.has('lamps')) quality.lampLights = Number(query.get('lamps'));
  if (query.has('traffic')) quality.traffic = Number(query.get('traffic'));
  if (query.has('peds')) quality.pedestrians = Number(query.get('peds'));
  if (query.has('hls')) quality.headlightShadow = query.get('hls') !== '0';
  return quality;
}
