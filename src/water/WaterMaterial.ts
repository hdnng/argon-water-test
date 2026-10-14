import * as THREE from 'three';
import waterVert from '../shaders/water.vert.glsl';
import waterFrag from '../shaders/water.frag.glsl';
import { QualityConfig } from '../utils/QualityPresets';

export interface WaterMaterialParams {
  flowTexture: THREE.Texture;
  terrainTexture: THREE.Texture;
  noiseTexture: THREE.Texture;
  rippleTexture: THREE.Texture;
  refractionColorTexture: THREE.Texture;
  refractionDepthTexture: THREE.Texture;
  envMap: THREE.CubeTexture;
  sunDirection: THREE.Vector3;
  rippleDrops: THREE.Vector4[];
  quality: QualityConfig;
}

export class WaterMaterial extends THREE.ShaderMaterial {
  constructor(params: WaterMaterialParams) {
    super({
      vertexShader: waterVert,
      fragmentShader: waterFrag,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: params.sunDirection.clone().normalize() },
        uCameraPos: { value: new THREE.Vector3() },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 120.0 },

        uFlowMap: { value: params.flowTexture },
        uTerrainMap: { value: params.terrainTexture },
        uNoiseTex: { value: params.noiseTexture },
        uRippleMap: { value: params.rippleTexture },
        tRefractionColor: { value: params.refractionColorTexture },
        tRefractionDepth: { value: params.refractionDepthTexture },
        tEnvMap: { value: params.envMap },

        uRippleDrops: { value: params.rippleDrops },
        uActiveRippleCount: { value: 0 },
        uWaveOctaves: { value: params.quality.waveOctaves },
        uFoamOctaves: { value: params.quality.foamOctaves },
        uReflectionsEnabled: { value: params.quality.toggles.reflections ? 1.0 : 0.0 },
        uRefractionEnabled: { value: params.quality.toggles.refraction ? 1.0 : 0.0 },
        uFoamEnabled: { value: params.quality.toggles.foam ? 1.0 : 0.0 },
        uPointerEnabled: { value: params.quality.toggles.pointerInteraction ? 1.0 : 0.0 }
      },
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide
    });
  }

  public updateFrame(
    elapsedTime: number,
    camera: THREE.PerspectiveCamera,
    rippleTexture: THREE.Texture,
    activeRippleCount: number
  ): void {
    this.uniforms.uTime.value = elapsedTime;
    this.uniforms.uCameraPos.value.copy(camera.position);
    this.uniforms.uCameraNear.value = camera.near;
    this.uniforms.uCameraFar.value = camera.far;
    this.uniforms.uRippleMap.value = rippleTexture;
    this.uniforms.uActiveRippleCount.value = activeRippleCount;
  }

  public applyQuality(quality: QualityConfig): void {
    this.uniforms.uWaveOctaves.value = quality.waveOctaves;
    this.uniforms.uFoamOctaves.value = quality.foamOctaves;
    this.uniforms.uReflectionsEnabled.value = quality.toggles.reflections ? 1.0 : 0.0;
    this.uniforms.uRefractionEnabled.value = quality.toggles.refraction ? 1.0 : 0.0;
    this.uniforms.uFoamEnabled.value = quality.toggles.foam ? 1.0 : 0.0;
    this.uniforms.uPointerEnabled.value = quality.toggles.pointerInteraction ? 1.0 : 0.0;
  }
}
