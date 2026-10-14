export type QualityPresetName = 'performance' | 'balanced' | 'ultra';

export interface FeatureToggles {
  reflections: boolean;
  refraction: boolean;
  foam: boolean;
  caustics: boolean;
  waterfallSpray: boolean;
  shadows: boolean;
  postprocessing: boolean;
  pointerInteraction: boolean;
  adaptiveResolution: boolean;
}

export interface QualityConfig {
  name: QualityPresetName;
  label: string;
  pixelRatioMax: number;
  renderScale: number;
  waterSegmentsX: number;
  waterSegmentsZ: number;
  riverbedSegmentsX: number;
  riverbedSegmentsZ: number;
  pebbleCount: number;
  foamParticleCount: number;
  sprayParticleCount: number;
  rippleResolution: number;
  shadowMapSize: number;
  refractionResolutionScale: number;
  waveOctaves: number;
  foamOctaves: number;
  toggles: FeatureToggles;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualityConfig> = {
  performance: {
    name: 'performance',
    label: 'Performance',
    pixelRatioMax: 1.0,
    renderScale: 0.75,
    waterSegmentsX: 96,
    waterSegmentsZ: 144,
    riverbedSegmentsX: 72,
    riverbedSegmentsZ: 108,
    pebbleCount: 650,
    foamParticleCount: 220,
    sprayParticleCount: 120,
    rippleResolution: 128,
    shadowMapSize: 1024,
    refractionResolutionScale: 0.5,
    waveOctaves: 2,
    foamOctaves: 1,
    toggles: {
      reflections: true,
      refraction: true,
      foam: true,
      caustics: false,
      waterfallSpray: false,
      shadows: false,
      postprocessing: false,
      pointerInteraction: true,
      adaptiveResolution: false
    }
  },
  balanced: {
    name: 'balanced',
    label: 'Balanced',
    pixelRatioMax: 1.5,
    renderScale: 1.0,
    waterSegmentsX: 160,
    waterSegmentsZ: 240,
    riverbedSegmentsX: 112,
    riverbedSegmentsZ: 168,
    pebbleCount: 1400,
    foamParticleCount: 480,
    sprayParticleCount: 280,
    rippleResolution: 256,
    shadowMapSize: 1536,
    refractionResolutionScale: 0.75,
    waveOctaves: 3,
    foamOctaves: 2,
    toggles: {
      reflections: true,
      refraction: true,
      foam: true,
      caustics: true,
      waterfallSpray: true,
      shadows: true,
      postprocessing: true,
      pointerInteraction: true,
      adaptiveResolution: false
    }
  },
  ultra: {
    name: 'ultra',
    label: 'Ultra',
    pixelRatioMax: 2.0,
    renderScale: 1.0,
    waterSegmentsX: 240,
    waterSegmentsZ: 360,
    riverbedSegmentsX: 160,
    riverbedSegmentsZ: 240,
    pebbleCount: 2600,
    foamParticleCount: 850,
    sprayParticleCount: 550,
    rippleResolution: 512,
    shadowMapSize: 2048,
    refractionResolutionScale: 1.0,
    waveOctaves: 4,
    foamOctaves: 3,
    toggles: {
      reflections: true,
      refraction: true,
      foam: true,
      caustics: true,
      waterfallSpray: true,
      shadows: true,
      postprocessing: true,
      pointerInteraction: true,
      adaptiveResolution: false
    }
  }
};

export function cloneQualityConfig(preset: QualityPresetName): QualityConfig {
  const base = QUALITY_PRESETS[preset];
  return {
    ...base,
    toggles: { ...base.toggles }
  };
}
