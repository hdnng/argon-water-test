import * as THREE from 'three';
import { FlowField, STREAM_DOMAIN, fbm2D, pcgHash } from '../water/FlowField';

export interface UnderwaterShaderUniforms {
  uTime: { value: number };
  uCausticsEnabled: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uFlowMap: { value: THREE.Texture };
  uTerrainMap: { value: THREE.Texture };
  uNoiseTex: { value: THREE.Texture };
  uRockDetailTex: { value: THREE.Texture };
}

/**
 * Welds duplicate vertices of a non-indexed BufferGeometry so computeVertexNormals()
 * produces continuous interpolated normals instead of flat low-poly triangle facets.
 */
export function weldGeometryVertices(geo: THREE.BufferGeometry, tolerance = 1e-4): THREE.BufferGeometry {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const vertexCount = posAttr.count;
  const invTol = 1.0 / tolerance;

  const uniquePositions: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<string, number>();

  for (let i = 0; i < vertexCount; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * invTol)}_${Math.round(y * invTol)}_${Math.round(z * invTol)}`;

    let idx = vertexMap.get(key);
    if (idx === undefined) {
      idx = uniquePositions.length / 3;
      uniquePositions.push(x, y, z);
      vertexMap.set(key, idx);
    }
    indices.push(idx);
  }

  const welded = new THREE.BufferGeometry();
  welded.setIndex(indices);
  welded.setAttribute('position', new THREE.Float32BufferAttribute(uniquePositions, 3));
  welded.computeVertexNormals();
  return welded;
}

/**
 * Injects multi-scale PBR river rock & alluvial terrain shading:
 * - Per-rock deterministic variation (pattern orientation, crack density, roughness, moss coverage)
 * - Smooth water-worn stone surfaces with fine mineral grain and sparse localized fractures
 * - 4-zone physical wetness transition (dry -> damp capillary -> wet splash film -> submerged)
 *   without artificial dark base rings
 * - Aperiodic dual-rotated terrain & riverbank detailing with distance-aware filtering
 */
export function enhanceUnderwaterStoneMaterial(
  material: THREE.MeshStandardMaterial,
  uniforms: UnderwaterShaderUniforms,
  isPebbleOrRock = false
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCausticsEnabled = uniforms.uCausticsEnabled;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uFlowMap = uniforms.uFlowMap;
    shader.uniforms.uTerrainMap = uniforms.uTerrainMap;
    shader.uniforms.uNoiseTex = uniforms.uNoiseTex;
    shader.uniforms.uRockDetailTex = uniforms.uRockDetailTex;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      /* glsl */ `
      #include <common>
      ${isPebbleOrRock ? 'attribute vec4 aRockParams;' : ''}
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPos;
      varying vec3 vViewX;
      varying vec3 vViewY;
      varying vec3 vViewZ;
      varying vec4 vRockParams;
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      /* glsl */ `
      #include <worldpos_vertex>
      vec4 wp = modelMatrix * vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      #endif
      vWorldPos = wp.xyz;
      vLocalPos = position;
      mat3 normMat = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        normMat = mat3(modelMatrix * instanceMatrix);
      #endif
      vWorldNormal = normalize(normMat * objectNormal);
      vViewX = (viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
      vViewY = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
      vViewZ = (viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz;

      ${
        isPebbleOrRock
          ? /* glsl */ `
          #ifdef USE_INSTANCING
            float instSeed = instanceMatrix[3][0] * 19.3 + instanceMatrix[3][2] * 37.1;
            vRockParams = vec4(
              instSeed,
              0.12 + 0.20 * fract(sin(instSeed) * 43758.5453),
              0.54 + 0.24 * fract(cos(instSeed * 1.37) * 23421.631),
              0.0
            );
          #else
            vRockParams = aRockParams;
          #endif
          `
          : /* glsl */ `
          vRockParams = vec4(0.0, 0.35, 0.80, 0.0);
          `
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `
      #include <common>
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPos;
      varying vec3 vViewX;
      varying vec3 vViewY;
      varying vec3 vViewZ;
      varying vec4 vRockParams;

      uniform float uTime;
      uniform float uCausticsEnabled;
      uniform vec3 uSunDir;
      uniform sampler2D uFlowMap;
      uniform sampler2D uTerrainMap;
      uniform sampler2D uNoiseTex;
      uniform sampler2D uRockDetailTex;

      // Hardware-filtered dual-layer refractive caustics using precomputed uNoiseTex.a
      float computeFastCaustics(vec3 worldPos, vec2 flowVel, float waterDepth) {
        vec2 lightOffset = uSunDir.xz / max(0.28, uSunDir.y) * waterDepth * 0.44;
        vec2 uv = (worldPos.xz - lightOffset) * 0.25;

        vec2 adv1 = uv - flowVel * (uTime * 0.058) + vec2(uTime * 0.019, -uTime * 0.034);
        vec2 adv2 = uv * 1.39 - flowVel * (uTime * 0.076) + vec2(-uTime * 0.029, uTime * 0.023) + vec2(0.41, 0.27);

        float c1 = texture2D(uNoiseTex, adv1).a;
        float c2 = texture2D(uNoiseTex, adv2).a;

        return (c1 * 0.62 + c2 * 0.56);
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `
      #include <color_fragment>

      vec2 domainUV = vec2(
        (vWorldPos.x - (${STREAM_DOMAIN.minX.toFixed(1)})) / (${STREAM_DOMAIN.width.toFixed(1)}),
        (vWorldPos.z - (${STREAM_DOMAIN.minZ.toFixed(1)})) / (${STREAM_DOMAIN.length.toFixed(1)})
      );
      vec4 flowSample = texture2D(uFlowMap, clamp(domainUV, 0.0, 1.0));
      vec4 terrainSample = texture2D(uTerrainMap, clamp(domainUV, 0.0, 1.0));
      float waterY = terrainSample.g;

      float camDist = length(cameraPosition - vWorldPos);
      float distAtten = 1.0 / (1.0 + camDist * 0.09);

      vec3 Wn = normalize(vWorldNormal);
      vec3 absWn = abs(Wn);
      float topBlend = smoothstep(0.22, 0.74, absWn.y);

      // Low-frequency aperiodic geological weathering noise
      vec4 weatherNoise = texture2D(uNoiseTex, vWorldPos.xz * 0.085 + vec2(vWorldPos.y * 0.22, -vWorldPos.x * 0.04));

      // Per-rock unique UV rotation, scale & offset so every boulder has distinct surface orientation
      float uvAngle = vRockParams.x;
      float cosR = cos(uvAngle);
      float sinR = sin(uvAngle);
      mat2 rockRot = mat2(cosR, -sinR, sinR, cosR);
      float rockScale = 0.44 + 0.22 * fract(uvAngle * 0.3183);
      vec2 rockOffset = vec2(fract(uvAngle * 0.173), fract(uvAngle * 0.419));

      vec2 rawTop = vWorldPos.xz * rockScale + vec2(vLocalPos.y * 0.18, -vLocalPos.y * 0.15);
      vec2 rawSide = vec2(vWorldPos.x * 0.62 + vWorldPos.z * 0.62, vWorldPos.y * 1.15) * rockScale;
      vec2 uvTop = rockRot * rawTop + rockOffset;
      vec2 uvSide = rockRot * rawSide + rockOffset;

      vec4 rockMacroTop = texture2D(uRockDetailTex, uvTop);
      vec4 rockMacroSide = texture2D(uRockDetailTex, uvSide);
      vec4 rockMacro = mix(rockMacroSide, rockMacroTop, topBlend);

      // High-frequency crystalline mineral grain & micro-pores (filtered with distance to prevent shimmering)
      vec2 uvMicro = mix(uvSide, uvTop, topBlend) * 2.85;
      vec4 rockMicro = texture2D(uRockDetailTex, uvMicro);

      float crackDensity = vRockParams.y;
      float baseRoughParam = vRockParams.z;
      float mossCoverageParam = vRockParams.w;

      // Sparse localized crevices: rockMacro.b is ~0.52 on smooth stone faces and < 0.38 only in localized joints
      float rawCrack = smoothstep(0.40, 0.14, rockMacro.b) * crackDensity;
      float microPit = smoothstep(0.36, 0.16, rockMicro.b) * crackDensity * 0.30 * distAtten;
      float sparseCreviceMask = clamp(rawCrack + microPit, 0.0, 0.80);

      float mineralSpeckle = mix(0.5, rockMicro.a, 0.58 + 0.42 * distAtten);

      // Actual water surface elevation with subtle wave lap, turbulence splash, and porous capillary wicking
      float lapWave = 0.009 * sin(uTime * 2.7 + vWorldPos.x * 3.1 - vWorldPos.z * 2.3);
      float rawHeightAboveWater = vWorldPos.y - (waterY + lapWave);
      float splashWick = clamp(flowSample.b, 0.0, 1.0) * 0.048 * (0.45 + 0.55 * weatherNoise.g);
      float capillaryWick = (0.022 + 0.028 * sparseCreviceMask) * (0.55 + 0.45 * weatherNoise.r);
      float heightAboveWater = rawHeightAboveWater - splashWick - capillaryWick;

      ${
        isPebbleOrRock
          ? /* glsl */ `
          // --- Multi-Scale Natural River Boulder & Cobble PBR Material ---
          // 1. Macro Scale: Broad mineral variation & crystalline grain (no periodic sine bands or blue color shifts)
          float grainMod = 0.88 + 0.24 * (mineralSpeckle - 0.5) * (0.65 + 0.35 * distAtten);
          vec3 baseStone = diffuseColor.rgb * grainMod;

          float mineralTone = smoothstep(0.20, 0.80, weatherNoise.r * 0.62 + rockMacro.a * 0.38);
          baseStone *= mix(vec3(0.95, 0.94, 0.93), vec3(1.05, 1.03, 1.00), mineralTone);

          // 2. Medium Scale: Sparse localized erosion cracks & neutral dark mineral joints
          vec3 crackTint = baseStone * vec3(0.54, 0.52, 0.50);
          baseStone = mix(baseStone, crackTint, sparseCreviceMask * 0.62);

          // Occasional thin quartz / feldspar mineral veins (localized, non-uniform)
          float veinMask = smoothstep(0.78, 0.92, rockMacro.b) *
                           smoothstep(0.48, 0.78, weatherNoise.g) *
                           (0.22 + 0.58 * crackDensity);
          vec3 quartzVeinCol = mix(baseStone * 1.22, vec3(0.66, 0.63, 0.58), 0.50);
          baseStone = mix(baseStone, quartzVeinCol, veinMask * 0.36);

          // Occasional darker neutral mineral inclusions
          float darkVein = smoothstep(0.25, 0.13, rockMacro.b) * smoothstep(0.55, 0.82, weatherNoise.r) * crackDensity;
          baseStone = mix(baseStone, baseStone * vec3(0.62, 0.60, 0.58), darkVein * 0.40);

          // Naturally worn, slightly paler mineral edges on upper exposed shoulders
          float wornShoulder = smoothstep(0.25, 0.85, Wn.y) * smoothstep(0.04, 0.28, rawHeightAboveWater) * (1.0 - sparseCreviceMask);
          baseStone = mix(baseStone, baseStone * 1.08 + vec3(0.022, 0.020, 0.017), wornShoulder * 0.30);

          // 3. Irregular alluvial sediment deposits in upward-facing low pockets & concavities
          float sedimentPocket = smoothstep(0.38, 0.86, Wn.y) *
                                 smoothstep(0.16, -0.22, rawHeightAboveWater) *
                                 smoothstep(0.38, 0.74, weatherNoise.b * 0.6 + (1.0 - rockMacro.a) * 0.4);
          vec3 alluvialSilt = vec3(0.38, 0.33, 0.26);
          baseStone = mix(baseStone, alluvialSilt, sedimentPocket * 0.32);

          // 4. Submerged river periphyton / olive-brown mineral microfilm in deeper water
          float submergedBiofilm = smoothstep(-0.04, -0.26, rawHeightAboveWater) *
                                   smoothstep(0.18, 0.82, Wn.y) *
                                   smoothstep(0.35, 0.76, weatherNoise.b);
          baseStone = mix(baseStone, vec3(0.25, 0.26, 0.18), submergedBiofilm * 0.28);

          // 5. Per-rock deterministic alpine moss & lichen on dry upper crowns
          if (mossCoverageParam > 0.02) {
            float upFacing = smoothstep(0.34, 0.76, Wn.y);
            float aboveSplash = smoothstep(0.03, 0.14, heightAboveWater);
            float mossPattern = weatherNoise.b * 0.58 + rockMacro.a * 0.42;
            float mossThreshold = clamp(0.68 - mossCoverageParam * 0.42, 0.24, 0.66);
            float mossMask = upFacing * aboveSplash *
                             smoothstep(mossThreshold, mossThreshold + 0.22, mossPattern) *
                             clamp(mossCoverageParam * 1.25, 0.0, 0.88);
            vec3 mossDark = vec3(0.15, 0.20, 0.10);
            vec3 mossOlive = vec3(0.25, 0.31, 0.15);
            vec3 mossCol = mix(mossDark, mossOlive, smoothstep(0.3, 0.75, rockMicro.a));
            baseStone = mix(baseStone, mossCol, mossMask);
          }

          // 6. Gentle hemisphere grounding (avoids artificial black base outlines!)
          float hemisphereShade = 0.82 + 0.18 * smoothstep(-0.55, 0.28, Wn.y);
          diffuseColor.rgb = baseStone * hemisphereShade;
          `
          : /* glsl */ `
          // --- Non-Repetitive Alluvial Riverbed & Eroded Mountain Bank Material ---
          // Dual-scale aperiodic rotated UV sampling (without wave-slope domain-warp swirls)
          vec4 macroZoneTex = texture2D(uNoiseTex, vWorldPos.xz * 0.038 + vec2(0.17, 0.43));
          vec2 bankWarp = (macroZoneTex.ba - 0.5) * 0.55;
          vec2 warpedXZ = vWorldPos.xz + bankWarp;

          mat2 rotBankA = mat2(0.920, -0.391, 0.391, 0.920); // +23 deg
          mat2 rotBankB = mat2(0.755, 0.656, -0.656, 0.755); // -41 deg
          vec4 bedSampleA = texture2D(uRockDetailTex, (rotBankA * warpedXZ) * 0.34);
          vec4 bedSampleB = texture2D(uRockDetailTex, (rotBankB * warpedXZ) * 0.57 + vec2(0.37, 0.61));
          float zoneBlend = smoothstep(0.28, 0.72, macroZoneTex.b);
          vec4 bedMacro = mix(bedSampleA, bedSampleB, zoneBlend);

          vec4 bedFine = texture2D(uRockDetailTex, (rotBankA * vWorldPos.xz) * 1.35);
          float gravelCrevice = 1.0 - smoothstep(0.40, 0.15, bedFine.b) * 0.34 * distAtten;
          float pebbleGrain = mix(0.5, bedFine.a, 0.68 * distAtten);

          vec3 slateBedrock = vec3(0.27, 0.26, 0.25);
          vec3 warmRiverGravel = vec3(0.42, 0.35, 0.27);
          vec3 weatheredSandstone = vec3(0.46, 0.38, 0.29);
          vec3 alluvialSandSilt = vec3(0.48, 0.41, 0.32);
          vec3 erodedEarthLoam = vec3(0.32, 0.27, 0.21);
          vec3 upperBankShale = vec3(0.36, 0.34, 0.30);

          // Channel bed variation: scoured slate bedrock in fast chutes, warm cobble/gravel bars, and fine sand in slow eddies
          vec3 bedCol = mix(slateBedrock, warmRiverGravel, smoothstep(0.28, 0.72, bedMacro.a));
          bedCol = mix(bedCol, weatheredSandstone, smoothstep(0.42, 0.80, weatherNoise.b) * 0.45);

          float slowEddy = smoothstep(1.15, 0.30, length(flowSample.rg));
          float siltDeposit = slowEddy * smoothstep(0.34, 0.70, macroZoneTex.a);
          bedCol = mix(bedCol, alluvialSandSilt, siltDeposit * 0.58);

          // Natural gravel & sediment collar around boulder bases (subtle mineral transition, NO black halo!)
          float boulderCollar = (1.0 - smoothstep(-0.02, 0.36, flowSample.a)) * smoothstep(0.25, 0.75, bedFine.a);
          bedCol = mix(bedCol, warmRiverGravel * 1.06, boulderCollar * 0.38);

          // Riverbank transition above waterline: differentiate steep eroded earth/stone slopes from flatter mossy terraces
          float bankHeightMask = smoothstep(0.02, 0.38, rawHeightAboveWater);
          float bankSlope = 1.0 - clamp(Wn.y, 0.0, 1.0);
          float erosionStrata = smoothstep(0.30, 0.72, bedMacro.b * 0.6 + weatherNoise.r * 0.4);
          vec3 slopeEarth = mix(erodedEarthLoam, upperBankShale, erosionStrata);

          // Patchy, non-repetitive upland bank moss only on flatter, damp-shaded bank terraces
          float terraceMossMask = smoothstep(0.18, 0.04, bankSlope) *
                                  smoothstep(0.48, 0.78, macroZoneTex.b * 0.6 + weatherNoise.b * 0.4);
          vec3 bankSurfaceCol = mix(slopeEarth, vec3(0.20, 0.26, 0.13), terraceMossMask * 0.56);
          bedCol = mix(bedCol, bankSurfaceCol, bankHeightMask * 0.85);

          // Subtle granular relief & gentle boulder-bed contact shading (0.82 min prevents dark outlines)
          bedCol *= gravelCrevice * (0.88 + 0.24 * pebbleGrain);
          float boulderContactAO = 0.82 + 0.18 * smoothstep(-0.02, 0.18, flowSample.a);
          diffuseColor.rgb *= bedCol * boulderContactAO * 1.24;
          `
      }

      // --- Physically Grounded 4-Zone Wet / Damp / Waterline / Submerged Transition ---
      // Zone 1: Dry (> +9cm) | Zone 2: Damp capillary (+2..+9cm) | Zone 3: Wet splash film (-2..+2cm) | Zone 4: Submerged (< 0cm)
      float dampZone = 1.0 - smoothstep(0.005, 0.095, heightAboveWater);
      float activeWaterline = exp(-pow(heightAboveWater / 0.032, 2.0));
      float submergedZone = 1.0 - smoothstep(-0.025, 0.015, rawHeightAboveWater);

      // Porous stone darkens smoothly and gains richer mineral saturation when wet (never crushes to black!)
      float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
      vec3 chromaBoosted = mix(vec3(luma), diffuseColor.rgb, 1.14);
      float darkenFactor = mix(1.0, 0.66, dampZone * 0.85) * (1.0 - 0.07 * activeWaterline);
      vec3 wetStoneCol = max(vec3(0.045), chromaBoosted * darkenFactor);

      // Subtle underwater spectral depth tint on deeply submerged stone surfaces
      if (rawHeightAboveWater < 0.0) {
        float subDepth = clamp(-rawHeightAboveWater, 0.0, 0.85);
        vec3 subAtten = exp(-vec3(0.38, 0.14, 0.12) * subDepth);
        wetStoneCol *= mix(vec3(1.0), subAtten, 0.65);
      }

      float totalWetBlend = clamp(max(dampZone, submergedZone), 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, wetStoneCol, totalWetBlend);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
      #include <roughnessmap_fragment>
      // Per-rock dry roughness modulated by crystalline mineral grain and localized crevices
      float dryRough = clamp(
        baseRoughParam + (0.5 - mineralSpeckle) * 0.16 + sparseCreviceMask * 0.14,
        0.48,
        0.94
      );
      // Damp capillary zone transitions smoothly to a glossy thin water film right at the waterline
      float dampRough = mix(dryRough, 0.34, dampZone * 0.75);
      float wetFilmMask = (1.0 - smoothstep(-0.01, 0.045, heightAboveWater)) * smoothstep(-0.04, 0.01, rawHeightAboveWater);
      float waterlineRough = mix(dampRough, 0.14 + 0.06 * rockMicro.a, wetFilmMask * 0.88);

      // Submerged stone has softer underwater micro-roughness
      roughnessFactor = mix(waterlineRough, 0.38, submergedZone * 0.72);
      roughnessFactor = clamp(roughnessFactor, 0.10, 0.94);
      `
    );

    // Distance-filtered, per-rock scaled tri-planar analytical normal mapping (smooth on water-worn faces!)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #include <normal_fragment_maps>
      float microWeight = 0.38 * distAtten;
      vec2 slopeTop = (rockMacroTop.rg * 2.0 - 1.0) * 0.72 + (rockMicro.rg * 2.0 - 1.0) * microWeight;
      vec2 slopeSide = (rockMacroSide.rg * 2.0 - 1.0) * 0.76 + (rockMicro.rg * 2.0 - 1.0) * microWeight;

      vec3 worldPerturbTop = vec3(-slopeTop.x, 0.0, -slopeTop.y);
      vec3 worldPerturbSide = vec3(-slopeSide.x * Wn.z, -slopeSide.y, slopeSide.x * Wn.x);
      vec3 worldPerturb = mix(worldPerturbSide, worldPerturbTop, topBlend);

      // Project perturbation orthogonal to world normal
      worldPerturb -= Wn * dot(worldPerturb, Wn);

      vec3 viewPerturb = vViewX * worldPerturb.x + vViewY * worldPerturb.y + vViewZ * worldPerturb.z;
      float perRockBump = ${isPebbleOrRock ? '(0.34 + 0.36 * crackDensity)' : '0.42'} * (0.55 + 0.45 * distAtten);
      normal = normalize(normal + viewPerturb * perRockBump);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      /* glsl */ `
      #include <lights_fragment_end>
      if (uCausticsEnabled > 0.5 && rawHeightAboveWater < 0.0) {
        float waterDepth = -rawHeightAboveWater;
        float focusRamp = smoothstep(0.012, 0.085, waterDepth);
        float depthAtten = exp(-waterDepth * 1.75);
        float sunFacing = max(0.0, dot(normalize(vWorldNormal), normalize(uSunDir)));
        float turbDamp = 1.0 / (1.0 + flowSample.b * 1.15);

        float causticVal = computeFastCaustics(vWorldPos, flowSample.rg, waterDepth);
        vec3 causticLight = vec3(0.98, 0.92, 0.76) * causticVal * focusRamp * depthAtten * sunFacing * turbDamp * 0.86;
        reflectedLight.directDiffuse += causticLight * diffuseColor.rgb;
      }
      `
    );
  };
}

export class Riverbed {
  public readonly group: THREE.Group;
  public readonly bedMesh: THREE.Mesh;
  public readonly pebbleInstancedMesh: THREE.InstancedMesh;
  private readonly bedMaterial: THREE.MeshStandardMaterial;
  private readonly pebbleMaterial: THREE.MeshStandardMaterial;

  constructor(
    flowField: FlowField,
    segmentsX: number,
    segmentsZ: number,
    pebbleCount: number,
    sharedUniforms: UnderwaterShaderUniforms,
    envMap: THREE.CubeTexture
  ) {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;

    this.bedMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.03,
      envMap,
      envMapIntensity: 0.48
    });
    enhanceUnderwaterStoneMaterial(this.bedMaterial, sharedUniforms, false);

    this.pebbleMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.04,
      envMap,
      envMapIntensity: 0.56
    });
    enhanceUnderwaterStoneMaterial(this.pebbleMaterial, sharedUniforms, true);

    const bedGeo = this.buildBedGeometry(flowField, segmentsX, segmentsZ);
    this.bedMesh = new THREE.Mesh(bedGeo, this.bedMaterial);
    this.bedMesh.receiveShadow = true;
    this.bedMesh.castShadow = false;
    this.bedMesh.renderOrder = -1;
    this.bedMesh.matrixAutoUpdate = false;
    this.bedMesh.updateMatrix();
    this.group.add(this.bedMesh);

    const pebbleGeo = this.buildPebblePrototypeGeometry();
    this.pebbleInstancedMesh = new THREE.InstancedMesh(pebbleGeo, this.pebbleMaterial, 2600);
    this.pebbleInstancedMesh.receiveShadow = true;
    this.pebbleInstancedMesh.castShadow = false;
    this.pebbleInstancedMesh.renderOrder = -2;
    this.pebbleInstancedMesh.matrixAutoUpdate = false;
    this.pebbleInstancedMesh.updateMatrix();
    this.populatePebbles(flowField, pebbleCount);
    this.group.add(this.pebbleInstancedMesh);
  }

  private buildBedGeometry(
    flowField: FlowField,
    segmentsX: number,
    segmentsZ: number
  ): THREE.BufferGeometry {
    const geo = new THREE.PlaneGeometry(
      STREAM_DOMAIN.width,
      STREAM_DOMAIN.length,
      segmentsX,
      segmentsZ
    );
    geo.rotateX(-Math.PI / 2);

    const posAttr = geo.attributes.position as THREE.BufferAttribute;
    const count = posAttr.count;
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const x = posAttr.getX(i);
      const z = posAttr.getZ(i);
      const y = flowField.getRiverbedHeight(x, z);
      posAttr.setY(i, y);

      const waterY = flowField.getBaseWaterHeight(x, z);
      const depth = waterY - y;
      // Low-frequency domain-warped vertex tinting to break up large-scale terrain uniformity
      const wx = x + fbm2D(x * 0.22 + 3.1, z * 0.22 - 1.9, 2) * 0.85;
      const wz = z + fbm2D(x * 0.22 - 4.7, z * 0.22 + 2.8, 2) * 0.85;
      const n = fbm2D(wx * 0.42 + 1.9, wz * 0.38 - 3.7, 3);
      const n2 = fbm2D(wx * 0.95 - 2.3, wz * 0.95 + 4.1, 2);

      let r = 0.74 + 0.14 * n + 0.06 * n2;
      let g = 0.69 + 0.12 * n + 0.05 * n2;
      let b = 0.62 + 0.10 * n + 0.04 * n2;

      if (depth < -0.06) {
        const bankT = Math.min(1.0, (-depth - 0.06) / 0.46);
        r = r * (1.0 - 0.20 * bankT);
        g = g * (1.0 - 0.12 * bankT);
        b = b * (1.0 - 0.24 * bankT);
      }

      colors[i * 3 + 0] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.bedMaterial.vertexColors = true;
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Builds a welded 80-triangle river cobble prototype with natural water-worn facets
   * and flattened river-stone proportions.
   */
  private buildPebblePrototypeGeometry(): THREE.BufferGeometry {
    const rawGeo = new THREE.IcosahedronGeometry(1.0, 1);
    const welded = weldGeometryVertices(rawGeo);
    rawGeo.dispose();

    const pos = welded.attributes.position as THREE.BufferAttribute;
    const rockParams = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      let vx = pos.getX(i);
      let vy = pos.getY(i);
      let vz = pos.getZ(i);
      // Stream-worn river cobble: smoothly flattened with subtle facet beveling
      vy *= vy < 0.0 ? 0.46 : 0.56;
      vx *= 1.0 + 0.14 * vz;
      const bevel = 1.0 - Math.max(0.0, Math.abs(vx * 0.6 + vz * 0.6) - 0.45) * 0.16;
      vx *= bevel;
      vy *= bevel;
      vz *= bevel;
      pos.setXYZ(i, vx, vy, vz);

      rockParams[i * 4 + 0] = 0.0;
      rockParams[i * 4 + 1] = 0.22;
      rockParams[i * 4 + 2] = 0.62;
      rockParams[i * 4 + 3] = 0.0;
    }
    welded.setAttribute('aRockParams', new THREE.BufferAttribute(rockParams, 4));
    welded.computeVertexNormals();
    return welded;
  }

  /**
   * Distributes river pebbles using natural alluvial bar clustering, boulder leeward scree pockets,
   * and current-aligned imbrication (zero repetitive rows or uniform grid spacing).
   */
  private populatePebbles(flowField: FlowField, activeCount: number): void {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    // Coherent 12-tone mountain river mineral palette matching the 5 boulder families
    const palette = [
      [0.46, 0.38, 0.29], // Warm sedimentary sandstone
      [0.31, 0.30, 0.29], // Dark weathered slate
      [0.54, 0.49, 0.43], // Smooth pale granodiorite
      [0.26, 0.25, 0.24], // Dark wet mineral basalt
      [0.42, 0.35, 0.27], // Sienna river cobble
      [0.34, 0.35, 0.31], // Olive-gray greywacke
      [0.56, 0.51, 0.45], // Pale quartzite river stone
      [0.38, 0.31, 0.24], // Weathered gneiss
      [0.28, 0.30, 0.28], // Dark greenstone
      [0.48, 0.43, 0.37], // Buff river granodiorite
      [0.31, 0.28, 0.25], // Charcoal-brown shale
      [0.44, 0.37, 0.28]  // Warm taupe river cobble
    ];

    const maxInstances = 2600;
    for (let i = 0; i < maxInstances; i++) {
      const r1 = pcgHash(i * 17 + 101);
      const r2 = pcgHash(i * 31 + 202);
      const r3 = pcgHash(i * 47 + 303);
      const r4 = pcgHash(i * 61 + 404);
      const r5 = pcgHash(i * 79 + 505);
      const r6 = pcgHash(i * 97 + 606);

      let x: number;
      let z: number;

      // 42% of cobbles accumulate naturally in gravel collars and leeward scree shadows around boulders
      if (r4 < 0.42 && flowField.rocks.length > 0) {
        const rock = flowField.rocks[Math.floor(r5 * flowField.rocks.length)];
        const angle = r1 * Math.PI * 2.0;
        const radial = (0.68 + Math.pow(r2, 1.15) * 1.85) * Math.max(rock.radiusX, rock.radiusZ);
        x = rock.x + Math.cos(angle) * radial + (r6 - 0.5) * 0.25;
        z = rock.z + Math.sin(angle) * radial + 0.28 * r3;
      } else {
        // Domain-warped alluvial gravel patches across foreground & midground (z in [-5.5, +8.5])
        const zRaw = r1 < 0.76
          ? -5.0 + pcgHash(i * 89 + 77) * 12.2
          : STREAM_DOMAIN.minZ + 0.5 + r1 * (STREAM_DOMAIN.length - 1.0);
        z = Math.max(STREAM_DOMAIN.minZ + 0.5, Math.min(STREAM_DOMAIN.maxZ - 0.5, zRaw));

        const center = flowField.getChannelCenter(z);
        const halfWidth = flowField.getChannelHalfWidth(z);
        const barShift = fbm2D(z * 0.45 + 2.1, i * 0.01, 2) * 0.42;
        const signedSpread = (r2 - 0.5) * 2.0 + (r5 - 0.5) * 0.55 + barShift;
        x = center + signedSpread * halfWidth * 1.15;
      }

      x = Math.max(STREAM_DOMAIN.minX + 0.4, Math.min(STREAM_DOMAIN.maxX - 0.4, x));
      z = Math.max(STREAM_DOMAIN.minZ + 0.4, Math.min(STREAM_DOMAIN.maxZ - 0.4, z));

      const bedY = flowField.getRiverbedHeight(x, z);

      // Power-law size distribution: abundant fine/medium gravel, fewer large river cobbles
      const sizeSkew = Math.pow(r3, 2.55);
      const baseScale = 0.032 + sizeSkew * 0.185;
      const sx = baseScale * (0.76 + 0.52 * r4);
      const sy = baseScale * (0.42 + 0.32 * r5);
      const sz = baseScale * (0.76 + 0.52 * r6);

      // Natural imbrication: river current tilts flat cobbles slightly downstream
      dummy.position.set(x, bedY + sy * 0.18, z);
      dummy.rotation.set(
        -0.18 + (r2 - 0.5) * 0.36,
        r1 * Math.PI * 2.0,
        (r3 - 0.5) * 0.36
      );
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      this.pebbleInstancedMesh.setMatrixAt(i, dummy.matrix);

      const baseCol = palette[Math.floor((r4 * 13.0 + r6 * 7.0)) % palette.length];
      const shade = 0.80 + 0.40 * r5;
      color.setRGB(baseCol[0] * shade, baseCol[1] * shade, baseCol[2] * shade);
      this.pebbleInstancedMesh.setColorAt(i, color);
    }

    this.pebbleInstancedMesh.count = Math.min(maxInstances, activeCount);
    this.pebbleInstancedMesh.instanceMatrix.needsUpdate = true;
    if (this.pebbleInstancedMesh.instanceColor) {
      this.pebbleInstancedMesh.instanceColor.needsUpdate = true;
    }
  }

  public updateQuality(
    flowField: FlowField,
    segmentsX: number,
    segmentsZ: number,
    pebbleCount: number
  ): void {
    this.pebbleInstancedMesh.count = Math.min(2600, pebbleCount);
    const oldGeo = this.bedMesh.geometry;
    this.bedMesh.geometry = this.buildBedGeometry(flowField, segmentsX, segmentsZ);
    oldGeo.dispose();
  }

  public dispose(): void {
    this.bedMesh.geometry.dispose();
    this.bedMaterial.dispose();
    this.pebbleInstancedMesh.geometry.dispose();
    this.pebbleMaterial.dispose();
  }
}
