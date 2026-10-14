import * as THREE from 'three';
import { FlowField, CASCADE_CHUTES } from './FlowField';

const WATERFALL_SHEET_VERT = /* glsl */ `
precision highp float;

attribute vec3 aTangent;
attribute vec4 aChuteParams; // x: chuteSeed, y: chuteStrength, z: rockClearance, w: layerType

uniform float uTime;
uniform sampler2D uNoiseTex;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec4 vClipPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying float vChuteSeed;
varying float vChuteStrength;
varying float vRockClearance;
varying float vLayerType;
varying float vFallProgress;
varying float vTau;
varying float vEnvBell;
varying vec2 vDomainUV;

void main() {
  vUv = uv;
  vChuteSeed = aChuteParams.x;
  vChuteStrength = aChuteParams.y;
  vRockClearance = aChuteParams.z;
  vLayerType = aChuteParams.w;
  vFallProgress = uv.y; // 0 = upstream accelerating intake, 1 = downstream plunge roller

  // Physical free-fall travel-time integral tau(v): progressively stretches waves as water accelerates under gravity
  float tau = (sqrt(1.0 + 3.4 * vFallProgress) - 1.0) / 1.7;
  vTau = tau;

  vec2 seedVec = vec2(fract(vChuteSeed * 0.173), fract(vChuteSeed * 0.319));
  vec2 nUv1 = vec2(uv.x * 0.62 + seedVec.x, tau * 0.58 - uTime * 0.54);
  vec4 noise1 = texture2D(uNoiseTex, nUv1);

  // Domain-warped secondary sample for organic, non-periodic 3D water lobes (zero rigid sine stripes!)
  vec2 warp = (noise1.rg - 0.5) * 0.36;
  vec2 nUv2 = vec2(uv.x * 0.95 - seedVec.y, tau * 0.82 - uTime * 0.72) + warp;
  vec4 noise2 = texture2D(uNoiseTex, nUv2);

  float envBell = sin(vFallProgress * 3.14159265);
  vEnvBell = envBell;
  float clearanceMask = smoothstep(0.0, 0.35, vRockClearance);

  // 1. Broad organic sheet billow & variable liquid lobe thickness
  float sheetBillow = ((noise1.b - 0.46) * 0.024 + (noise2.b - 0.48) * 0.016) * envBell * vChuteStrength;

  // 2. Plunge impact boil & hydraulic roller agitation at the foot of the cascade
  float impactEnv = smoothstep(0.58, 0.86, vFallProgress) * (1.0 - smoothstep(0.88, 1.0, vFallProgress));
  float impactBoil = ((noise2.b - 0.38) * 0.028 + (noise1.r - 0.5) * 0.018) * impactEnv;

  // 3. Subtle lateral flow meander so falling sheets shift organically over the rock lip
  vec3 bitangent = normalize(cross(normal, aTangent));
  float lateralShift = (noise1.r - 0.5) * 0.022 * envBell * clearanceMask;

  vec3 displaced = position
    + normal * ((sheetBillow + impactBoil) * clearanceMask)
    + bitangent * lateralShift;

  // Analytical 3D normal perturbation from the smooth domain-warped liquid lobes
  float dLobeX = ((noise1.r - 0.5) * 0.28 + (noise2.r - 0.5) * 0.22) * envBell;
  float dLobeY = ((noise1.g - 0.5) * 0.18 + (noise2.g - 0.5) * 0.14) * envBell;
  vec3 perturbedNormal = normalize(normal - bitangent * dLobeX - aTangent * dLobeY);

  vec4 wp = modelMatrix * vec4(displaced, 1.0);
  vWorldPos = wp.xyz;
  vDomainUV = vec2((wp.x + 8.0) * 0.0625, (wp.z + 12.0) * 0.04166667);
  vNormal = normalize(mat3(modelMatrix) * perturbedNormal);
  vTangent = normalize(mat3(modelMatrix) * aTangent);

  gl_Position = projectionMatrix * viewMatrix * wp;
  vClipPos = gl_Position;
}
`;

const WATERFALL_SHEET_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform sampler2D uNoiseTex;
uniform sampler2D uFlowMap;
uniform sampler2D uTerrainMap;
uniform sampler2D tRefractionColor;
uniform samplerCube tEnvMap;
uniform float uReflectionsEnabled;
uniform float uRefractionEnabled;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec4 vClipPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying float vChuteSeed;
varying float vChuteStrength;
varying float vRockClearance;
varying float vLayerType;
varying float vFallProgress;
varying float vTau;
varying float vEnvBell;
varying vec2 vDomainUV;

// Exact unpolarized dielectric Fresnel equation for air -> freshwater (IOR = 1.333)
float dielectricFresnel(float cosThetaI, float ior) {
  float c = clamp(cosThetaI, 0.0, 1.0);
  float sinThetaTSq = (1.0 - c * c) / (ior * ior);
  if (sinThetaTSq >= 1.0) return 1.0;
  float cosThetaT = sqrt(1.0 - sinThetaTSq);
  float rs = (c - ior * cosThetaT) / (c + ior * cosThetaT);
  float rp = (cosThetaT - ior * c) / (cosThetaT + ior * c);
  return 0.5 * (rs * rs + rp * rp);
}

void main() {
  // Sample live obstacle SDF & terrain height to guarantee zero hard intersections with boulders
  vec2 domainUV = clamp(vDomainUV, 0.0, 1.0);
  vec4 flowSample = texture2D(uFlowMap, domainUV);
  vec4 terrainSample = texture2D(uTerrainMap, domainUV);
  float obstacleSDF = flowSample.a;
  float solidY = terrainSample.r;

  if (obstacleSDF < -0.025 || (vWorldPos.y - solidY) < -0.015) {
    discard;
  }

  float rockFeather = smoothstep(-0.022, 0.045, obstacleSDF) *
                      smoothstep(-0.012, 0.035, vWorldPos.y - solidY) *
                      smoothstep(0.0, 0.18, vRockClearance);

  // Physical free-fall travel-time coordinate tau interpolated from vertex shader
  float tau = vTau;

  vec2 seedVec = vec2(fract(vChuteSeed * 0.193), fract(vChuteSeed * 0.371));

  // Dual-phase advection with convex weights (w0 + w1 == 1.0 identically, no sqrt(2) inflation)
  float cycle = 1.45;
  float p0 = fract(uTime / cycle + vChuteSeed * 0.17);
  float p1 = fract(uTime / cycle + 0.5 + vChuteSeed * 0.17);
  float w0 = 0.5 - 0.5 * cos(p0 * 6.2831853);
  float w1 = 0.5 - 0.5 * cos(p1 * 6.2831853);

  // Organic, non-periodic lateral edge undulation (avoids straight chute borders)
  vec2 edgeUv = vec2(tau * 0.52 - uTime * 0.44, vChuteSeed * 0.23 + vUv.x * 0.35);
  vec4 edgeNoise = texture2D(uNoiseTex, edgeUv);
  float edgeWarp = ((edgeNoise.r - 0.5) * 0.34 + (edgeNoise.b - 0.5) * 0.22) * vEnvBell;

  float rawCenteredX = vUv.x * 2.0 - 1.0;
  float lateralCoord = rawCenteredX + edgeWarp;
  float lateralDist = abs(lateralCoord);
  if (lateralDist > 0.98) discard;

  float lateralMask = smoothstep(0.98, 0.20, lateralDist);

  // Continuous blending with accelerating upstream surface (v -> 0) and plunge pool roller (v -> 1)
  float topBlend = smoothstep(0.0, 0.24, vFallProgress);
  float bottomBlend = 1.0 - smoothstep(0.70, 1.0, vFallProgress);

  // --- Multi-Scale Domain-Warped Flowing Water Sheets, Braided Lobes & Detached Droplets ---
  // Slight vena-contracta convergence in mid-drop followed by impact flare
  float streamX = lateralCoord * (0.78 + 0.22 * vEnvBell - 0.14 * vFallProgress * vFallProgress);

  // Layer 1: Broad domain-warped water sheet billows (thick glossy cores vs thin translucent films)
  vec2 baseUv0 = vec2(streamX * 0.58 + seedVec.x, tau * 0.54 - p0 * 0.58);
  vec2 baseUv1 = vec2(streamX * 0.58 - seedVec.y, tau * 0.54 - p1 * 0.58 + 0.41);
  vec4 s0 = texture2D(uNoiseTex, baseUv0);
  vec4 s1 = texture2D(uNoiseTex, baseUv1);
  vec4 macroSheet = s0 * w0 + s1 * w1;

  // 2D domain warp from macro sheet slopes so internal water tongues curve and braid organically
  vec2 flowWarp = (macroSheet.rg - 0.5) * 0.42;

  // Layer 2: Oblique braided water tongues (+19 deg and -19 deg) that split and merge down the drop
  mat2 rotA = mat2(0.945, -0.326, 0.326, 0.945);
  mat2 rotB = mat2(0.945, 0.326, -0.326, 0.945);
  vec2 flowCoord0 = vec2(streamX * 0.88, tau * 0.76 - uTime * 0.64) + flowWarp + seedVec;
  vec2 flowCoord1 = vec2(streamX * 0.92, tau * 0.72 - uTime * 0.58) - flowWarp * 0.85 + seedVec.yx;

  vec4 tongueA = texture2D(uNoiseTex, rotA * flowCoord0);
  vec4 tongueB = texture2D(uNoiseTex, rotB * flowCoord1);
  vec4 braidedTongues = 0.52 * tongueA + 0.48 * tongueB;

  // Layer 3: Surface-tension breakup & detached droplets along thin margins and lower drop
  vec2 breakUv = vec2(streamX * 1.35, tau * 1.05 - uTime * 0.82) + (braidedTongues.rg - 0.5) * 0.28;
  vec4 breakSample = texture2D(uNoiseTex, breakUv);

  // Combine into organic variable sheet thickness (NO periodic cos(x) stripes!)
  float coreEnvelope = smoothstep(0.95, 0.08, lateralDist);
  float lobeBody = mix(macroSheet.b, braidedTongues.b, 0.54);
  float ligamentDetail = mix(braidedTongues.r, breakSample.b, 0.45);

  float rawThickness = (lobeBody * 0.62 + ligamentDetail * 0.46) * (0.55 + 0.55 * coreEnvelope) * vChuteStrength;

  // Progressive surface-tension fenestration (thin films open up into irregular gaps & detached droplets in lower fall)
  float breakupZone = smoothstep(0.32, 0.85, vFallProgress) * (0.35 + 0.65 * smoothstep(0.25, 0.85, lateralDist));
  float breakupThreshold = 0.14 + 0.20 * breakupZone + 0.08 * vLayerType;
  float sheetContinuity = smoothstep(breakupThreshold - 0.06, breakupThreshold + 0.22, rawThickness);

  // Small detached falling droplets that remain visible inside the fenestration gaps
  float dropletCell = smoothstep(0.66, 0.86, breakSample.b * (0.6 + 0.4 * tongueA.b)) *
                      smoothstep(0.22, 0.75, vFallProgress) *
                      smoothstep(0.96, 0.35, lateralDist);

  float waterThickness = clamp(max(rawThickness * sheetContinuity, dropletCell * 0.58), 0.0, 1.0);

  // --- 3D Liquid Surface Normals (Curved Water Tongues & Capillary Ripples) ---
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = normalize(uSunDir);

  vec2 lobeSlope = (macroSheet.rg * 2.0 - 1.0) * 0.42 +
                   (braidedTongues.rg * 2.0 - 1.0) * 0.36 +
                   (breakSample.rg * 2.0 - 1.0) * 0.22;

  vec3 bitangent = normalize(cross(vNormal, vTangent));
  // Cross-stream convexity (-lateralCoord * 0.28) + organic 3D lobe slopes
  vec3 N = normalize(
    vNormal
    + bitangent * (lobeSlope.x - lateralCoord * 0.28)
    + vTangent * (lobeSlope.y * 0.65)
  );

  float NoV = max(0.01, dot(N, V));

  // --- Consistent Freshwater Optical Behavior (Refraction, Beer-Lambert Depth & Dielectric Fresnel) ---
  vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
  vec3 refractedBg = vec3(0.15, 0.19, 0.17);
  if (uRefractionEnabled > 0.5) {
    // Thickness-dependent refractive lensing of the wet dark ledge stones & underlying water
    float distortAmt = (0.016 + 0.036 * waterThickness) * topBlend;
    vec2 refUv = clamp(screenUV + N.xz * distortAmt, 0.002, 0.998);
    refractedBg = texture2D(tRefractionColor, refUv).rgb;
  }

  // Beer-Lambert freshwater absorption across the falling sheet thickness (thin = crystal clear, thick = subtle emerald-jade body)
  float opticalPath = (0.03 + 0.24 * waterThickness * waterThickness) / max(0.38, NoV);
  vec3 absorptionSigma = vec3(1.34, 0.48, 0.41);
  vec3 transmittance = exp(-absorptionSigma * opticalPath);
  float sunScatter = pow(max(0.0, dot(V, -L)), 2.5) * 0.32 + max(0.0, L.y) * 0.65;
  vec3 waterBodyScatter = vec3(0.042, 0.102, 0.088) * sunScatter * (1.0 - transmittance);
  vec3 clearRefractedWater = refractedBg * transmittance + waterBodyScatter;

  // Dielectric Fresnel reflection (IOR = 1.333) attenuated by local turbulent micro-roughness
  float localRoughness = clamp(0.08 + 0.18 * (1.0 - waterThickness) + 0.12 * vFallProgress, 0.07, 0.36);
  float fresnel = clamp(dielectricFresnel(NoV, 1.333) * (1.0 - 0.78 * localRoughness), 0.02, 0.52);

  vec3 envReflect = vec3(0.28, 0.38, 0.44);
  if (uReflectionsEnabled > 0.5) {
    vec3 R = reflect(-V, N);
    R.y = max(0.03, R.y);
    vec3 rawSky = textureCube(tEnvMap, normalize(R)).rgb;
    envReflect = (rawSky / (vec3(1.0) + rawSky * 0.48)) * 0.64;
  }

  vec3 clearFallingWater = mix(clearRefractedWater, envReflect, fresnel);

  // --- Selective, Turbulence-Dependent Whitewater Aeration (Not a Uniform White Curtain!) ---
  // 1. Crest aeration only where thick, fast lobes experience strong shear in mid-to-lower drop
  float fallShearRamp = smoothstep(0.16, 0.68, vFallProgress) * (1.0 - 0.25 * vLayerType);
  float crestAeration = smoothstep(0.46, 0.86, waterThickness * (0.48 + 0.62 * braidedTongues.b) * fallShearRamp);

  // 2. Localized rock-grazing aeration where the sheet rubs against boulder shoulders
  float rockGrazeAeration = (1.0 - smoothstep(0.02, 0.42, vRockClearance)) *
                            smoothstep(0.08, 0.72, vFallProgress) *
                            smoothstep(0.20, 0.68, lobeBody) * 0.52;

  // 3. Plunge impact boil & frothy apron at the foot of the cascade (vFallProgress 0.62 -> 0.98)
  float impactZone = smoothstep(0.56, 0.82, vFallProgress);
  float impactFoamPatch = smoothstep(0.28, 0.74, (macroSheet.b * 0.58 + braidedTongues.b * 0.42)) * impactZone * 0.68;

  float totalAeration = clamp(max(crestAeration * 0.64 + rockGrazeAeration, impactFoamPatch), 0.0, 0.78);

  // 3D normal-shaded aerated water & foam color (matches Phase 1 natural foam palette)
  float lightDot = 0.62 + 0.38 * max(0.0, dot(N, L));
  vec3 shadedAeration = vec3(0.52, 0.64, 0.68) * lightDot;
  vec3 sunlitAeration = vec3(0.84, 0.89, 0.88) * lightDot;
  vec3 aeratedColor = mix(shadedAeration, sunlitAeration, smoothstep(0.22, 0.76, totalAeration));

  vec3 col = mix(clearFallingWater, aeratedColor, totalAeration);

  // Crisp solar specular glints along curved liquid tongues (attenuated on frothy foam)
  vec3 H = normalize(L + V);
  float NoH = max(0.0, dot(N, H));
  float NoL = max(0.0, dot(N, L));
  float spec = (pow(NoH, 72.0) * 0.58 + pow(NoH, 18.0) * 0.14) * NoL;
  col += vec3(0.96, 0.91, 0.79) * spec * (0.28 + 0.58 * waterThickness) * (1.0 - totalAeration * 0.72);

  // Thickness- and aeration-driven partial transparency (thin calm sections stay mostly transparent!)
  float clearOpacity = smoothstep(0.08, 0.58, waterThickness) * 0.44;
  float aeratedOpacity = totalAeration * 0.32;
  float sheetAlpha = clamp(clearOpacity + aeratedOpacity, 0.0, 0.64);

  float alpha = lateralMask * topBlend * bottomBlend * rockFeather * sheetAlpha;
  if (alpha < 0.015) discard;

  gl_FragColor = vec4(col, alpha);
}
`;

const SPRAY_VERT = /* glsl */ `
precision highp float;

attribute vec3 aVelocity;
attribute vec3 aTiming; // x: phase offset [0..1], y: pointSize, z: particleKind (0 = detached droplet, 1 = impact splash/mist)

uniform float uTime;
uniform float uPixelRatio;

varying float vAlpha;
varying float vShade;
varying float vKind;

void main() {
  vKind = aTiming.z;
  float lifePeriod = mix(0.78, 1.12, vKind);
  float age = fract(uTime / lifePeriod + aTiming.x) * lifePeriod;
  float normAge = age / lifePeriod;

  // Gravity-accelerated ballistic trajectory for detached falling droplets & impact splashes
  float gravity = mix(4.6, 3.6, vKind);
  vec3 pos = position + aVelocity * age + vec3(0.0, -0.5 * gravity * age * age, 0.24 * age);

  float fadeIn = smoothstep(0.0, 0.14, normAge);
  float fadeOut = 1.0 - smoothstep(0.45, 1.0, normAge);
  vAlpha = fadeIn * fadeOut;
  vShade = 0.84 + 0.16 * fract(aTiming.x * 7.13);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  // Detached droplets remain compact and crisp; impact splash expands softly
  float growth = mix(1.0 + normAge * 0.25, 1.0 + normAge * 0.95, vKind);
  float sizeScale = aTiming.y * growth;
  float maxPx = mix(6.5, 14.0, vKind);
  gl_PointSize = clamp(sizeScale * uPixelRatio * (12.5 / max(1.0, -mvPos.z)), 1.5, maxPx);
}
`;

const SPRAY_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;
varying float vAlpha;
varying float vShade;
varying float vKind;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;

  float sunLit = 0.76 + 0.24 * max(0.0, uSunDir.y);

  // Kind 0: Crisp glinting detached water droplet; Kind 1: Soft low-opacity splash mist
  float dropletShape = smoothstep(1.0, 0.15, r2);
  float dropletGlint = pow(max(0.0, 1.0 - length(c - vec2(-0.28, -0.28))), 3.0) * 0.35;
  float mistShape = exp(-r2 * 3.1) * (1.0 - r2);

  float radial = mix(dropletShape, mistShape, vKind);
  float baseOpacity = mix(0.34, 0.16, vKind);

  vec3 baseCol = mix(vec3(0.78, 0.86, 0.89) + vec3(dropletGlint), vec3(0.80, 0.87, 0.89), vKind) * sunLit * vShade;

  gl_FragColor = vec4(baseCol, radial * vAlpha * baseOpacity);
}
`;

export class Waterfall {
  public readonly group: THREE.Group;
  public readonly sheetMesh: THREE.Mesh;
  public readonly sprayPoints: THREE.Points;
  private readonly sheetMaterial: THREE.ShaderMaterial;
  private readonly sprayMaterial: THREE.ShaderMaterial;
  private readonly sprayGeometry: THREE.BufferGeometry;

  constructor(
    flowField: FlowField,
    sunDirection: THREE.Vector3,
    noiseTexture: THREE.Texture,
    refractionColorTexture: THREE.Texture,
    envMap: THREE.CubeTexture,
    sprayCount: number
  ) {
    this.group = new THREE.Group();

    const sheetGeo = this.buildCascadeChuteGeometry(flowField);
    this.sheetMaterial = new THREE.ShaderMaterial({
      vertexShader: WATERFALL_SHEET_VERT,
      fragmentShader: WATERFALL_SHEET_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection.clone().normalize() },
        uCameraPos: { value: new THREE.Vector3() },
        uNoiseTex: { value: noiseTexture },
        uFlowMap: { value: flowField.flowTexture },
        uTerrainMap: { value: flowField.terrainTexture },
        tRefractionColor: { value: refractionColorTexture },
        tEnvMap: { value: envMap },
        uReflectionsEnabled: { value: 1.0 },
        uRefractionEnabled: { value: 1.0 }
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.sheetMesh = new THREE.Mesh(sheetGeo, this.sheetMaterial);
    this.sheetMesh.renderOrder = 2;
    this.sheetMesh.matrixAutoUpdate = false;
    this.sheetMesh.updateMatrix();
    this.group.add(this.sheetMesh);

    this.sprayGeometry = this.buildSprayGeometry(flowField, 550);
    this.sprayGeometry.setDrawRange(0, sprayCount);

    this.sprayMaterial = new THREE.ShaderMaterial({
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(2.0, window.devicePixelRatio || 1.0) },
        uSunDir: { value: sunDirection.clone().normalize() }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });

    this.sprayPoints = new THREE.Points(this.sprayGeometry, this.sprayMaterial);
    this.sprayPoints.renderOrder = 4;
    this.sprayPoints.matrixAutoUpdate = false;
    this.sprayPoints.updateMatrix();
    this.group.add(this.sprayPoints);

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
  }

  /**
   * Constructs terrain- and obstacle-conforming 3D cascade sheets through the natural rocky gaps.
   * Includes primary arching free-fall nappe sheets and secondary stepped under-sheets merged into
   * a single BufferGeometry (1 draw call) for genuine side-angle depth and zero rock intersections.
   */
  private buildCascadeChuteGeometry(flowField: FlowField): THREE.BufferGeometry {
    interface SheetBuildDesc {
      centerX: number;
      width: number;
      strength: number;
      skewX: number;
      lipZ: number;
      dropEndZ: number;
      archHeight: number;
      seed: number;
      layerType: number; // 0 = primary upper nappe, 1 = lower stepped veil
    }

    const sheets: SheetBuildDesc[] = [];
    for (const c of CASCADE_CHUTES) {
      sheets.push({
        ...c,
        layerType: 0.0
      });
    }
    // Add a secondary lower stepped cascade sheet in the main central gap and left saddle
    // to provide multi-layered 3D depth when viewed from the side (View C) or close-up (View B)
    sheets.push({
      centerX: 0.08,
      width: 0.52,
      strength: 0.88,
      skewX: 0.02,
      lipZ: -2.32,
      dropEndZ: -1.18,
      archHeight: 0.024,
      seed: 19.4,
      layerType: 1.0
    });
    sheets.push({
      centerX: -0.98,
      width: 0.38,
      strength: 0.80,
      skewX: 0.14,
      lipZ: -2.26,
      dropEndZ: -1.24,
      archHeight: 0.020,
      seed: 23.1,
      layerType: 1.0
    });

    const segsU = 16;
    const segsV = 26;

    const positions: number[] = [];
    const normals: number[] = [];
    const tangents: number[] = [];
    const uvs: number[] = [];
    const chuteParams: number[] = [];
    const indices: number[] = [];

    let vertexOffset = 0;

    const evalPoint = (
      sheet: SheetBuildDesc,
      u: number,
      v: number
    ): { x: number; y: number; z: number; clearance: number } => {
      const zStart = sheet.lipZ - 0.22;
      const zEnd = sheet.dropEndZ + 0.20;
      const z = zStart + v * (zEnd - zStart);

      const sCurve = v * v * (3.0 - 2.0 * v);
      const bell = Math.sin(v * Math.PI);

      // Funnel wider at upstream intake, contract slightly in mid-fall, flare at plunge pool impact
      const widthScale =
        1.08 - 0.22 * Math.sin(v * Math.PI * 0.76) + 0.22 * Math.pow(v, 2.8);

      const meander =
        Math.sin(v * Math.PI * 1.5 + sheet.seed) * 0.032 * bell;
      const centerLineX = sheet.centerX + sheet.skewX * sCurve + meander;
      let x = centerLineX + (u - 0.5) * sheet.width * widthScale;

      const baseWaterY = flowField.getBaseWaterHeight(x, z);
      let rockEval = flowField.evaluateRockField(x, z, baseWaterY);

      // Smoothly deflect sheet vertices around emergent rock shoulders so sheets never cut through rocks
      if (rockEval.minSignedDist < 0.065) {
        const push = (0.065 - rockEval.minSignedDist) * 0.85 * bell;
        x += rockEval.gradX * push;
        rockEval = flowField.evaluateRockField(x, z, baseWaterY);
      }

      const cascadeWaterY = flowField.getCascadeWaterHeight(x, z) + rockEval.bowWaveHeight;
      const bedY = flowField.getRiverbedHeight(x, z);

      // Parabolic free-fall nappe arch over the drop; zero at v=0 and v=1 for seamless water connection
      const crossCrown = Math.cos((u - 0.5) * Math.PI) * 0.022 * bell;
      const nappeArch =
        sheet.archHeight * Math.sin(Math.pow(v, 0.74) * Math.PI) * bell + crossCrown;

      const minSafeY = bedY + 0.015;
      const y = Math.max(minSafeY, cascadeWaterY + nappeArch + 0.003 * bell);
      const clearance = Math.max(0.0, Math.min(1.0, (rockEval.minSignedDist + 0.025) / 0.14));

      return { x, y, z, clearance };
    };

    for (const sheet of sheets) {
      for (let iv = 0; iv <= segsV; iv++) {
        const v = iv / segsV;
        const vNext = Math.min(1.0, v + 1.0 / segsV);

        for (let iu = 0; iu <= segsU; iu++) {
          const u = iu / segsU;
          const uNext = Math.min(1.0, u + 1.0 / segsU);

          const p = evalPoint(sheet, u, v);
          const pV = evalPoint(sheet, u, vNext);
          const pU = evalPoint(sheet, uNext, v);

          let tx = pV.x - p.x;
          let ty = pV.y - p.y;
          let tz = pV.z - p.z;
          const tLen = Math.hypot(tx, ty, tz) || 1.0;
          tx /= tLen;
          ty /= tLen;
          tz /= tLen;

          let bx = pU.x - p.x;
          let by = pU.y - p.y;
          let bz = pU.z - p.z;
          const bLen = Math.hypot(bx, by, bz) || 1.0;
          bx /= bLen;
          by /= bLen;
          bz /= bLen;

          // Surface normal = tangent x bitangent (pointing upward and outward from cascade face)
          let nx = ty * bz - tz * by;
          let ny = tz * bx - tx * bz;
          let nz = tx * by - ty * bx;
          if (ny < 0.0) {
            nx = -nx;
            ny = -ny;
            nz = -nz;
          }
          const nLen = Math.hypot(nx, ny, nz) || 1.0;

          positions.push(p.x, p.y, p.z);
          normals.push(nx / nLen, ny / nLen, nz / nLen);
          tangents.push(tx, ty, tz);
          uvs.push(u, v);
          chuteParams.push(sheet.seed, sheet.strength, p.clearance, sheet.layerType);
        }
      }

      const stride = segsU + 1;
      for (let iv = 0; iv < segsV; iv++) {
        for (let iu = 0; iu < segsU; iu++) {
          const a = vertexOffset + iv * stride + iu;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          indices.push(a, c, b);
          indices.push(b, c, d);
        }
      }

      vertexOffset += (segsV + 1) * (segsU + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setIndex(indices);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('aTangent', new THREE.Float32BufferAttribute(tangents, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aChuteParams', new THREE.Float32BufferAttribute(chuteParams, 4));
    return geo;
  }

  /**
   * Builds a combined GPU particle buffer containing both:
   * - Kind 0 (45%): Detached falling water droplets breaking off the cascade sheets in mid-fall
   * - Kind 1 (55%): Short-lived plunge impact splash droplets & low spray at the chute toes
   */
  private buildSprayGeometry(flowField: FlowField, maxCount: number): THREE.BufferGeometry {
    const positions = new Float32Array(maxCount * 3);
    const velocities = new Float32Array(maxCount * 3);
    const timings = new Float32Array(maxCount * 3);

    for (let i = 0; i < maxCount; i++) {
      const chute = CASCADE_CHUTES[i % CASCADE_CHUTES.length];
      const isDetachedDroplet = i % 20 < 9; // 45% falling droplets, 55% impact splash

      if (isDetachedDroplet) {
        // Spawn along the breaking upper/mid nappe of the chute
        const tFall = 0.18 + Math.random() * 0.48;
        const z = chute.lipZ + tFall * (chute.dropEndZ - chute.lipZ);
        const xc = chute.centerX + chute.skewX * tFall;
        const x = xc + (Math.random() - 0.5) * chute.width * 0.85;
        const y =
          flowField.getCascadeWaterHeight(x, z) +
          chute.archHeight * Math.sin(Math.pow(tFall, 0.74) * Math.PI) +
          0.018;

        positions[i * 3 + 0] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        velocities[i * 3 + 0] = chute.skewX * 0.55 + (Math.random() - 0.5) * 0.28;
        velocities[i * 3 + 1] = -0.10 + Math.random() * 0.36;
        velocities[i * 3 + 2] = 0.85 + Math.random() * 0.65;

        timings[i * 3 + 0] = Math.random();
        timings[i * 3 + 1] = 1.6 + Math.random() * 2.1;
        timings[i * 3 + 2] = 0.0;
      } else {
        // Spawn at the plunge impact zone at the foot of the chute
        const impactX = chute.centerX + chute.skewX * 0.90;
        const x = impactX + (Math.random() - 0.5) * chute.width * 0.88;
        const z = chute.dropEndZ + (Math.random() - 0.4) * 0.22;
        const y = flowField.getCascadeWaterHeight(x, z) + 0.012;

        positions[i * 3 + 0] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;

        velocities[i * 3 + 0] = (x - impactX) * 0.85 + (Math.random() - 0.5) * 0.42;
        velocities[i * 3 + 1] = 0.38 + Math.random() * 0.58;
        velocities[i * 3 + 2] = 0.32 + Math.random() * 0.64;

        timings[i * 3 + 0] = Math.random();
        timings[i * 3 + 1] = 2.4 + Math.random() * 3.4;
        timings[i * 3 + 2] = 1.0;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    geo.setAttribute('aTiming', new THREE.BufferAttribute(timings, 3));
    return geo;
  }

  public update(elapsedTime: number, camera: THREE.Camera, pixelRatio: number): void {
    this.sheetMaterial.uniforms.uTime.value = elapsedTime;
    this.sheetMaterial.uniforms.uCameraPos.value.copy(camera.position);
    if (this.sprayPoints.visible) {
      this.sprayMaterial.uniforms.uTime.value = elapsedTime;
      this.sprayMaterial.uniforms.uPixelRatio.value = pixelRatio;
    }
  }

  public updateQuality(
    sprayCount: number,
    sprayEnabled: boolean,
    reflectionsEnabled: boolean,
    refractionEnabled: boolean
  ): void {
    this.sprayPoints.visible = sprayEnabled;
    this.sprayGeometry.setDrawRange(0, Math.min(550, sprayCount));
    this.sheetMaterial.uniforms.uReflectionsEnabled.value = reflectionsEnabled ? 1.0 : 0.0;
    this.sheetMaterial.uniforms.uRefractionEnabled.value = refractionEnabled ? 1.0 : 0.0;
  }

  public dispose(): void {
    this.sheetMesh.geometry.dispose();
    this.sheetMaterial.dispose();
    this.sprayGeometry.dispose();
    this.sprayMaterial.dispose();
  }
}
