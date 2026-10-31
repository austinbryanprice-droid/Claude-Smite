export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export type AntiAliasing = 'none' | 'fxaa' | 'smaa' | 'traa';

/** Everything the renderer and scene read to scale cost up or down. */
export interface QualitySettings {
  name: QualityName;
  label: string;
  /** Multiplier on devicePixelRatio, then clamped by `maxPixelRatio`. */
  resolutionScale: number;
  maxPixelRatio: number;
  antiAliasing: AntiAliasing;
  /** Ground-truth ambient occlusion (needs a depth/normal pre-pass). */
  ao: boolean;
  aoResolution: number;
  aoSamples: number;
  bloom: boolean;
  shadowMapSize: number;
  shadowCascades: number;
  shadowDistance: number;
  /** Multiplier on base grass density (blades per square meter). */
  grassDensity: number;
  /** Radius around the camera where full-density grass is drawn. */
  grassDistance: number;
  grassShadows: boolean;
  /** Number of point lights from braziers that are allowed to be active. */
  maxDynamicLights: number;
  particles: number;
}

export const QUALITY_PRESETS: Record<QualityName, QualitySettings> = {
  low: {
    name: 'low',
    label: 'Low',
    resolutionScale: 0.75,
    maxPixelRatio: 1,
    antiAliasing: 'fxaa',
    ao: false,
    aoResolution: 0.5,
    aoSamples: 8,
    bloom: true,
    shadowMapSize: 1024,
    shadowCascades: 2,
    shadowDistance: 60,
    grassDensity: 0.3,
    grassDistance: 35,
    grassShadows: false,
    maxDynamicLights: 2,
    particles: 0.3,
  },
  medium: {
    name: 'medium',
    label: 'Medium',
    resolutionScale: 1,
    maxPixelRatio: 1,
    antiAliasing: 'smaa',
    ao: false,
    aoResolution: 0.5,
    aoSamples: 8,
    bloom: true,
    shadowMapSize: 2048,
    shadowCascades: 3,
    shadowDistance: 90,
    grassDensity: 0.6,
    grassDistance: 50,
    grassShadows: false,
    maxDynamicLights: 4,
    particles: 0.6,
  },
  high: {
    name: 'high',
    label: 'High',
    resolutionScale: 1,
    maxPixelRatio: 1.5,
    antiAliasing: 'traa',
    ao: true,
    aoResolution: 0.5,
    aoSamples: 12,
    bloom: true,
    shadowMapSize: 2048,
    shadowCascades: 3,
    shadowDistance: 120,
    grassDensity: 1,
    grassDistance: 65,
    grassShadows: false,
    maxDynamicLights: 8,
    particles: 1,
  },
  ultra: {
    name: 'ultra',
    label: 'Ultra',
    resolutionScale: 1,
    maxPixelRatio: 2,
    antiAliasing: 'traa',
    ao: true,
    aoResolution: 1,
    aoSamples: 16,
    bloom: true,
    shadowMapSize: 4096,
    shadowCascades: 4,
    shadowDistance: 160,
    grassDensity: 1.6,
    grassDistance: 85,
    grassShadows: true,
    maxDynamicLights: 8,
    particles: 1.5,
  },
};

/** Only a quality the player picked is saved, never the startup guess. */
const STORAGE_KEY = 'smite.quality.picked';
/**
 * Older builds saved the startup guess too, so one session on the WebGL 2
 * fallback left the game on Medium for good. Only Ultra, which the guess never
 * makes, is certainly a pick there.
 */
const LEGACY_KEY = 'smite.quality';

/**
 * URL `?quality=` wins, then the saved choice, then a guess from the hardware.
 * `slowGpu`: the browser draws on integrated graphics or in software.
 */
export function initialQuality(isWebGPU: boolean, slowGpu = false): QualityName {
  const fromUrl = new URLSearchParams(location.search).get('quality');
  if (fromUrl && fromUrl in QUALITY_PRESETS) return fromUrl as QualityName;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in QUALITY_PRESETS) return saved as QualityName;
    if (localStorage.getItem(LEGACY_KEY) === 'ultra') return 'ultra';
  } catch {
    /* storage unavailable */
  }
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  if (mobile || slowGpu) return 'low';
  if (!isWebGPU) return 'medium';
  return cores >= 8 ? 'high' : 'medium';
}

export function saveQuality(name: QualityName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* storage unavailable */
  }
}
