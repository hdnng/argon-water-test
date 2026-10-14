precision highp float;

uniform float uTime;
uniform sampler2D uFlowMap;
uniform sampler2D uTerrainMap;
uniform sampler2D uNoiseTex;
uniform sampler2D uRippleMap;
uniform vec4 uRippleDrops[16];
uniform int uActiveRippleCount;
uniform float uPointerEnabled;

varying vec3 vWorldPos;
varying vec4 vClipPos;
varying vec2 vDomainUV;
varying vec4 vFlow;         // rg: velocity (vx, vz), b: turbulence, a: obstacleSDF
varying float vWaterBaseY;
varying float vSolidY;
varying vec2 vObsGrad;
varying float vWaveHeight;

vec2 worldToDomainUV(vec2 xz) {
  return vec2(
    (xz.x - (-8.0)) / 16.0,
    (xz.y - (-12.0)) / 24.0
  );
}

// Evaluate natural multi-frequency physical surface displacement at world (x, z)
float evaluateWaveDisplacement(vec2 xz, vec4 flow, vec2 obsGrad, float waterDepth) {
  vec2 vel = flow.rg;
  float speed = length(vel);
  float turb = flow.b;
  float sdf = flow.a;

  // Smoothly attenuate displacement in very shallow margins and inside rocks
  float depthMask = smoothstep(0.0, 0.08, waterDepth) * smoothstep(-0.04, 0.05, sdf);

  vec2 advUV1 = xz * 0.18 - vel * (uTime * 0.18);
  vec2 advUV2 = xz * 0.42 - vel * (uTime * 0.30) + vec2(0.37, 0.71);
  vec4 s1 = texture2D(uNoiseTex, advUV1);
  vec4 s2 = texture2D(uNoiseTex, advUV2);
  float n1 = s1.b - 0.5;
  float n2 = s2.r - 0.5;

  // 1. Broad, low-frequency current swell + organic undulation
  float w1 = n1 * 0.020 + sin(xz.y * 2.1 - uTime * 2.8 + n1 * 2.8) * 0.0065;

  // 2. Medium-scale flow-aligned chevron wavelets scaled by local current speed
  vec2 flowDir = speed > 0.01 ? vel / speed : vec2(0.0, 1.0);
  vec2 perpDir = vec2(-flowDir.y, flowDir.x);
  float along = dot(xz, flowDir);
  float across = dot(xz, perpDir);

  float chevron1 = sin(along * 7.2 + across * 3.8 - uTime * (4.0 + speed * 1.8) + n1 * 3.4);
  float chevron2 = sin(along * 7.8 - across * 4.0 - uTime * (4.2 + speed * 1.8) - n2 * 3.1);
  float w2 = (n2 * 0.016 + (chevron1 + chevron2) * 0.0052) * min(1.85, speed);

  // 3. Velocity-dependent leading-edge standing wave, compression ripples & flank separation around rocks
  float rockWave = 0.0;
  if (sdf > -0.02 && sdf < 0.85) {
    float velScale = clamp(speed * 0.85, 0.35, 1.65);
    float upstreamFactor = smoothstep(-0.20, 0.65, -dot(obsGrad, flowDir));
    float flankFactor = smoothstep(0.10, 0.85, 1.0 - abs(dot(obsGrad, flowDir)));
    float prox = exp(-max(0.0, sdf) * 3.4);

    // Leading-edge standing wave cushion + stacked upstream compression ripples
    float standingCrest = exp(-pow(max(0.0, sdf - 0.03) / 0.14, 2.0)) * 0.022 * upstreamFactor;
    float compRipples = cos(sdf * 26.0 - uTime * 3.4 + n1 * 2.6) * 0.016 * prox * upstreamFactor;

    // Oblique V-wake chevron waves peeling off the boulder flanks
    float flankWake = sin(sdf * 30.0 - along * 9.5 - uTime * 4.8 + n2 * 2.4) * 0.014 *
                      exp(-max(0.0, sdf) * 2.5) * flankFactor;

    rockWave = (standingCrest + compRipples + flankWake) * velScale;
  }

  // 4. Energetic turbulent boils & vortex surface motion in rock wakes & cascade plunge pool
  float turbBoil = (n2 * 0.032 + sin(along * 12.0 - uTime * 5.8 + s2.b * 4.2) * 0.011) *
                   clamp(turb, 0.0, 1.45);

  // 5. Cascade flow-stretched sheet undulations over the ledge (z in [-2.5, -1.1]) & spreading impact ripples
  float cascadeEnv = exp(-pow((xz.y - (-1.82)) / 0.64, 2.0)) * smoothstep(-0.02, 0.08, sdf);
  vec2 stretchUV = vec2(across * 0.58 + n1 * 0.32, along * 0.22 - uTime * 0.52);
  float sheetLobe = (texture2D(uNoiseTex, stretchUV).b - 0.45) * 0.028;
  float cascadeRibs = (sheetLobe + n2 * 0.014) * cascadeEnv * clamp(speed * 0.78, 0.5, 1.6);

  // Localized hydraulic roller boil & concentric impact ripples spreading into downstream pool
  float plungeRoller = 0.0;
  if (xz.y > -1.55 && xz.y < 0.35 && abs(xz.x) < 2.2) {
    vec2 impC = xz - vec2(0.08, -1.12);
    vec2 impL = xz - vec2(-0.87, -1.18);
    vec2 impR = xz - vec2(0.89, -1.16);
    float dC = length(vec2(impC.x * 0.85, impC.y * 0.72));
    float dL = length(vec2(impL.x * 1.05, impL.y * 0.78));
    float dR = length(vec2(impR.x * 1.05, impR.y * 0.78));

    float rMin = min(dC, min(dL, dR));
    float ringWave = sin(rMin * 24.0 - uTime * 7.4 + n1 * 3.2) * exp(-rMin * 1.75) * smoothstep(0.02, 0.22, rMin);
    float rollerBoil = (n1 * 0.024 + n2 * 0.018) * exp(-pow((xz.y - (-1.08)) / 0.38, 2.0)) * exp(-pow(xz.x / 1.55, 2.0));
    plungeRoller = ringWave * 0.016 + rollerBoil;
  }

  // 6. Interactive pointer ripples (only loops over active drops; 0 iterations when idle!)
  float interactiveDisp = 0.0;
  if (uPointerEnabled > 0.5 && uActiveRippleCount > 0) {
    vec2 uv = clamp(worldToDomainUV(xz), 0.0, 1.0);
    float simH = texture2D(uRippleMap, uv).r;
    interactiveDisp += simH * 0.026;

    for (int i = 0; i < 16; i++) {
      if (i >= uActiveRippleCount) break;
      vec4 drop = uRippleDrops[i];
      float age = uTime - drop.z;
      if (age > 0.0 && age < 4.0) {
        vec2 driftedCenter = drop.xy + vel * age * 0.55;
        float r = length(xz - driftedCenter);
        float waveFront = age * 1.65;
        float ringEnv = exp(-pow((r - waveFront) / (0.18 + age * 0.08), 2.0)) * exp(-age * 1.15);
        interactiveDisp += sin((r - waveFront) * 34.0) * ringEnv * drop.w * 0.019;
      }
    }
  }

  return (w1 + w2 + rockWave + turbBoil + cascadeRibs + plungeRoller) * depthMask +
         interactiveDisp * smoothstep(-0.02, 0.05, sdf);
}

void main() {
  vec2 xz = position.xz;
  vec2 domainUV = clamp(worldToDomainUV(xz), 0.0, 1.0);

  vec4 flow = texture2D(uFlowMap, domainUV);
  vec4 terrain = texture2D(uTerrainMap, domainUV);

  float solidY = terrain.r;
  float waterBaseY = terrain.g;
  vec2 obsGrad = terrain.ba;
  float waterDepth = max(0.0, waterBaseY - solidY);

  float waveDisp = evaluateWaveDisplacement(xz, flow, obsGrad, waterDepth);
  float finalY = waterBaseY + waveDisp;

  vec3 displacedPos = vec3(xz.x, finalY, xz.y);
  vec4 worldPosition = modelMatrix * vec4(displacedPos, 1.0);

  vWorldPos = worldPosition.xyz;
  vDomainUV = domainUV;
  vFlow = flow;
  vWaterBaseY = waterBaseY;
  vSolidY = solidY;
  vObsGrad = obsGrad;
  vWaveHeight = waveDisp;

  gl_Position = projectionMatrix * viewMatrix * worldPosition;
  vClipPos = gl_Position;
}
