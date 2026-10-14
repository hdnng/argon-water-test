precision highp float;

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uCameraPos;
uniform vec2 uResolution;
uniform float uCameraNear;
uniform float uCameraFar;

uniform sampler2D uFlowMap;
uniform sampler2D uTerrainMap;
uniform sampler2D uNoiseTex;
uniform sampler2D uRippleMap;
uniform sampler2D tRefractionColor;
uniform sampler2D tRefractionDepth;
uniform samplerCube tEnvMap;

uniform vec4 uRippleDrops[16];
uniform int uActiveRippleCount;
uniform int uWaveOctaves;
uniform int uFoamOctaves;
uniform float uReflectionsEnabled;
uniform float uRefractionEnabled;
uniform float uFoamEnabled;
uniform float uPointerEnabled;

varying vec3 vWorldPos;
varying vec4 vClipPos;
varying vec2 vDomainUV;
varying vec4 vFlow;
varying float vWaterBaseY;
varying float vSolidY;
varying vec2 vObsGrad;
varying float vWaveHeight;

float perspectiveDepthToViewZ(float invClipZ, float near, float far) {
  return (near * far) / ((far - near) * invClipZ - far);
}

// Fast, high-definition wave normal gradient reconstruction using precomputed analytical
// wave slopes in 512x512 mipmapped uNoiseTex.rg (1 texture fetch per octave instead of 3!).
vec2 evaluateBandLimitedWaveGrad(vec2 pos, vec2 flowDir, float speed, int octaves, float distAtten) {
  vec2 perpDir = vec2(-flowDir.y, flowDir.x);
  // Flow-aligned coordinate frame: elongated along stream velocity for coherent chevron ripples
  float streamStretch = 0.21 / (1.0 + 0.26 * clamp(speed - 0.85, 0.0, 1.8));
  vec2 aligned = vec2(dot(pos, perpDir) * 0.42, dot(pos, flowDir) * streamStretch);

  // Octave 1: Primary flow-aligned stream undulations & chevron wave train
  vec2 g1 = (texture2D(uNoiseTex, aligned).rg * 2.0 - 1.0) * 1.55;
  vec2 gradWorld = perpDir * g1.x + flowDir * g1.y;

  if (octaves >= 2) {
    // Octave 2: Oblique cross-stream wavelet interference (+37 deg)
    mat2 rot2 = mat2(0.80, -0.60, 0.60, 0.80);
    vec2 p2 = (rot2 * pos) * 0.78 + vec2(0.27, -0.41);
    vec2 g2 = (texture2D(uNoiseTex, p2).rg * 2.0 - 1.0) * 1.18;
    gradWorld += transpose(rot2) * g2;
  }

  if (octaves >= 3) {
    // Octave 3: Crisp capillary ripples (-53 deg, smoothly filtered with distance)
    mat2 rot3 = mat2(0.60, 0.80, -0.80, 0.60);
    vec2 p3 = (rot3 * pos) * 1.72 + vec2(-0.53, 0.19);
    vec2 g3 = (texture2D(uNoiseTex, p3).rg * 2.0 - 1.0) * (0.86 * distAtten);
    gradWorld += transpose(rot3) * g3;
  }

  if (octaves >= 4) {
    // Octave 4: Ultra-close surface micro-ripples & surface tension texture
    vec2 p4 = pos * 3.45 + g1 * 0.08;
    vec2 g4 = (texture2D(uNoiseTex, p4).rg * 2.0 - 1.0) * (0.50 * distAtten * distAtten);
    gradWorld += g4;
  }

  return gradWorld;
}

// Dual-phase flow-map advection with spatial phase decorrelation
vec2 sampleAdvectedWaveNormals(vec2 worldXZ, vec2 velocity, int octaves, float distAtten) {
  float cyclePeriod = 2.4;
  float phaseOffset = texture2D(uNoiseTex, worldXZ * 0.065).b * 0.85;

  float t = uTime / cyclePeriod + phaseOffset;
  float phase0 = fract(t);
  float phase1 = fract(t + 0.5);

  vec2 advPos0 = worldXZ - velocity * (phase0 * cyclePeriod * 0.84);
  vec2 advPos1 = worldXZ - velocity * (phase1 * cyclePeriod * 0.84) + vec2(4.37, 2.91);

  float speed = length(velocity);
  vec2 flowDir = speed > 0.001 ? velocity / speed : vec2(0.0, 1.0);

  vec2 grad0 = evaluateBandLimitedWaveGrad(advPos0, flowDir, speed, octaves, distAtten);
  vec2 grad1 = evaluateBandLimitedWaveGrad(advPos1, flowDir, speed, octaves, distAtten);

  float weight0 = 0.5 - 0.5 * cos(phase0 * 6.2831853);
  float weight1 = 0.5 - 0.5 * cos(phase1 * 6.2831853);
  float normFactor = inversesqrt(max(0.0001, weight0 * weight0 + weight1 * weight1));

  return (grad0 * weight0 + grad1 * weight1) * normFactor;
}

// Exact unpolarized dielectric Fresnel equation for air (n1 = 1.00029) -> freshwater (n2 = 1.333)
float dielectricFresnel(float cosThetaI, float ior) {
  float c = clamp(cosThetaI, 0.0, 1.0);
  float sinThetaTSq = (1.0 - c * c) / (ior * ior);
  if (sinThetaTSq >= 1.0) return 1.0;
  float cosThetaT = sqrt(1.0 - sinThetaTSq);
  float rs = (c - ior * cosThetaT) / (c + ior * cosThetaT);
  float rp = (cosThetaT - ior * c) / (cosThetaT + ior * c);
  return 0.5 * (rs * rs + rp * rp);
}

float D_GGX(float NoH, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float denom = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(0.00001, 3.14159265 * denom * denom);
}

void main() {
  vec4 flow = texture2D(uFlowMap, vDomainUV);
  vec4 terrain = texture2D(uTerrainMap, vDomainUV);

  vec2 velocity = flow.rg;
  float speed = length(velocity);
  float turbulence = flow.b;
  float obstacleSDF = flow.a;

  float solidY = terrain.r;
  float waterBaseY = terrain.g;
  vec2 obsGrad = terrain.ba;

  float verticalDepth = vWorldPos.y - solidY;

  // Discard pixels inside dry emergent boulders or dry upper riverbanks
  if (verticalDepth < -0.022 || obstacleSDF < -0.042) {
    discard;
  }

  // Smooth meniscus feathering at rock and bank waterlines
  float edgeMeniscus = smoothstep(-0.020, 0.028, verticalDepth) * smoothstep(-0.038, 0.032, obstacleSDF);

  vec3 viewVec = uCameraPos - vWorldPos;
  float camDist = length(viewVec);
  vec3 V = viewVec / max(0.0001, camDist);

  // Distance-aware normal filtering
  float distAtten = 1.0 / (1.0 + camDist * 0.12);

  // 1. Base macro slope normal (from baked terrain water surface elevation)
  float eps = 0.085;
  float hR = texture2D(uTerrainMap, clamp(vDomainUV + vec2(eps / 16.0, 0.0), 0.0, 1.0)).g;
  float hL = texture2D(uTerrainMap, clamp(vDomainUV - vec2(eps / 16.0, 0.0), 0.0, 1.0)).g;
  float hU = texture2D(uTerrainMap, clamp(vDomainUV + vec2(0.0, eps / 24.0), 0.0, 1.0)).g;
  float hD = texture2D(uTerrainMap, clamp(vDomainUV - vec2(0.0, eps / 24.0), 0.0, 1.0)).g;
  vec2 macroSlope = vec2((hR - hL) / (2.0 * eps), (hU - hD) / (2.0 * eps));

  // 2. Coherent velocity- and turbulence-scaled wave normals (calm in slow pools, energetic in central current)
  float speedMod = 0.092 + 0.130 * smoothstep(0.18, 1.50, speed) + 0.085 * clamp(turbulence, 0.0, 1.15);
  vec2 waveGrad = sampleAdvectedWaveNormals(vWorldPos.xz, velocity, uWaveOctaves, distAtten) * speedMod;

  // 3. Velocity-dependent local flow disturbances around submerged & partially submerged rocks
  vec2 rockGrad = vec2(0.0);
  vec2 flowDir = speed > 0.01 ? velocity / speed : vec2(0.0, 1.0);
  vec2 perpDir = vec2(-flowDir.y, flowDir.x);
  float velScale = clamp(speed * 0.90, 0.35, 1.75);

  if (obstacleSDF > -0.03 && obstacleSDF < 0.95) {
    float upstreamFacing = smoothstep(-0.25, 0.65, -dot(obsGrad, flowDir));
    float flankFacing = smoothstep(0.05, 0.85, 1.0 - abs(dot(obsGrad, flowDir)));
    float downstreamFacing = smoothstep(-0.15, 0.65, dot(obsGrad, flowDir));
    float prox = exp(-max(0.0, obstacleSDF) * 3.4);
    float warp = texture2D(uNoiseTex, vWorldPos.xz * 0.45 - velocity * (uTime * 0.16)).b;

    float alongFlow = dot(vWorldPos.xz, flowDir);

    // A) Leading-edge standing wave cushion + stacked upstream compression ripples
    float standingSlope = (obstacleSDF - 0.04) * exp(-pow(max(0.0, obstacleSDF - 0.04) / 0.13, 2.0)) * 2.8;
    float compPhase = obstacleSDF * 28.0 - alongFlow * 4.5 + warp * 3.6 + uTime * 2.6;
    float dBow = (sin(compPhase) * 0.30 * prox + standingSlope * 0.24) * upstreamFacing * velScale;

    // B) Flank flow-separation chevron waves peeling off the rock shoulders along deflected streamlines
    float wakePhase = obstacleSDF * 34.0 - alongFlow * 12.0 + warp * 3.2 - uTime * 5.2;
    float dFlank = cos(wakePhase) * 0.25 * exp(-max(0.0, obstacleSDF) * 2.2) *
                   (flankFacing + downstreamFacing * 0.45) * velScale;

    rockGrad += obsGrad * (dBow + dFlank * 0.85) + flowDir * (dFlank * -0.45);
  }

  // C) Downstream wakes & localized counter-rotating vortex surface motion
  if (turbulence > 0.04) {
    float turbEnergy = min(1.45, turbulence * (0.65 + 0.45 * speed));
    // Counter-rotating vortex eddy coordinates advected with local flow
    float ang1 = uTime * 0.42;
    float ang2 = -uTime * 0.36;
    mat2 rotV1 = mat2(cos(ang1), -sin(ang1), sin(ang1), cos(ang1));
    mat2 rotV2 = mat2(cos(ang2), -sin(ang2), sin(ang2), cos(ang2));

    vec2 advCenter1 = vWorldPos.xz - velocity * fract(uTime * 0.38) * 1.45;
    vec2 advCenter2 = vWorldPos.xz - velocity * fract(uTime * 0.38 + 0.5) * 1.45 + vec2(2.17, 3.83);

    vec2 vGrad1 = texture2D(uNoiseTex, (rotV1 * advCenter1) * 0.68).rg * 2.0 - 1.0;
    vec2 vGrad2 = texture2D(uNoiseTex, (rotV2 * advCenter2) * 0.72).rg * 2.0 - 1.0;
    vec2 vortexSwirl = transpose(rotV1) * vGrad1 * 0.55 + transpose(rotV2) * vGrad2 * 0.55;

    // High-frequency flow-sheared ripple boils in turbulent wakes
    vec2 shearUV = vec2(dot(vWorldPos.xz, perpDir) * 1.55, dot(vWorldPos.xz, flowDir) * 0.65 - uTime * 0.55);
    vec2 shearBoil = (texture2D(uNoiseTex, shearUV).rg * 2.0 - 1.0);
    vec2 shearWorld = perpDir * shearBoil.x + flowDir * shearBoil.y;

    rockGrad += (vortexSwirl * 0.24 + shearWorld * 0.18) * turbEnergy * distAtten;
  }

  // Cascade drawdown acceleration deformation (flow-aligned progressive stretching over the ledge)
  float lipEnv = exp(-pow((vWorldPos.z - (-1.85)) / 0.64, 2.0)) * smoothstep(-0.02, 0.08, obstacleSDF);
  if (lipEnv > 0.02) {
    float stretchFactor = 0.28 / (1.0 + 0.42 * clamp(speed - 0.95, 0.0, 1.8));
    vec2 advCascade = vWorldPos.xz - velocity * (uTime * 0.34);
    vec2 lipUV = vec2(
      dot(advCascade, perpDir) * 0.68 + waveGrad.x * 0.18,
      dot(advCascade, flowDir) * stretchFactor + waveGrad.y * 0.14
    );
    vec2 lipSlope = (texture2D(uNoiseTex, lipUV).rg * 2.0 - 1.0);
    vec2 lipWorld = perpDir * (lipSlope.x * 0.24) + flowDir * (lipSlope.y * 0.11);
    rockGrad += lipWorld * lipEnv * clamp(speed * 0.75, 0.5, 1.5);
  }

  // Spreading surface ripples & turbulent boil waves radiating from cascade impact zones
  if (vWorldPos.z > -1.55 && vWorldPos.z < 0.35 && abs(vWorldPos.x) < 2.2) {
    vec2 impC = vWorldPos.xz - vec2(0.08, -1.12);
    vec2 impL = vWorldPos.xz - vec2(-0.87, -1.18);
    vec2 impR = vWorldPos.xz - vec2(0.89, -1.16);
    float dC = length(vec2(impC.x * 0.85, impC.y * 0.72));
    float dL = length(vec2(impL.x * 1.05, impL.y * 0.78));
    float dR = length(vec2(impR.x * 1.05, impR.y * 0.78));

    vec2 nearDelta = impC;
    float rMin = dC;
    if (dL < rMin) { rMin = dL; nearDelta = impL; }
    if (dR < rMin) { rMin = dR; nearDelta = impR; }

    vec2 ringDir = nearDelta / max(0.001, length(nearDelta));
    float warpPhase = (waveGrad.x + waveGrad.y) * 2.2;
    float ringSlope = cos(rMin * 24.0 - uTime * 7.4 + warpPhase) * 0.28 *
                      exp(-rMin * 1.75) * smoothstep(0.03, 0.22, rMin);
    rockGrad += ringDir * ringSlope * distAtten;
  }

  // 4. Interactive pointer ripples (only evaluated when active ripples exist!)
  vec2 rippleGrad = vec2(0.0);
  if (uPointerEnabled > 0.5 && uActiveRippleCount > 0) {
    vec4 simRipple = texture2D(uRippleMap, vDomainUV);
    rippleGrad += simRipple.ba * 1.55;

    for (int i = 0; i < 16; i++) {
      if (i >= uActiveRippleCount) break;
      vec4 drop = uRippleDrops[i];
      float age = uTime - drop.z;
      if (age > 0.0 && age < 4.0) {
        vec2 driftedCenter = drop.xy + velocity * age * 0.55;
        vec2 delta = vWorldPos.xz - driftedCenter;
        float r = length(delta);
        if (r > 0.001) {
          float waveFront = age * 1.65;
          float ringEnv = exp(-pow((r - waveFront) / (0.18 + age * 0.08), 2.0)) * exp(-age * 1.15);
          float k = 34.0 + 12.0 * clamp(r - waveFront + 0.2, 0.0, 0.5);
          float dPhase = cos((r - waveFront) * k) * k * ringEnv * drop.w * 0.010;
          rippleGrad += (delta / r) * dPhase;
        }
      }
    }
  }

  vec2 totalGrad = macroSlope + waveGrad + rockGrad + rippleGrad;
  vec3 N = normalize(vec3(-totalGrad.x, 1.0, -totalGrad.y));
  float NoV = max(0.002, dot(N, V));

  // Spatially varying micro-roughness from wave slope variance, flow speed, and turbulence
  float slopeVariance = dot(waveGrad + rockGrad, waveGrad + rockGrad);
  float surfaceRoughness = clamp(
    0.062 + 0.10 * clamp(turbulence, 0.0, 1.2) + 0.38 * slopeVariance + 0.045 * (1.0 - distAtten),
    0.055,
    0.42
  );

  // --- Screen-Space Refraction & Depth-Dependent Beer-Lambert Absorption ---
  vec2 screenUV = (vClipPos.xy / vClipPos.w) * 0.5 + 0.5;
  float waterEyeDepth = -perspectiveDepthToViewZ(gl_FragCoord.z, uCameraNear, uCameraFar);

  vec3 refractedSceneColor = vec3(0.18, 0.20, 0.17);
  float opticalPathLength = max(0.01, verticalDepth / max(0.32, V.y));

  if (uRefractionEnabled > 0.5) {
    // Increased normal distortion in high-velocity & turbulent areas while preserving calm-water pebble clarity
    float depthScale = smoothstep(0.0, 0.24, verticalDepth);
    float distortStrength = 0.020 + 0.012 * clamp(turbulence, 0.0, 1.0);
    vec2 refractOffset = N.xz * (distortStrength * depthScale / max(1.0, camDist * 0.30));
    vec2 refractedUV = clamp(screenUV + refractOffset, 0.002, 0.998);

    float rawDepth = texture2D(tRefractionDepth, refractedUV).r;
    float sampleEyeDepth = -perspectiveDepthToViewZ(rawDepth, uCameraNear, uCameraFar);

    // Reject refracted UV if it hits foreground geometry above the water surface
    if (sampleEyeDepth < waterEyeDepth - 0.008) {
      refractedUV = screenUV;
      rawDepth = texture2D(tRefractionDepth, screenUV).r;
      sampleEyeDepth = -perspectiveDepthToViewZ(rawDepth, uCameraNear, uCameraFar);
    }

    float rayDiff = max(0.0, sampleEyeDepth - waterEyeDepth);
    opticalPathLength = mix(verticalDepth / max(0.32, V.y), rayDiff, 0.74);
    refractedSceneColor = texture2D(tRefractionColor, refractedUV).rgb;
  } else {
    refractedSceneColor = texture2D(tRefractionColor, screenUV).rgb;
  }

  // Beer-Lambert freshwater spectral attenuation:
  // Shallow riffles (< 18cm) remain crystal-clear so submerged stones/gravel are sharply visible;
  // Deeper channel pools & plunge pool (35-95cm) develop a rich alpine emerald-olive depth tint.
  vec3 absorptionSigma = vec3(1.34, 0.48, 0.41);
  vec3 transmittance = exp(-absorptionSigma * opticalPathLength);

  float sunScatter = pow(max(0.0, dot(V, -uSunDir)), 3.0) * 0.34 + max(0.0, uSunDir.y) * 0.68;
  vec3 deepWaterInScatter = vec3(0.036, 0.094, 0.082) * sunScatter * (1.0 - transmittance);

  vec3 underwaterColor = refractedSceneColor * transmittance + deepWaterInScatter;

  // --- Physically Plausible Fresnel (IOR = 1.333) & Controlled Reflections ---
  float rawFresnel = dielectricFresnel(NoV, 1.333);
  // Roughness-based grazing Fresnel attenuation prevents overly bright mirror reflections in the stream center
  float fresnel = clamp(rawFresnel * (1.0 - 0.90 * surfaceRoughness), 0.02, 0.54);

  vec3 reflectedColor = vec3(0.0);
  if (uReflectionsEnabled > 0.5) {
    // Soften reflection normal slightly in rough turbulent areas to simulate micro-facet scatter
    vec3 reflectN = normalize(mix(N, vec3(0.0, 1.0, 0.0), surfaceRoughness * 0.36));
    vec3 R = reflect(-V, reflectN);
    R.y = max(0.02, R.y);
    R = normalize(R);

    vec3 rawSkyEnv = textureCube(tEnvMap, R).rgb;
    // Soft Reinhard shoulder on sky reflections prevents forward-scattered horizon glare from blowing out
    vec3 skyEnv = (rawSkyEnv / (vec3(1.0) + rawSkyEnv * 0.48)) * 0.66;

    // 3-step local rock & bank heightfield reflection occlusion
    float localOcclusion = 0.0;
    vec3 localRockReflectCol = vec3(0.22, 0.23, 0.21) * max(0.42, uSunDir.y);
    for (int s = 1; s <= 3; s++) {
      float stepDist = float(s) * 0.36;
      vec2 rayXZ = vWorldPos.xz + R.xz * stepDist;
      vec2 rayUV = clamp(vec2((rayXZ.x + 8.0) / 16.0, (rayXZ.y + 12.0) / 24.0), 0.0, 1.0);
      float raySolidY = texture2D(uTerrainMap, rayUV).r;
      float rayHeight = vWorldPos.y + R.y * stepDist * 0.50;
      if (raySolidY > rayHeight) {
        float hitWeight = smoothstep(rayHeight, rayHeight + 0.22, raySolidY) / float(s);
        localOcclusion = max(localOcclusion, hitWeight);
      }
    }

    // Soft local rock reflection tint right at boulder boundaries (avoids dark ring artifacts)
    float proximityShade = (1.0 - smoothstep(-0.01, 0.20, obstacleSDF)) * 0.26;
    float totalOcc = clamp(max(localOcclusion * 0.72, proximityShade), 0.0, 0.75);
    reflectedColor = mix(skyEnv, localRockReflectCol, totalOcc);
  } else {
    reflectedColor = vec3(0.22, 0.30, 0.36) * 0.36;
  }

  vec3 waterColor = mix(underwaterColor, reflectedColor, fresnel);

  // --- Coherent, Energetic Solar Specular Highlights Across Wave Facets ---
  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float NoL = max(0.0, dot(N, L));
  float NoH = max(0.0, dot(N, H));
  float VoH = max(0.0, dot(V, H));

  float specFresnel = dielectricFresnel(VoH, 1.333);
  float roughPrimary = max(0.058, surfaceRoughness * 0.82);
  float roughSecondary = 0.19 + 0.11 * clamp(turbulence, 0.0, 1.0);

  float D1 = D_GGX(NoH, roughPrimary);
  float D2 = D_GGX(NoH, roughSecondary);

  vec3 sunRadiance = vec3(1.55, 1.42, 1.20);
  vec3 specularHighlight = sunRadiance * specFresnel * NoL * (D1 * 0.15 + D2 * 0.052);

  // --- Cohesive, Flow-Aligned Organic Whitewater Patches & Streaks (Zero Dots, Zero Slab, Zero Wireframes) ---
  float surfaceFoamMask = 0.0;
  if (uFoamEnabled > 0.5) {
    // 1. Velocity-dependent leading-edge & flank bow collar right around emergent/semi-submerged rocks
    float upstreamContact = smoothstep(-0.25, 0.65, -dot(obsGrad, flowDir));
    float flankContact = smoothstep(0.10, 0.85, 1.0 - abs(dot(obsGrad, flowDir)));
    float contactCollar = exp(-pow(max(0.0, obstacleSDF - 0.01) / 0.11, 2.0)) *
                          smoothstep(-0.025, 0.015, obstacleSDF) *
                          (0.45 * flankContact + 0.82 * upstreamContact) *
                          clamp(speed * 0.85, 0.4, 1.4);

    // 2. Wake & plunge-pool turbulence scaled by local flow energy
    float flowEnergyBoost = 0.80 + 0.32 * smoothstep(0.6, 1.6, speed);
    float foamPotential = clamp(turbulence * flowEnergyBoost + contactCollar, 0.0, 1.35);

    if (foamPotential > 0.04) {
      float cyclePeriod = 2.5;
      float pOffset = texture2D(uNoiseTex, vWorldPos.xz * 0.075).b * 0.65;
      float tFoam = uTime / cyclePeriod + pOffset;
      float fp0 = fract(tFoam);
      float fp1 = fract(tFoam + 0.5);

      // Advect foam coordinates along the local velocity vector
      vec2 fPos0 = vWorldPos.xz - velocity * (fp0 * cyclePeriod * 0.86);
      vec2 fPos1 = vWorldPos.xz - velocity * (fp1 * cyclePeriod * 0.86) + vec2(3.71, 6.13);
      // Convex weights sum identically to 1.0 (no sqrt(2) inflation!)
      float fw0 = 0.5 - 0.5 * cos(fp0 * 6.2831853);
      float fw1 = 0.5 - 0.5 * cos(fp1 * 6.2831853);

      // Stretch coordinates along local velocity so foam forms cohesive flow-aligned patches and streaks
      float alongScale = 0.27 / (1.0 + 0.28 * clamp(speed - 0.8, 0.0, 1.4));
      vec2 aligned0 = vec2(dot(fPos0, perpDir) * 0.72, dot(fPos0, flowDir) * alongScale);
      vec2 aligned1 = vec2(dot(fPos1, perpDir) * 0.72, dot(fPos1, flowDir) * alongScale);

      // Primary cohesive organic foam patch field (channel B of 512x512 uNoiseTex)
      float fMacro0 = texture2D(uNoiseTex, aligned0).b;
      float fMacro1 = texture2D(uNoiseTex, aligned1).b;
      float foamCloud = fMacro0 * fw0 + fMacro1 * fw1;

      // Secondary medium-scale domain-warped billow modulation (keeps patches cohesive without shattering into dots)
      float cluster = foamCloud;
      if (uFoamOctaves >= 2) {
        vec2 sub0 = aligned0 * 1.85 + vec2(foamCloud * 0.30, -foamCloud * 0.22);
        vec2 sub1 = aligned1 * 1.85 + vec2(foamCloud * 0.30, -foamCloud * 0.22);
        float b0 = texture2D(uNoiseTex, sub0).b;
        float b1 = texture2D(uNoiseTex, sub1).b;
        cluster = b0 * fw0 + b1 * fw1;
      }

      // Soft internal aeration detail (never fragments patches into isolated white dots)
      float internalAeration = 1.0;
      if (uFoamOctaves >= 3) {
        float mb0 = texture2D(uNoiseTex, fPos0 * 1.45).b;
        float mb1 = texture2D(uNoiseTex, fPos1 * 1.45).b;
        internalAeration = 0.82 + 0.32 * (mb0 * fw0 + mb1 * fw1);
      }

      // Cohesive patch structure: zero in clear-water channels, continuous inside organic patches
      float foamStructure = foamCloud * (0.48 + 0.64 * cluster) * internalAeration;

      // Selective thresholding: forms distinct organic patches & streaks around rocks while preserving clear water gaps
      float lowEdge = clamp(0.47 - foamPotential * 0.21, 0.21, 0.45);
      float highEdge = lowEdge + 0.35;
      float rawFoamMask = smoothstep(lowEdge, highEdge, foamStructure);
      float potentialEnvelope = smoothstep(0.05, 0.26, foamPotential) * clamp(foamPotential * 0.84, 0.0, 0.78);

      // Layer 1: Partially translucent subsurface aerated water in turbulent boils
      float subAirMask = smoothstep(0.14, 0.52, foamStructure) * potentialEnvelope * 0.36;
      // Layer 2: Cohesive, partially translucent surface foam patches (opaque only in intense core peaks)
      surfaceFoamMask = rawFoamMask * potentialEnvelope;

      // 3D normal-shaded foam albedo with internal depth variation
      float foamLight = 0.64 + 0.36 * max(0.0, dot(N, L));
      vec3 subAirCol = vec3(0.48, 0.60, 0.63) * foamLight;
      vec3 translucentPatchCol = vec3(0.71, 0.78, 0.80) * foamLight;
      vec3 aeratedCoreCol = vec3(0.87, 0.90, 0.89) * foamLight;
      vec3 surfaceFoamCol = mix(translucentPatchCol, aeratedCoreCol, smoothstep(0.25, 0.80, rawFoamMask));

      waterColor = mix(waterColor, subAirCol, subAirMask);
      waterColor = mix(waterColor, surfaceFoamCol, surfaceFoamMask);
    }
  }

  // Attenuate mirror specular glints on foam-covered water so highlights do not clip whitewater
  waterColor += specularHighlight * (1.0 - clamp(surfaceFoamMask * 1.20, 0.0, 0.85));

  gl_FragColor = vec4(waterColor, edgeMeniscus);
}
