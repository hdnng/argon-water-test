import * as THREE from 'three';
import { STREAM_DOMAIN } from './FlowField';

const RIPPLE_SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const RIPPLE_SIM_FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform sampler2D uPrevState;
uniform sampler2D uFlowMap;
uniform vec2 uTexelSize;
uniform vec4 uDrop; // xy: uv position, z: radius, w: strength
uniform float uDamping;
uniform float uDt;

void main() {
  vec4 flow = texture2D(uFlowMap, vUv);
  vec2 uvVel = vec2(flow.r / 16.0, flow.g / 24.0);
  vec2 advUv = clamp(vUv - uvVel * uDt * 0.65, 0.002, 0.998);

  vec4 state = texture2D(uPrevState, advUv);
  float h = state.r;
  float hPrev = state.g;

  float hL = texture2D(uPrevState, advUv + vec2(-uTexelSize.x, 0.0)).r;
  float hR = texture2D(uPrevState, advUv + vec2(uTexelSize.x, 0.0)).r;
  float hD = texture2D(uPrevState, advUv + vec2(0.0, -uTexelSize.y)).r;
  float hU = texture2D(uPrevState, advUv + vec2(0.0, uTexelSize.y)).r;

  float laplacian = (hL + hR + hD + hU) * 0.25 - h;
  float hNext = (2.0 * h - hPrev + laplacian * 0.42) * uDamping;

  if (uDrop.w > 0.0001) {
    vec2 deltaWorld = (vUv - uDrop.xy) * vec2(16.0, 24.0);
    float dist = length(deltaWorld);
    if (dist < uDrop.z) {
      float t = dist / uDrop.z;
      float impulse = (1.0 - t * t) * cos(t * 3.14159 * 0.85) * uDrop.w;
      hNext += impulse;
    }
  }

  if (flow.a < 0.0) {
    hNext *= 0.15;
  }

  hNext = clamp(hNext, -1.0, 1.0);

  float gradX = (hR - hL) * 0.5;
  float gradZ = (hU - hD) * 0.5;

  gl_FragColor = vec4(hNext, h, gradX, gradZ);
}
`;

export interface RippleDropRecord {
  x: number;
  z: number;
  startTime: number;
  strength: number;
}

export class RippleSystem {
  public readonly maxDrops = 16;
  public readonly dropUniformArray: THREE.Vector4[] = [];
  public activeDropCount = 0;

  private drops: RippleDropRecord[] = [];
  private renderTargetA: THREE.WebGLRenderTarget;
  private renderTargetB: THREE.WebGLRenderTarget;
  private simScene: THREE.Scene;
  private simCamera: THREE.OrthographicCamera;
  private simMaterial: THREE.ShaderMaterial;
  private pendingDrop = new THREE.Vector4(0, 0, 0, 0);
  private resolution: number;
  private supportsFloatRT: boolean;
  private lastImpulseTime = -100;

  constructor(
    renderer: THREE.WebGLRenderer,
    flowTexture: THREE.Texture,
    resolution = 256
  ) {
    this.resolution = resolution;

    for (let i = 0; i < this.maxDrops; i++) {
      this.dropUniformArray.push(new THREE.Vector4(0, 0, -100, 0));
    }

    const extFloat = renderer.extensions.get('EXT_color_buffer_float');
    const extHalfFloat = renderer.extensions.get('EXT_color_buffer_half_float');
    this.supportsFloatRT = Boolean(extFloat || extHalfFloat);

    const rtOptions: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: this.supportsFloatRT ? THREE.HalfFloatType : THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false
    };

    this.renderTargetA = new THREE.WebGLRenderTarget(resolution, resolution, rtOptions);
    this.renderTargetB = new THREE.WebGLRenderTarget(resolution, resolution, rtOptions);

    this.simScene = new THREE.Scene();
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.simMaterial = new THREE.ShaderMaterial({
      vertexShader: RIPPLE_SIM_VERT,
      fragmentShader: RIPPLE_SIM_FRAG,
      uniforms: {
        uPrevState: { value: null },
        uFlowMap: { value: flowTexture },
        uTexelSize: { value: new THREE.Vector2(1.0 / resolution, 1.0 / resolution) },
        uDrop: { value: new THREE.Vector4(0, 0, 0, 0) },
        uDamping: { value: 0.982 },
        uDt: { value: 0.016 }
      },
      depthTest: false,
      depthWrite: false
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.simMaterial);
    this.simScene.add(quad);
  }

  public addDrop(
    worldX: number,
    worldZ: number,
    currentTime: number,
    radius = 0.34,
    strength = 0.65
  ): void {
    const u = (worldX - STREAM_DOMAIN.minX) / STREAM_DOMAIN.width;
    const v = (worldZ - STREAM_DOMAIN.minZ) / STREAM_DOMAIN.length;
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return;

    this.pendingDrop.set(u, v, radius, strength);
    this.lastImpulseTime = currentTime;

    this.drops.push({ x: worldX, z: worldZ, startTime: currentTime, strength });
    if (this.drops.length > this.maxDrops) {
      this.drops.shift();
    }
  }

  public update(renderer: THREE.WebGLRenderer, currentTime: number, dt: number): void {
    // Compact expired drops in-place without allocating a new Array every frame
    let writeIdx = 0;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      if (currentTime - d.startTime < 4.0) {
        this.drops[writeIdx++] = d;
      }
    }
    const prevActiveCount = this.activeDropCount;
    this.drops.length = writeIdx;
    this.activeDropCount = writeIdx;

    if (this.activeDropCount > 0 || prevActiveCount > 0) {
      for (let i = 0; i < this.maxDrops; i++) {
        if (i < this.activeDropCount) {
          const d = this.drops[i];
          this.dropUniformArray[i].set(d.x, d.z, d.startTime, d.strength);
        } else {
          this.dropUniformArray[i].set(0, 0, -100, 0);
        }
      }
    }

    // Only run the GPU ping-pong FBO pass when recent pointer activity has occurred (< 6s ago)
    if (!this.supportsFloatRT || currentTime - this.lastImpulseTime > 6.0) {
      this.pendingDrop.set(0, 0, 0, 0);
      return;
    }

    this.simMaterial.uniforms.uPrevState.value = this.renderTargetA.texture;
    this.simMaterial.uniforms.uDrop.value.copy(this.pendingDrop);
    this.simMaterial.uniforms.uDt.value = Math.min(0.033, dt);

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.renderTargetB);
    renderer.render(this.simScene, this.simCamera);
    renderer.setRenderTarget(prevTarget);

    const temp = this.renderTargetA;
    this.renderTargetA = this.renderTargetB;
    this.renderTargetB = temp;

    this.pendingDrop.set(0, 0, 0, 0);
  }

  public get texture(): THREE.Texture {
    return this.renderTargetA.texture;
  }

  public setResolution(resolution: number): void {
    if (this.resolution === resolution) return;
    this.resolution = resolution;
    this.renderTargetA.setSize(resolution, resolution);
    this.renderTargetB.setSize(resolution, resolution);
    this.simMaterial.uniforms.uTexelSize.value.set(1.0 / resolution, 1.0 / resolution);
  }

  public dispose(): void {
    this.renderTargetA.dispose();
    this.renderTargetB.dispose();
    this.simMaterial.dispose();
  }
}
