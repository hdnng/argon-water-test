import * as THREE from 'three';

const ENV_VERT = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  gl_Position.z = gl_Position.w;
}
`;

const ENV_FRAG = /* glsl */ `
precision highp float;

varying vec3 vWorldDir;
uniform vec3 uSunDir;

float hash12(vec2 p) {
  vec3 p3  = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * valueNoise(p);
    p = rot * p * 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 sunDir = normalize(uSunDir);

  float y = dir.y;
  float azimuth = atan(dir.x, dir.z);

  // Natural Rayleigh + Mie alpine daylight sky gradient (controlled horizon luminance)
  vec3 zenithColor = vec3(0.20, 0.39, 0.64);
  vec3 midSkyColor = vec3(0.42, 0.58, 0.76);
  vec3 horizonColor = vec3(0.64, 0.72, 0.78);

  float skyT = clamp(y, 0.0, 1.0);
  vec3 sky = mix(horizonColor, midSkyColor, pow(skyT, 0.45));
  sky = mix(sky, zenithColor, pow(skyT, 1.15));

  // Soft natural cirrus/cumulus cloud wisps
  if (y > 0.04) {
    vec2 cloudUV = dir.xz / (y + 0.20) * 1.15;
    float c1 = fbm(cloudUV + vec2(1.7, -0.8));
    float c2 = fbm(cloudUV * 2.4 - vec2(0.5, 2.1));
    float cloudMask = smoothstep(0.50, 0.78, c1 * 0.75 + c2 * 0.25) * smoothstep(0.04, 0.25, y);
    float sunLitCloud = max(0.0, dot(dir, sunDir));
    vec3 cloudColor = mix(vec3(0.78, 0.83, 0.88), vec3(0.98, 0.92, 0.84), pow(sunLitCloud, 3.0));
    sky = mix(sky, cloudColor, cloudMask * 0.46);
  }

  // Solar aureole (Mie forward scattering) + solar disk
  float cosTheta = max(0.0, dot(dir, sunDir));
  vec3 mieScatter = vec3(0.96, 0.86, 0.70) * (0.22 * pow(cosTheta, 6.0) + 0.52 * pow(cosTheta, 48.0));
  vec3 sunDisk = vec3(5.2, 4.6, 3.6) * smoothstep(0.9982, 0.9997, cosTheta);
  sky += mieScatter + sunDisk;

  // Surrounding mountain gorge ridges & lush overhanging riparian forest canopy:
  // Provides natural dark-green foliage & warm rocky cliff reflections on the water surface
  // instead of overly bright white/blue horizon glare!
  float ridgeAngle = azimuth * 2.5;
  float farMountainHeight = 0.11 + 0.12 * fbm(vec2(ridgeAngle, 1.3)) + 0.05 * sin(azimuth * 3.0 + 0.5);
  float bankCanopyFactor = 0.45 + 0.55 * pow(abs(sin(azimuth)), 0.65);
  float midTreeCanopyHeight = (0.10 + 0.22 * bankCanopyFactor) * (0.60 + 0.50 * fbm(vec2(azimuth * 6.5, 4.2)));

  if (y < farMountainHeight) {
    float distHaze = smoothstep(-0.02, farMountainHeight, y);
    float cliffNoise = fbm(vec2(azimuth * 12.0, y * 16.0));
    vec3 cliffBase = mix(vec3(0.16, 0.17, 0.15), vec3(0.28, 0.24, 0.19), cliffNoise);
    vec3 mountainCol = mix(cliffBase, vec3(0.28, 0.36, 0.42), distHaze * 0.58);
    sky = mix(mountainCol, sky, smoothstep(farMountainHeight - 0.015, farMountainHeight + 0.006, y));
  }

  if (y < midTreeCanopyHeight) {
    float leafDetail = fbm(vec2(azimuth * 18.0, y * 28.0));
    float sunFacing = 0.45 + 0.55 * max(0.0, dot(normalize(vec3(dir.x, 0.25, dir.z)), sunDir));
    vec3 foliageDark = vec3(0.05, 0.09, 0.04);
    vec3 foliageLit = vec3(0.16, 0.23, 0.10);
    vec3 canopyCol = mix(foliageDark, foliageLit, leafDetail * sunFacing);
    // Leave dappled sky holes near top of overhanging branches
    float canopyAlpha = smoothstep(
      midTreeCanopyHeight + 0.012,
      midTreeCanopyHeight - 0.032,
      y + (leafDetail - 0.5) * 0.042
    );
    sky = mix(sky, canopyCol, canopyAlpha);
  }

  // Below horizon: dark wet stony riverbed ground bounce
  if (y < 0.0) {
    vec3 groundCol = mix(vec3(0.12, 0.13, 0.11), vec3(0.05, 0.06, 0.05), clamp(-y * 3.0, 0.0, 1.0));
    sky = mix(sky, groundCol, smoothstep(0.0, -0.06, y));
  }

  gl_FragColor = vec4(sky, 1.0);
}
`;

export class Environment {
  public readonly skyMesh: THREE.Mesh;
  public readonly cubeRenderTarget: THREE.WebGLCubeRenderTarget;
  private readonly skyMaterial: THREE.ShaderMaterial;

  constructor(renderer: THREE.WebGLRenderer, sunDirection: THREE.Vector3) {
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      uniforms: {
        uSunDir: { value: sunDirection.clone().normalize() }
      },
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth
    });

    const skyGeo = new THREE.SphereGeometry(90, 48, 24);
    this.skyMesh = new THREE.Mesh(skyGeo, this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    // Render after opaque terrain & rocks (renderOrder -3..-1) at z=w so Hardware Early-Z rejects 95-100% of occluded sky pixels
    this.skyMesh.renderOrder = 0;
    this.skyMesh.matrixAutoUpdate = false;
    this.skyMesh.updateMatrix();

    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter
    });

    this.bakeEnvironmentCubemap(renderer);
  }

  public bakeEnvironmentCubemap(renderer: THREE.WebGLRenderer): void {
    const envScene = new THREE.Scene();
    const tempSky = new THREE.Mesh(this.skyMesh.geometry, this.skyMaterial);
    envScene.add(tempSky);

    const cubeCamera = new THREE.CubeCamera(0.5, 150, this.cubeRenderTarget);
    cubeCamera.update(renderer, envScene);
  }

  public get envMap(): THREE.CubeTexture {
    return this.cubeRenderTarget.texture;
  }

  public dispose(): void {
    this.skyMesh.geometry.dispose();
    this.skyMaterial.dispose();
    this.cubeRenderTarget.dispose();
  }
}
