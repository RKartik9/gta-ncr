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
  /** metres from the car within which map cells are loaded */
  viewDistance: number;
  /** thicker haze hides the edge of a shorter view distance */
  fog: number;
}

// Each step up costs roughly twice the one below. Ambient occlusion and the headlight shadow each draw the
// whole scene again, so they are kept for the top presets.
const PRESETS: Record<QualityName, Quality> = {
  low: {
    name: 'low', pixelRatio: 0.75, minPixelRatio: 0.5, maxPixelRatio: 1, shadowCascades: 1, shadowMapSize: 1024, shadowFar: 80,
    ambientOcclusion: false, bloom: false, msaa: 0, treeDensity: 0.35, anisotropy: 2, lampLights: 2, headlightShadow: false, viewDistance: 380, fog: 0.0018,
  },
  medium: {
    name: 'medium', pixelRatio: 1, minPixelRatio: 0.6, maxPixelRatio: 1.25, shadowCascades: 1, shadowMapSize: 2048, shadowFar: 140,
    ambientOcclusion: false, bloom: true, msaa: 0, treeDensity: 0.6, anisotropy: 4, lampLights: 4, headlightShadow: false, viewDistance: 480, fog: 0.0013,
  },
  high: {
    name: 'high', pixelRatio: 1.25, minPixelRatio: 0.75, maxPixelRatio: 1.5, shadowCascades: 2, shadowMapSize: 2048, shadowFar: 220,
    ambientOcclusion: false, bloom: true, msaa: 4, treeDensity: 0.85, anisotropy: 8, lampLights: 6, headlightShadow: false, viewDistance: 600, fog: 0.001,
  },
  ultra: {
    name: 'ultra', pixelRatio: 2, minPixelRatio: 1, maxPixelRatio: 2, shadowCascades: 3, shadowMapSize: 2048, shadowFar: 320,
    ambientOcclusion: true, bloom: true, msaa: 4, treeDensity: 1, anisotropy: 16, lampLights: 12, headlightShadow: true, viewDistance: 650, fog: 0.0009,
  },
};

export const query = new URLSearchParams(location.search);

const STORE_KEY = 'delhi-drive:quality';
const isName = (q: string | null): q is QualityName => !!q && (QUALITY_NAMES as string[]).includes(q);

/** The preset to start from when nobody has chosen one: light on phones and small machines, high on big ones. */
function autoQuality(): QualityName {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const touch = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 8;
  if (touch || memory <= 4 || cores <= 4) return 'low';
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
 * ?cascades=, ?ao=, ?bloom=, ?msaa=, ?lamps= and ?hls= override single settings for comparisons.
 */
export function pickQuality(): Quality {
  const q = query.get('q');
  const saved = savedQuality();
  const quality = { ...PRESETS[isName(q) ? q : saved !== 'auto' ? saved : autoQuality()] };
  if (query.has('cascades')) quality.shadowCascades = Number(query.get('cascades'));
  if (query.has('ao')) quality.ambientOcclusion = query.get('ao') !== '0';
  if (query.has('bloom')) quality.bloom = query.get('bloom') !== '0';
  if (query.has('msaa')) quality.msaa = Number(query.get('msaa'));
  if (query.has('lamps')) quality.lampLights = Number(query.get('lamps'));
  if (query.has('hls')) quality.headlightShadow = query.get('hls') !== '0';
  return quality;
}
