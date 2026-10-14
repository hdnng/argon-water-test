import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  QualityConfig,
  QualityPresetName,
  FeatureToggles,
  cloneQualityConfig
} from './utils/QualityPresets';
import {
  createSharedNoiseTexture,
  createRockDetailTexture
} from './utils/ProceduralTextures';
import { FlowField, STREAM_DOMAIN } from './water/FlowField';
import { Environment } from './scene/Environment';
import { Lighting } from './scene/Lighting';
import { Riverbed, UnderwaterShaderUniforms } from './scene/Riverbed';
import { Rocks } from './scene/Rocks';
import { RippleSystem } from './water/RippleSystem';
import { WaterMaterial } from './water/WaterMaterial';
import { WaterSurface } from './water/WaterSurface';
import { FoamSystem } from './water/FoamSystem';
import { Waterfall } from './water/Waterfall';
import { PerformanceMonitor } from './ui/PerformanceMonitor';
import { DebugPanel, CameraPresetName } from './ui/DebugPanel';

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const POST_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexelSize;
uniform float uPostEnabled;

vec3 acesToneMap(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 sampleHighlight(vec2 uv) {
  vec3 c = texture2D(tColor, uv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = smoothstep(1.48, 2.85, lum);
  return c * knee;
}

void main() {
  vec3 center = texture2D(tColor, vUv).rgb;

  if (uPostEnabled < 0.5) {
    vec3 softShoulder = center / (vec3(1.0) + max(vec3(0.0), center - vec3(0.58)) * 0.38);
    vec3 mappedFast = acesToneMap(softShoulder * 0.88);
    mappedFast = pow(max(mappedFast, vec3(0.0)), vec3(1.0 / 2.2));
    gl_FragColor = vec4(mappedFast, 1.0);
    return;
  }

  // Fast 5-tap directional FXAA + 5-tap specular highlight bloom
  vec3 n = texture2D(tColor, vUv + vec2(0.0, uTexelSize.y)).rgb;
  vec3 s = texture2D(tColor, vUv - vec2(0.0, uTexelSize.y)).rgb;
  vec3 e = texture2D(tColor, vUv + vec2(uTexelSize.x, 0.0)).rgb;
  vec3 w = texture2D(tColor, vUv - vec2(uTexelSize.x, 0.0)).rgb;

  float lCenter = dot(center, vec3(0.299, 0.587, 0.114));
  float lN = dot(n, vec3(0.299, 0.587, 0.114));
  float lS = dot(s, vec3(0.299, 0.587, 0.114));
  float lE = dot(e, vec3(0.299, 0.587, 0.114));
  float lW = dot(w, vec3(0.299, 0.587, 0.114));

  float lMin = min(lCenter, min(min(lN, lS), min(lE, lW)));
  float lMax = max(lCenter, max(max(lN, lS), max(lE, lW)));
  float contrast = lMax - lMin;

  vec3 baseColor = center;
  if (contrast > max(0.0312, lMax * 0.125)) {
    baseColor = mix(center, (n + s + e + w) * 0.25, 0.35);
  }

  // Compact 5-tap rotated-grid bloom for solar water sparkles only
  vec2 r1 = uTexelSize * 3.0;
  vec3 bloom = sampleHighlight(vUv) * 0.28;
  bloom += sampleHighlight(vUv + vec2(r1.x, r1.y)) * 0.18;
  bloom += sampleHighlight(vUv + vec2(-r1.x, r1.y)) * 0.18;
  bloom += sampleHighlight(vUv + vec2(r1.x, -r1.y)) * 0.18;
  bloom += sampleHighlight(vUv + vec2(-r1.x, -r1.y)) * 0.18;

  vec3 hdrColor = baseColor + bloom * 0.16;
  // Soft highlight roll-off above 0.58 prevents bright whitewater from clipping to flat white
  hdrColor = hdrColor / (vec3(1.0) + max(vec3(0.0), hdrColor - vec3(0.58)) * 0.38);

  vec3 mapped = acesToneMap(hdrColor * 0.88);

  vec2 vigUv = vUv * 2.0 - 1.0;
  float vignette = 1.0 - 0.10 * dot(vigUv, vigUv);
  mapped *= vignette;

  mapped = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));

  gl_FragColor = vec4(mapped, 1.0);
}
`;

interface CameraTransition {
  active: boolean;
  startTime: number;
  duration: number;
  startPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endPos: THREE.Vector3;
  endTarget: THREE.Vector3;
}

class WaterSimulationApp {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private quality: QualityConfig;
  private readonly noiseTexture: THREE.DataTexture;
  private readonly rockDetailTexture: THREE.DataTexture;
  private readonly flowField: FlowField;
  private readonly environment: Environment;
  private readonly lighting: Lighting;
  private readonly riverbed: Riverbed;
  private readonly rocks: Rocks;
  private readonly rippleSystem: RippleSystem;
  private readonly waterMaterial: WaterMaterial;
  private readonly waterSurface: WaterSurface;
  private readonly foamSystem: FoamSystem;
  private readonly waterfall: Waterfall;

  private readonly sharedUnderwaterUniforms: UnderwaterShaderUniforms;

  // Offscreen Render Targets
  private refractionTarget!: THREE.WebGLRenderTarget;
  private postTarget!: THREE.WebGLRenderTarget;
  private postScene!: THREE.Scene;
  private postCamera!: THREE.OrthographicCamera;
  private postMaterial!: THREE.ShaderMaterial;

  // UI & Telemetry
  private readonly perfMonitor: PerformanceMonitor;
  private readonly debugPanel: DebugPanel;

  // Timing, Adaptive Resolution & Interaction State
  private elapsedTime = 0;
  private lastTimestamp = performance.now();
  private paused = false;
  private activeWidth = window.innerWidth;
  private activeHeight = window.innerHeight;
  private activeDpr = 1.0;
  private adaptiveScale = 1.0;
  private lastAdaptiveCheckTime = 0;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNDC = new THREE.Vector2();
  private pointerDownPos = new THREE.Vector2();
  private lastDragDropTime = 0;

  private camTransition: CameraTransition = {
    active: false,
    startTime: 0,
    duration: 1.1,
    startPos: new THREE.Vector3(),
    startTarget: new THREE.Vector3(),
    endPos: new THREE.Vector3(),
    endTarget: new THREE.Vector3()
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.quality = cloneQualityConfig('balanced');

    this.renderer = new THREE.WebGLRenderer({
      powerPreference: 'high-performance',
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true
    });
    this.renderer.shadowMap.enabled = this.quality.toggles.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Static scene shadow optimization: do not re-render static boulder shadow map twice every frame!
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.info.autoReset = false;

    const hasFloatLinear = Boolean(this.renderer.extensions.get('OES_texture_float_linear'));

    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x9ab3c7, 0.016);

    this.camera = new THREE.PerspectiveCamera(
      46,
      window.innerWidth / window.innerHeight,
      0.12,
      120.0
    );
    this.camera.position.set(1.95, 0.96, 5.15);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(-0.15, 0.14, -0.85);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.maxPolarAngle = Math.PI * 0.475;
    this.controls.minPolarAngle = 0.08;
    this.controls.minDistance = 0.42;
    this.controls.maxDistance = 15.5;
    this.controls.update();

    // 1. Precomputed 512x512 Mipmapped Procedural Wave/Foam/Caustics & PBR Rock Detail Textures + Flow Field
    this.noiseTexture = createSharedNoiseTexture(512);
    this.rockDetailTexture = createRockDetailTexture(512);
    this.flowField = new FlowField(256);
    if (!hasFloatLinear) {
      this.flowField.flowTexture.magFilter = THREE.NearestFilter;
      this.flowField.flowTexture.minFilter = THREE.NearestFilter;
      this.flowField.terrainTexture.magFilter = THREE.NearestFilter;
      this.flowField.terrainTexture.minFilter = THREE.NearestFilter;
    }

    // 2. Lighting & Procedural Mountain Valley Environment
    this.lighting = new Lighting(
      this.quality.shadowMapSize,
      this.quality.toggles.shadows
    );
    this.scene.add(this.lighting.group);

    this.environment = new Environment(this.renderer, this.lighting.sunDirection);
    this.scene.add(this.environment.skyMesh);
    this.scene.environment = this.environment.envMap;

    // 3. Shared Underwater Uniforms
    this.sharedUnderwaterUniforms = {
      uTime: { value: 0 },
      uCausticsEnabled: { value: this.quality.toggles.caustics ? 1.0 : 0.0 },
      uSunDir: { value: this.lighting.sunDirection },
      uFlowMap: { value: this.flowField.flowTexture },
      uTerrainMap: { value: this.flowField.terrainTexture },
      uNoiseTex: { value: this.noiseTexture },
      uRockDetailTex: { value: this.rockDetailTexture }
    };

    // 4. Riverbed, Welded Smooth Pebbles, and Sculpted Boulders
    this.riverbed = new Riverbed(
      this.flowField,
      this.quality.riverbedSegmentsX,
      this.quality.riverbedSegmentsZ,
      this.quality.pebbleCount,
      this.sharedUnderwaterUniforms,
      this.environment.envMap
    );
    this.scene.add(this.riverbed.group);

    this.rocks = new Rocks(
      this.flowField,
      this.sharedUnderwaterUniforms,
      this.environment.envMap
    );
    this.scene.add(this.rocks.group);

    // 5. Offscreen Render Targets
    this.initRenderTargets();

    // 6. Interactive GPU Ripple System
    this.rippleSystem = new RippleSystem(
      this.renderer,
      this.flowField.flowTexture,
      this.quality.rippleResolution
    );

    // 7. Custom Water Material & Surface Mesh
    this.waterMaterial = new WaterMaterial({
      flowTexture: this.flowField.flowTexture,
      terrainTexture: this.flowField.terrainTexture,
      noiseTexture: this.noiseTexture,
      rippleTexture: this.rippleSystem.texture,
      refractionColorTexture: this.refractionTarget.texture,
      refractionDepthTexture: this.refractionTarget.depthTexture!,
      envMap: this.environment.envMap,
      sunDirection: this.lighting.sunDirection,
      rippleDrops: this.rippleSystem.dropUniformArray,
      quality: this.quality
    });

    this.waterSurface = new WaterSurface(
      this.waterMaterial,
      this.quality.waterSegmentsX,
      this.quality.waterSegmentsZ
    );
    this.scene.add(this.waterSurface.mesh);

    // 8. Dedicated Animated Foam System & Separated Multi-Stream Waterfall
    this.foamSystem = new FoamSystem(
      this.flowField,
      this.lighting.sunDirection,
      this.noiseTexture,
      this.quality.foamParticleCount
    );
    this.scene.add(this.foamSystem.mesh);

    this.waterfall = new Waterfall(
      this.flowField,
      this.lighting.sunDirection,
      this.noiseTexture,
      this.refractionTarget.texture,
      this.environment.envMap,
      this.quality.sprayParticleCount
    );
    this.scene.add(this.waterfall.group);

    // 9. Performance Telemetry HUD & Debug Controls
    this.perfMonitor = new PerformanceMonitor(this.renderer);
    this.debugPanel = new DebugPanel(
      this.quality.name,
      this.quality.toggles,
      {
        onPresetChange: (preset) => this.applyPreset(preset),
        onToggleChange: (key, val) => this.applyFeatureToggle(key, val),
        onCameraPreset: (camPreset) => this.transitionToCameraPreset(camPreset),
        onHudToggle: (visible) => this.perfMonitor.setVisible(visible),
        onPauseToggle: (paused) => {
          this.paused = paused;
        },
        onRunBenchmark: () => this.startReproducibleBenchmark()
      }
    );

    this.updateViewportSize();
    this.bindEvents();
    this.hideLoadingOverlay();
    this.animate();
  }

  private initRenderTargets(): void {
    const refractDepth = new THREE.DepthTexture(256, 256);
    refractDepth.type = THREE.FloatType;
    refractDepth.format = THREE.DepthFormat;
    refractDepth.minFilter = THREE.NearestFilter;
    refractDepth.magFilter = THREE.NearestFilter;

    this.refractionTarget = new THREE.WebGLRenderTarget(256, 256, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: refractDepth
    });

    // Attach matching FloatType DepthTexture to postTarget so WebGL2 gl.blitFramebuffer
    // can copy both COLOR_BUFFER_BIT and DEPTH_BUFFER_BIT in < 0.1ms with zero draw calls!
    const sceneDepth = new THREE.DepthTexture(256, 256);
    sceneDepth.type = THREE.FloatType;
    sceneDepth.format = THREE.DepthFormat;
    sceneDepth.minFilter = THREE.NearestFilter;
    sceneDepth.magFilter = THREE.NearestFilter;

    this.postTarget = new THREE.WebGLRenderTarget(256, 256, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: sceneDepth
    });

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMaterial = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tColor: { value: this.postTarget.texture },
        uTexelSize: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uPostEnabled: { value: this.quality.toggles.postprocessing ? 1.0 : 0.0 }
      },
      depthTest: false,
      depthWrite: false
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial));
  }

  private updateViewportSize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const rawDpr = window.devicePixelRatio || 1.0;
    const effectiveScale = this.quality.renderScale * this.adaptiveScale;
    this.activeDpr = Math.min(rawDpr, this.quality.pixelRatioMax) * effectiveScale;

    this.activeWidth = Math.max(1, Math.floor(width * this.activeDpr));
    this.activeHeight = Math.max(1, Math.floor(height * this.activeDpr));

    this.renderer.setPixelRatio(this.activeDpr);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    const refractW = Math.max(
      64,
      Math.floor(this.activeWidth * this.quality.refractionResolutionScale)
    );
    const refractH = Math.max(
      64,
      Math.floor(this.activeHeight * this.quality.refractionResolutionScale)
    );
    this.refractionTarget.setSize(refractW, refractH);
    this.postTarget.setSize(this.activeWidth, this.activeHeight);

    // Ensure WebGLFramebuffers are instantiated for hardware blitting
    this.renderer.setRenderTarget(this.refractionTarget);
    this.renderer.clear();
    this.renderer.setRenderTarget(this.postTarget);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);

    this.postMaterial.uniforms.uTexelSize.value.set(
      1.0 / this.activeWidth,
      1.0 / this.activeHeight
    );
    this.waterMaterial.uniforms.uResolution.value.set(
      this.activeWidth,
      this.activeHeight
    );
  }

  /**
   * Copies the rendered opaque scene color and hardware depth buffer from postTarget
   * into refractionTarget using native WebGL2 gl.blitFramebuffer (zero draw calls).
   */
  private blitOpaqueToRefraction(): boolean {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const props = (this.renderer as any).properties;
    if (!props) return false;

    const srcProps = props.get(this.postTarget);
    const dstProps = props.get(this.refractionTarget);
    const srcFbo = srcProps?.__webglFramebuffer;
    const dstFbo = dstProps?.__webglFramebuffer;

    if (!srcFbo || !dstFbo) return false;

    const srcW = this.postTarget.width;
    const srcH = this.postTarget.height;
    const dstW = this.refractionTarget.width;
    const dstH = this.refractionTarget.height;

    const state = this.renderer.state as any;
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, srcFbo);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dstFbo);

    gl.blitFramebuffer(
      0,
      0,
      srcW,
      srcH,
      0,
      0,
      dstW,
      dstH,
      gl.COLOR_BUFFER_BIT,
      gl.LINEAR
    );
    gl.blitFramebuffer(
      0,
      0,
      srcW,
      srcH,
      0,
      0,
      dstW,
      dstH,
      gl.DEPTH_BUFFER_BIT,
      gl.NEAREST
    );

    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    this.renderer.setRenderTarget(null);
    return true;
  }

  private applyPreset(presetName: QualityPresetName): void {
    this.quality = cloneQualityConfig(presetName);
    this.adaptiveScale = 1.0;
    this.debugPanel.syncState(this.quality.name, this.quality.toggles);

    this.updateViewportSize();
    this.lighting.updateQuality(
      this.quality.shadowMapSize,
      this.quality.toggles.shadows
    );
    this.renderer.shadowMap.enabled = this.quality.toggles.shadows;
    this.renderer.shadowMap.needsUpdate = true;

    this.riverbed.updateQuality(
      this.flowField,
      this.quality.riverbedSegmentsX,
      this.quality.riverbedSegmentsZ,
      this.quality.pebbleCount
    );
    this.waterSurface.updateGeometryResolution(
      this.quality.waterSegmentsX,
      this.quality.waterSegmentsZ
    );
    this.waterMaterial.applyQuality(this.quality);
    this.rippleSystem.setResolution(this.quality.rippleResolution);
    this.foamSystem.setCount(this.quality.foamParticleCount);
    this.foamSystem.mesh.visible = this.quality.toggles.foam;
    this.waterfall.updateQuality(
      this.quality.sprayParticleCount,
      this.quality.toggles.waterfallSpray,
      this.quality.toggles.reflections,
      this.quality.toggles.refraction
    );
    this.sharedUnderwaterUniforms.uCausticsEnabled.value =
      this.quality.toggles.caustics ? 1.0 : 0.0;
    this.postMaterial.uniforms.uPostEnabled.value =
      this.quality.toggles.postprocessing ? 1.0 : 0.0;
  }

  private applyFeatureToggle(key: keyof FeatureToggles, value: boolean): void {
    this.quality.toggles[key] = value;
    this.waterMaterial.applyQuality(this.quality);

    if (key === 'foam') {
      this.foamSystem.mesh.visible = value;
    } else if (key === 'caustics') {
      this.sharedUnderwaterUniforms.uCausticsEnabled.value = value ? 1.0 : 0.0;
    } else if (key === 'waterfallSpray' || key === 'reflections' || key === 'refraction') {
      this.waterfall.updateQuality(
        this.quality.sprayParticleCount,
        this.quality.toggles.waterfallSpray,
        this.quality.toggles.reflections,
        this.quality.toggles.refraction
      );
    } else if (key === 'shadows') {
      this.renderer.shadowMap.enabled = value;
      this.lighting.updateQuality(this.quality.shadowMapSize, value);
      this.renderer.shadowMap.needsUpdate = true;
    } else if (key === 'postprocessing') {
      this.postMaterial.uniforms.uPostEnabled.value = value ? 1.0 : 0.0;
    } else if (key === 'adaptiveResolution') {
      if (!value && this.adaptiveScale !== 1.0) {
        this.adaptiveScale = 1.0;
        this.updateViewportSize();
      }
    }
  }

  private startReproducibleBenchmark(): void {
    if (this.perfMonitor.isBenchmarkRunning) return;

    // Lock deterministic test conditions: Cinematic camera view, unpaused flow, fixed resolution scale
    this.paused = false;
    this.camTransition.active = false;
    this.camera.position.set(1.95, 0.96, 5.15);
    this.controls.target.set(-0.15, 0.14, -0.85);
    this.controls.update();

    if (this.adaptiveScale !== 1.0) {
      this.adaptiveScale = 1.0;
      this.updateViewportSize();
    }

    this.debugPanel.setBenchmarkRunning(true);
    this.perfMonitor.startBenchmark(() => {
      this.debugPanel.setBenchmarkRunning(false);
    });
  }

  private updateAdaptiveResolution(now: number): void {
    if (
      !this.quality.toggles.adaptiveResolution ||
      this.perfMonitor.isBenchmarkRunning ||
      now - this.lastAdaptiveCheckTime < 650
    ) {
      return;
    }
    this.lastAdaptiveCheckTime = now;

    const emaMs = this.perfMonitor.smoothedFrameTimeMs;
    let newScale = this.adaptiveScale;

    // Step down gradually if FPS < ~47 FPS (> 21.2 ms)
    if (emaMs > 21.2 && this.adaptiveScale > 0.55) {
      newScale = Math.max(0.55, this.adaptiveScale - 0.08);
    } else if (emaMs < 13.5 && this.adaptiveScale < 1.0) {
      // Step up gradually when ample GPU headroom is available (> 74 FPS)
      newScale = Math.min(1.0, this.adaptiveScale + 0.05);
    }

    if (Math.abs(newScale - this.adaptiveScale) > 0.01) {
      this.adaptiveScale = newScale;
      this.updateViewportSize();
    }
  }

  public transitionToCameraPreset(preset: CameraPresetName): void {
    this.camTransition.active = true;
    this.camTransition.startTime = performance.now();
    this.camTransition.startPos.copy(this.camera.position);
    this.camTransition.startTarget.copy(this.controls.target);

    if (preset === 'cinematic') {
      this.camTransition.endPos.set(1.95, 0.96, 5.15);
      this.camTransition.endTarget.set(-0.15, 0.14, -0.85);
    } else if (preset === 'closeup') {
      this.camTransition.endPos.set(0.95, 0.52, 3.72);
      this.camTransition.endTarget.set(0.32, 0.06, 2.45);
    } else if (preset === 'cascade') {
      this.camTransition.endPos.set(1.42, 0.86, 0.42);
      this.camTransition.endTarget.set(-0.12, 0.24, -1.92);
    } else if (preset === 'overhead') {
      this.camTransition.endPos.set(3.85, 4.45, 5.65);
      this.camTransition.endTarget.set(0.0, 0.12, -0.45);
    }
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.updateViewportSize());

    const dom = this.renderer.domElement;

    dom.addEventListener('pointerdown', (e: PointerEvent) => {
      this.pointerDownPos.set(e.clientX, e.clientY);
      this.camTransition.active = false;
    });

    dom.addEventListener('pointerup', (e: PointerEvent) => {
      if (!this.quality.toggles.pointerInteraction) return;
      const moveDist = Math.hypot(
        e.clientX - this.pointerDownPos.x,
        e.clientY - this.pointerDownPos.y
      );
      if (moveDist < 6.0) {
        this.spawnPointerRipple(e.clientX, e.clientY, 0.38, 0.85);
      }
    });

    dom.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.quality.toggles.pointerInteraction) return;
      const now = performance.now();
      if (now - this.lastDragDropTime < 40) return;
      this.lastDragDropTime = now;

      const isDragging = e.buttons > 0;
      const radius = isDragging ? 0.28 : 0.20;
      const strength = isDragging ? 0.52 : 0.30;
      this.spawnPointerRipple(e.clientX, e.clientY, radius, strength);
    });
  }

  private spawnPointerRipple(
    clientX: number,
    clientY: number,
    radius: number,
    strength: number
  ): void {
    this.pointerNDC.x = (clientX / window.innerWidth) * 2.0 - 1.0;
    this.pointerNDC.y = -(clientY / window.innerHeight) * 2.0 + 1.0;

    this.raycaster.setFromCamera(this.pointerNDC, this.camera);
    const hits = this.raycaster.intersectObject(this.waterSurface.mesh, false);
    if (hits.length > 0) {
      const pt = hits[0].point;
      if (
        pt.x >= STREAM_DOMAIN.minX &&
        pt.x <= STREAM_DOMAIN.maxX &&
        pt.z >= STREAM_DOMAIN.minZ &&
        pt.z <= STREAM_DOMAIN.maxZ
      ) {
        this.rippleSystem.addDrop(pt.x, pt.z, this.elapsedTime, radius, strength);
      }
    }
  }

  private hideLoadingOverlay(): void {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 650);
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTimestamp) / 1000.0);
    this.lastTimestamp = now;

    if (!this.paused) {
      this.elapsedTime += dt;
    }

    this.updateAdaptiveResolution(now);

    if (this.camTransition.active) {
      const t = Math.min(
        1.0,
        (now - this.camTransition.startTime) / (this.camTransition.duration * 1000.0)
      );
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.lerpVectors(
        this.camTransition.startPos,
        this.camTransition.endPos,
        ease
      );
      this.controls.target.lerpVectors(
        this.camTransition.startTarget,
        this.camTransition.endTarget,
        ease
      );
      if (t >= 1.0) {
        this.camTransition.active = false;
      }
    }

    this.controls.update();

    this.renderer.info.reset();
    this.perfMonitor.beginGpuFrame();

    // 1. Update GPU interactive wave equation ripples (automatically skips FBO pass when idle)
    if (!this.paused && this.quality.toggles.pointerInteraction) {
      this.rippleSystem.update(this.renderer, this.elapsedTime, dt);
    }

    // 2. Update underwater caustics, foam advection, and waterfall uniforms
    this.sharedUnderwaterUniforms.uTime.value = this.elapsedTime;
    if (!this.paused) {
      this.foamSystem.update(this.flowField, this.elapsedTime, dt);
    }
    this.waterfall.update(this.elapsedTime, this.camera, this.activeDpr);
    this.waterMaterial.updateFrame(
      this.elapsedTime,
      this.camera,
      this.rippleSystem.texture,
      this.rippleSystem.activeDropCount
    );

    // 3. Single-Pass Opaque Scene Render into postTarget (Sky, Riverbed, Pebbles, Boulders)
    this.waterSurface.mesh.visible = false;
    this.foamSystem.mesh.visible = false;
    this.waterfall.group.visible = false;

    this.renderer.setRenderTarget(this.postTarget);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // 4. Hardware Blit of Opaque Color + Depth to refractionTarget (Zero geometry draw calls!)
    const blitted = this.blitOpaqueToRefraction();
    if (!blitted) {
      // Fallback only if WebGL2 FBO handles were not yet initialized
      this.renderer.setRenderTarget(this.refractionTarget);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
    }

    // 5. Render Transparent Water, Waterfall & Foam directly onto postTarget (without re-rendering opaque scene!)
    this.environment.skyMesh.visible = false;
    this.riverbed.group.visible = false;
    this.rocks.group.visible = false;

    this.waterSurface.mesh.visible = true;
    this.foamSystem.mesh.visible = this.quality.toggles.foam;
    this.waterfall.group.visible = true;

    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(this.postTarget);
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = prevAutoClear;

    this.environment.skyMesh.visible = true;
    this.riverbed.group.visible = true;
    this.rocks.group.visible = true;

    // 6. Final Composite & Tone-Mapping Pass to Screen
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);

    this.perfMonitor.endGpuFrame();
    this.perfMonitor.endFrame(
      this.renderer,
      this.quality.name,
      this.activeWidth,
      this.activeHeight,
      this.activeDpr,
      this.quality.renderScale * this.adaptiveScale,
      this.quality.toggles.adaptiveResolution
    );
  };
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new WaterSimulationApp(appRoot);
}
