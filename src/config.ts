export type QualityName = 'low' | 'medium' | 'high';

export interface Quality {
  name: QualityName;
  maxPixelRatio: number;
  shadowCascades: number;
  shadowMapSize: number;
  shadowFar: number;
  ambientOcclusion: boolean;
  bloom: boolean;
  msaa: number;
  treeDensity: number;
  anisotropy: number;
  /** real lights taken from the street lamps nearest the car */
  lampLights: number;
  headlightShadow: boolean;
}

const PRESETS: Record<QualityName, Quality> = {
  low: { name: 'low', maxPixelRatio: 1, shadowCascades: 1, shadowMapSize: 1024, shadowFar: 90, ambientOcclusion: false, bloom: false, msaa: 0, treeDensity: 0.4, anisotropy: 2, lampLights: 0, headlightShadow: false },
  medium: { name: 'medium', maxPixelRatio: 1.25, shadowCascades: 2, shadowMapSize: 2048, shadowFar: 180, ambientOcclusion: true, bloom: true, msaa: 4, treeDensity: 0.7, anisotropy: 8, lampLights: 6, headlightShadow: false },
  high: { name: 'high', maxPixelRatio: 2, shadowCascades: 3, shadowMapSize: 2048, shadowFar: 320, ambientOcclusion: true, bloom: true, msaa: 4, treeDensity: 1, anisotropy: 16, lampLights: 12, headlightShadow: true },
};

export const query = new URLSearchParams(location.search);

/** ?q=low|medium|high picks a preset; ?cascades=, ?ao=, ?bloom= and ?msaa= override single settings for comparisons. */
export function pickQuality(): Quality {
  const q = query.get('q');
  const quality = { ...PRESETS[q === 'low' || q === 'medium' || q === 'high' ? q : 'high'] };
  if (query.has('cascades')) quality.shadowCascades = Number(query.get('cascades'));
  if (query.has('ao')) quality.ambientOcclusion = query.get('ao') !== '0';
  if (query.has('bloom')) quality.bloom = query.get('bloom') !== '0';
  if (query.has('msaa')) quality.msaa = Number(query.get('msaa'));
  if (query.has('lamps')) quality.lampLights = Number(query.get('lamps'));
  if (query.has('hls')) quality.headlightShadow = query.get('hls') !== '0';
  return quality;
}
