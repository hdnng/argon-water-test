import * as THREE from 'three';
import { FlowField, STREAM_DOMAIN, fbm2D, pcgHash } from '../water/FlowField';

export interface UnderwaterShaderUniforms {
  uTime: { value: number };
  uCausticsEnabled: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uFlowMap: { value: THREE.Texture };
  uTerrainMap: { value: THREE.Texture };
  uNoiseTex: { value: THREE.Texture };
  uRockAlbedoTex: { value: THREE.Texture };
  uRockNormalTex: { value: THREE.Texture };
  uRockArmTex: { value: THREE.Texture };
  uTerrainAlbedoTex: { value: THREE.Texture };
  uTerrainNormalTex: { value: THREE.Texture };
  uTerrainArmTex: { value: THREE.Texture };
  uMaterialDebugMode?: { value: number };
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
 * Injects optimized, photogrammetry-based PBR shading using real CC0 Poly Haven texture sets:
 * - Boulders & Cobbles (isPebbleOrRock = true): uRockAlbedoTex, uRockNormalTex, uRockArmTex
 *   configured into 3 distinct geological families (Weathered Granite, Dark Water-Worn Stone, Natural Sedimentary Stone)
 * - Riverbank & Riverbed Terrain (isPebbleOrRock = false): uTerrainAlbedoTex, uTerrainNormalTex, uTerrainArmTex
 *   configured for compacted soil, fine gravel coloration, natural erosion zones, and smooth waterline transitions.
 * - Uses 100% linear/affine vertex-interpolated UVs (zero per-vertex division or triplanar overhead) for maximum L1 texture cache coherence.
 * - Supports 4-stage Material Ablation Test via uMaterialDebugMode:
 *   0 = Config D (Full Optimized PBR with Albedo, Normal, ARM Roughness/AO & Wetness)
 *   1 = Config A (Simple PBR without texture maps)
 *   2 = Config B (PBR with Albedo maps only)
 *   3 = Config C (PBR with Albedo and Normal maps)
 *   4 = Unlit Albedo Inspection | 5 = Normal Inspection | 6 = Roughness Inspection | 7 = AO/Wetness Inspection
 */
export function enhanceUnderwaterStoneMaterial(
  material: THREE.MeshStandardMaterial,
  uniforms: UnderwaterShaderUniforms,
  isPebbleOrRock = false
): void {
  if (!uniforms.uMaterialDebugMode) {
    uniforms.uMaterialDebugMode = { value: 0 };
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCausticsEnabled = uniforms.uCausticsEnabled;
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uFlowMap = uniforms.uFlowMap;
    shader.uniforms.uTerrainMap = uniforms.uTerrainMap;
    shader.uniforms.uNoiseTex = uniforms.uNoiseTex;
    shader.uniforms.uMaterialDebugMode = uniforms.uMaterialDebugMode!;

    if (isPebbleOrRock) {
      shader.uniforms.uRockAlbedoTex = uniforms.uRockAlbedoTex;
      shader.uniforms.uRockNormalTex = uniforms.uRockNormalTex;
      shader.uniforms.uRockArmTex = uniforms.uRockArmTex;
    } else {
      shader.uniforms.uTerrainAlbedoTex = uniforms.uTerrainAlbedoTex;
      shader.uniforms.uTerrainNormalTex = uniforms.uTerrainNormalTex;
      shader.uniforms.uTerrainArmTex = uniforms.uTerrainArmTex;
    }

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
      varying vec2 vPrimaryUv;
      varying vec2 vDetailUv;
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
            // Small submerged & shoreline gravel cobbles
            float instSeed = instanceMatrix[3][0] * 19.3 + instanceMatrix[3][2] * 37.1;
            float instFam = floor(fract(sin(instSeed * 0.713) * 43758.5453) * 3.0);
            vRockParams = vec4(
              0.68,
              instFam,
              0.24 + 0.18 * fract(cos(instSeed * 1.37) * 23421.631),
              0.0
            );
            vPrimaryUv = wp.xz * 1.35 + vec2(fract(instSeed * 0.173), fract(instSeed * 0.419));
            vDetailUv = wp.xz * 3.10 + vec2(fract(instSeed * 0.587), fract(instSeed * 0.293));
          #else
            // Sculpted River Boulders: 100% linear/affine planar UVs with elevation shear
            // Eliminates non-linear domeDenom division and prevents mipmap cache thrashing on steep sides
            float uvAngle = aRockParams.x;
            float familyId = aRockParams.y;
            float cosR = cos(uvAngle);
            float sinR = sin(uvAngle);
            mat2 rockRot = mat2(cosR, -sinR, sinR, cosR);
            float rockScale = 0.78 + 0.28 * fract(uvAngle * 0.3183);
            vec2 rockOffset = vec2(fract(uvAngle * 0.173), fract(uvAngle * 0.419));

            vec2 linearPlanar = position.xz + position.y * vec2(0.36, -0.28);
            vec2 anisoScale = familyId > 1.5 ? vec2(0.82, 1.55) : vec2(1.0, 1.0);
            vPrimaryUv = (rockRot * linearPlanar) * rockScale * anisoScale + rockOffset;
            mat2 microRot = mat2(0.7986, -0.6018, 0.6018, 0.7986);
            vDetailUv = (microRot * linearPlanar) * (rockScale * 2.15) + rockOffset * 1.7 + vec2(0.23, 0.67);

            float baseWear = familyId < 0.5 ? 0.42 : (familyId < 1.5 ? 0.64 : 0.36);
            float streamWear = clamp(baseWear * (0.72 + 0.38 * smoothstep(-0.2, 0.7, vWorldNormal.y - 0.22 * vWorldNormal.z)), 0.12, 0.84);
            vRockParams = vec4(streamWear, familyId, aRockParams.z, aRockParams.w);
          #endif
          `
          : /* glsl */ `
          // Riverbank & Riverbed Terrain: linear world-space rotated UVs with slope offset
          vRockParams = vec4(0.0, 0.0, 0.30, 0.0);
          mat2 rotBankA = mat2(0.9205, -0.3907, 0.3907, 0.9205); // +23 deg
          mat2 rotBankB = mat2(0.7547, 0.6561, -0.6561, 0.7547); // -41 deg
          vec2 worldPlanar = wp.xz + wp.y * vec2(0.28, -0.22);
          vPrimaryUv = (rotBankA * worldPlanar) * 0.46;
          vDetailUv = (rotBankB * worldPlanar) * 1.58 + vec2(0.29, 0.53);
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
      varying vec2 vPrimaryUv;
      varying vec2 vDetailUv;

      uniform float uTime;
      uniform float uCausticsEnabled;
      uniform vec3 uSunDir;
      uniform sampler2D uFlowMap;
      uniform sampler2D uTerrainMap;
      uniform sampler2D uNoiseTex;
      uniform float uMaterialDebugMode;
      ${
        isPebbleOrRock
          ? /* glsl */ `
          uniform sampler2D uRockAlbedoTex;
          uniform sampler2D uRockNormalTex;
          uniform sampler2D uRockArmTex;
          `
          : /* glsl */ `
          uniform sampler2D uTerrainAlbedoTex;
          uniform sampler2D uTerrainNormalTex;
          uniform sampler2D uTerrainArmTex;
          `
      }

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
      float distAtten = 1.0 / (1.0 + camDist * 0.08);

      vec3 Wn = normalize(vWorldNormal);

      // Actual water surface elevation with subtle wave lap
      float lapWave = 0.009 * sin(uTime * 2.5 + vWorldPos.x * 2.8 - vWorldPos.z * 2.3);
      float rawHeightAboveWater = vWorldPos.y - (waterY + lapWave);

      // 4-Stage Ablation switches (0 = Full PBR Config D, 1 = No Maps Config A, 2 = Albedo Only Config B, 3 = Albedo+Normal Config C)
      bool enableAlbedoMaps = (uMaterialDebugMode < 0.5 || uMaterialDebugMode > 1.5);
      bool enableNormalMaps = (uMaterialDebugMode < 0.5 || uMaterialDebugMode > 2.5);
      bool enableRoughnessWetness = (uMaterialDebugMode < 0.5 || uMaterialDebugMode > 3.5);

      float baseRoughParam = 0.72;
      float mineralSpeckle = 0.5;
      float sparseCreviceMask = 0.0;
      float wetPatchSignal = 0.5;
      float dbgStructureVal = 0.75;
      vec3 dbgNormalVis = Wn;
      vec2 combinedNormalSlope = vec2(0.0);

      ${
        isPebbleOrRock
          ? /* glsl */ `
          // ============================================================================
          // BOULDER & COBBLE PHOTOGRAMMETRY PBR MATERIAL (Poly Haven CC0 rock_boulder_dry)
          // ============================================================================
          float surfaceWear = vRockParams.x;
          float familyId = vRockParams.y;
          float crackDensity = vRockParams.z;
          float mossCoverageParam = vRockParams.w;

          vec3 baseStone = diffuseColor.rgb;

          if (enableAlbedoMaps) {
            vec3 albPrimary = texture2D(uRockAlbedoTex, vPrimaryUv).rgb;
            vec3 albDetail = texture2D(uRockAlbedoTex, vDetailUv).rgb;
            vec3 photoScan = mix(albPrimary, albDetail, 0.38 * (0.65 + 0.35 * distAtten));

            // Sample low-frequency macro variation from shared L1-cached noise texture
            vec4 macroNoise = texture2D(uNoiseTex, vWorldPos.xz * 0.075 + vec2(0.19, 0.47));
            float macroZone = macroNoise.b;
            wetPatchSignal = macroZone * 0.55 + photoScan.r * 0.45;

            // Normalize photogrammetry scan around its mean color (0.57, 0.53, 0.49) to preserve
            // authentic mineral grain, feldspar/quartz patches & weathering while respecting family palettes
            vec3 photoRatio = clamp(photoScan / vec3(0.57, 0.53, 0.49), 0.48, 1.52);
            float photoLuma = dot(photoScan, vec3(0.299, 0.587, 0.114));
            mineralSpeckle = clamp((photoLuma - 0.34) / 0.44, 0.0, 1.0);

            float photoAO = 0.86;
            float photoRough = 0.72;
            if (enableRoughnessWetness) {
              vec3 armSample = texture2D(uRockArmTex, vPrimaryUv).rgb;
              photoAO = armSample.r;
              photoRough = armSample.g;
            }
            dbgStructureVal = photoAO;

            // --- 3 Distinct Geological Rock Material Families ---
            if (familyId < 0.5) {
              // Family 0: Weathered Granite
              // Medium gray, crisp mineral grain, fine surface irregularities, moderate roughness, shallow fractures
              vec3 coolGranite = baseStone * vec3(0.95, 0.96, 0.98);
              vec3 warmGranite = baseStone * vec3(1.07, 1.02, 0.95);
              baseStone = mix(coolGranite, warmGranite, smoothstep(0.32, 0.68, macroZone));
              baseStone *= mix(vec3(1.0), photoRatio, 0.85);
              baseRoughParam = mix(0.66, 0.84, photoRough) - 0.08 * surfaceWear;
            } else if (familyId < 1.5) {
              // Family 1: Dark Water-Worn Stone
              // Charcoal gray, slightly smoother water-polished appearance, irregular mineral coloring, subtle roughness variation
              vec3 charcoalStone = baseStone * vec3(0.84, 0.87, 0.90);
              vec3 siennaVein = vec3(0.35, 0.29, 0.24) * (0.85 + 0.30 * photoLuma);
              baseStone = mix(charcoalStone, siennaVein, smoothstep(0.44, 0.76, macroZone) * 0.40);
              baseStone *= mix(vec3(1.0), photoRatio, 0.68);
              baseRoughParam = mix(0.48, 0.65, photoRough) - 0.08 * surfaceWear;
            } else {
              // Family 2: Natural Sedimentary Stone
              // Muted brown-gray, sparse geological layering, fine granular detail, natural erosion marks
              float layerGate = smoothstep(0.34, 0.72, macroZone);
              float strataPhase = vLocalPos.y * 2.3 + vLocalPos.x * 0.55 + (photoLuma - 0.5) * 0.9;
              float broadStrata = smoothstep(-0.38, 0.38, sin(strataPhase)) * layerGate;
              vec3 warmStrata = baseStone * vec3(1.09, 1.01, 0.90);
              vec3 coolStrata = baseStone * vec3(0.87, 0.88, 0.90);
              baseStone = mix(coolStrata, warmStrata, broadStrata);
              baseStone *= mix(vec3(1.0), photoRatio, 0.80);
              baseRoughParam = mix(0.68, 0.86, photoRough) - 0.10 * surfaceWear;
            }

            // Photogrammetry crevice Ambient Occlusion & shallow fracture darkening
            float creviceAO = clamp(0.45 + photoAO * 0.62, 0.52, 1.04);
            sparseCreviceMask = clamp((1.0 - creviceAO) * (0.75 + 0.50 * crackDensity), 0.0, 0.75);
            baseStone *= mix(1.0, creviceAO, 0.78);

            // Sun-warmed dry upper crown vs sediment-settled lower hollows
            float wornCrown = smoothstep(0.24, 0.82, Wn.y) * smoothstep(0.03, 0.25, rawHeightAboveWater) * surfaceWear;
            baseStone = mix(baseStone, baseStone * 1.08 + vec3(0.016, 0.015, 0.012), wornCrown * 0.34);

            float siltHollow = smoothstep(0.36, 0.84, Wn.y) *
                               smoothstep(0.18, -0.16, rawHeightAboveWater) *
                               smoothstep(0.68, 0.38, photoAO);
            baseStone = mix(baseStone, vec3(0.39, 0.34, 0.27), siltHollow * 0.38);

            // Subtle submerged river periphyton microfilm in deeper water
            float submergedBiofilm = smoothstep(-0.03, -0.24, rawHeightAboveWater) *
                                     smoothstep(0.14, 0.80, Wn.y) *
                                     smoothstep(0.35, 0.72, macroZone);
            baseStone = mix(baseStone, vec3(0.24, 0.26, 0.17), submergedBiofilm * 0.34);

            // Localized damp moss on moss-bearing boulders
            if (mossCoverageParam > 0.02) {
              float upFacing = smoothstep(0.28, 0.76, Wn.y + 0.15 * (0.65 - photoAO));
              float dampHeight = smoothstep(-0.02, 0.05, rawHeightAboveWater) *
                                 (1.0 - 0.35 * smoothstep(0.14, 0.48, rawHeightAboveWater));
              float mossPattern = macroZone * 0.55 + (1.0 - photoAO) * 0.45;
              float mossThresh = clamp(0.64 - mossCoverageParam * 0.42, 0.22, 0.62);
              float mossMask = upFacing * dampHeight *
                               smoothstep(mossThresh, mossThresh + 0.18, mossPattern) *
                               clamp(mossCoverageParam * 1.25, 0.0, 0.86);
              vec3 mossCol = mix(vec3(0.15, 0.22, 0.09), vec3(0.25, 0.33, 0.14), mineralSpeckle);
              baseStone = mix(baseStone, mossCol, mossMask);
              baseRoughParam = mix(baseRoughParam, 0.86, mossMask * 0.75);
            }
          }

          float hemisphereShade = 0.85 + 0.15 * smoothstep(-0.55, 0.28, Wn.y);
          diffuseColor.rgb = baseStone * hemisphereShade;

          if (enableNormalMaps) {
            vec2 nPrimary = texture2D(uRockNormalTex, vPrimaryUv).rg * 2.0 - 1.0;
            vec2 nDetail = texture2D(uRockNormalTex, vDetailUv).rg * 2.0 - 1.0;
            float familyNormScale = familyId < 0.5 ? 0.82 : (familyId < 1.5 ? 0.52 : 0.76);
            float wearAtten = 1.0 - 0.35 * surfaceWear;
            combinedNormalSlope = (nPrimary * 0.68 + nDetail * 0.38 * distAtten) * familyNormScale * wearAtten;
          }
          `
          : /* glsl */ `
          // ============================================================================
          // DEDICATED TERRAIN PHOTOGRAMMETRY PBR MATERIAL (Poly Haven CC0 dirt_aerial_03)
          // Compacted soil, fine gravel coloration, natural erosion zones, smooth waterline transitions
          // ============================================================================
          float bankSlope = 1.0 - clamp(Wn.y, 0.0, 1.0);
          float bankHeightMask = smoothstep(-0.02, 0.24, rawHeightAboveWater);

          if (enableAlbedoMaps) {
            vec3 tAlbPrimary = texture2D(uTerrainAlbedoTex, vPrimaryUv).rgb;
            vec3 tAlbDetail = texture2D(uTerrainAlbedoTex, vDetailUv).rgb;
            vec3 tScan = mix(tAlbPrimary, tAlbDetail, 0.42 * (0.65 + 0.35 * distAtten));

            vec4 macroNoise = texture2D(uNoiseTex, vWorldPos.xz * 0.062 + vec2(0.17, 0.43));
            float macroZone = macroNoise.b;
            wetPatchSignal = macroZone * 0.55 + tScan.r * 0.45;

            // Normalize photogrammetry soil/gravel scan around its mean color (0.45, 0.38, 0.31)
            vec3 tRatio = clamp(tScan / vec3(0.45, 0.38, 0.31), 0.52, 1.48);
            float tLuma = dot(tScan, vec3(0.299, 0.587, 0.114));
            mineralSpeckle = clamp((tLuma - 0.24) / 0.42, 0.0, 1.0);

            float tAO = 0.88;
            float tRough = 0.82;
            if (enableRoughnessWetness) {
              vec3 tArm = texture2D(uTerrainArmTex, vPrimaryUv).rgb;
              tAO = clamp(0.50 + tArm.r * 0.55, 0.58, 1.04);
              tRough = tArm.g;
            }
            dbgStructureVal = tAO;

            // Submerged Riverbed: scoured dark slate, warm alluvial gravel, and eddy sand pockets
            vec3 scouredSlate = vec3(0.25, 0.28, 0.30);
            vec3 riverGravelCol = vec3(0.43, 0.36, 0.28);
            vec3 eddySandCol = vec3(0.49, 0.42, 0.33);

            vec3 submergedBedCol = mix(scouredSlate, riverGravelCol, smoothstep(0.28, 0.68, macroZone));
            float slowEddy = smoothstep(1.15, 0.28, length(flowSample.rg));
            submergedBedCol = mix(submergedBedCol, eddySandCol, slowEddy * smoothstep(0.38, 0.70, macroZone) * 0.55);

            // Natural gravel collar around embedded boulder bases
            float boulderCollar = 1.0 - smoothstep(-0.02, 0.36, flowSample.a);
            submergedBedCol = mix(submergedBedCol, riverGravelCol * 1.08, boulderCollar * 0.38);
            submergedBedCol *= mix(vec3(1.0), tRatio, 0.80);

            // Exposed Riverbanks: compacted soil, fine gravel coloration, and natural slope erosion zones
            vec3 compactedLoam = vec3(0.36, 0.30, 0.23);
            vec3 fineGravelSoil = vec3(0.44, 0.37, 0.29);
            vec3 erodedBankEarth = vec3(0.29, 0.24, 0.19);

            vec3 bankSoilCol = mix(compactedLoam, fineGravelSoil, smoothstep(0.30, 0.70, macroZone));
            float erosionZone = smoothstep(0.18, 0.48, bankSlope) * smoothstep(0.02, 0.30, rawHeightAboveWater);
            bankSoilCol = mix(bankSoilCol, erodedBankEarth, erosionZone * 0.38);
            bankSoilCol *= mix(vec3(1.0), tRatio, 0.86);

            // Patchy upland moss on flat, damp-shaded bank terraces
            float terraceMossMask = smoothstep(0.18, 0.04, bankSlope) *
                                    smoothstep(0.52, 0.78, macroZone);
            vec3 bankMossCol = mix(vec3(0.19, 0.26, 0.12), vec3(0.26, 0.33, 0.15), mineralSpeckle);
            vec3 bankSurfaceCol = mix(bankSoilCol, bankMossCol, terraceMossMask * 0.46);

            vec3 finalTerrainCol = mix(submergedBedCol, bankSurfaceCol, bankHeightMask * 0.88);
            finalTerrainCol *= tAO;

            baseRoughParam = mix(0.70, 0.88, tRough) - (1.0 - bankHeightMask) * 0.10;
            sparseCreviceMask = clamp(1.0 - tAO, 0.0, 0.45);

            float boulderContactAO = 0.85 + 0.15 * smoothstep(-0.02, 0.20, flowSample.a);
            diffuseColor.rgb *= finalTerrainCol * boulderContactAO * 1.18;
          } else {
            // Config A fallback when Albedo maps are disabled
            vec3 plainTerrain = mix(vec3(0.36, 0.31, 0.25), vec3(0.38, 0.32, 0.25), bankHeightMask);
            diffuseColor.rgb *= plainTerrain * 1.15;
          }

          if (enableNormalMaps) {
            vec2 tnPrimary = texture2D(uTerrainNormalTex, vPrimaryUv).rg * 2.0 - 1.0;
            vec2 tnDetail = texture2D(uTerrainNormalTex, vDetailUv).rg * 2.0 - 1.0;
            combinedNormalSlope = (tnPrimary * 0.62 + tnDetail * 0.36 * distAtten) * 0.74;
          }
          `
      }

      // --- Physically Grounded Wet / Damp / Submerged Response (Active in Config D & Debug modes) ---
      float splashWick = clamp(flowSample.b, 0.0, 1.0) * 0.055 * (0.40 + 0.70 * wetPatchSignal);
      float capillaryWick = (0.016 + 0.044 * smoothstep(0.34, 0.78, wetPatchSignal)) * (0.60 + 0.40 * sparseCreviceMask);
      float heightAboveWater = rawHeightAboveWater - splashWick - capillaryWick;

      float dampZone = 1.0 - smoothstep(0.00, 0.105, heightAboveWater);
      float wetSplashPatch = (1.0 - smoothstep(-0.015, 0.052, heightAboveWater)) *
                             (0.65 + 0.35 * smoothstep(0.28, 0.72, wetPatchSignal));
      float submergedZone = 1.0 - smoothstep(-0.03, 0.015, rawHeightAboveWater);

      if (enableRoughnessWetness) {
        float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 chromaBoosted = mix(vec3(luma), diffuseColor.rgb, 1.14);
        float wetDetailPreserve = 0.94 + 0.12 * (mineralSpeckle - 0.5);
        float darkenFactor = mix(1.0, 0.68 * wetDetailPreserve, clamp(dampZone * 0.78 + submergedZone * 0.22, 0.0, 1.0));
        vec3 wetStoneCol = max(vec3(0.048), chromaBoosted * darkenFactor);

        if (rawHeightAboveWater < 0.0) {
          float subDepth = clamp(-rawHeightAboveWater, 0.0, 0.85);
          vec3 subAtten = exp(-vec3(0.34, 0.13, 0.11) * subDepth);
          wetStoneCol *= mix(vec3(1.0), subAtten, 0.62);
        }

        float totalWetBlend = clamp(max(dampZone, submergedZone), 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, wetStoneCol, totalWetBlend);
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
      #include <roughnessmap_fragment>
      if (enableRoughnessWetness) {
        float dryRough = clamp(
          baseRoughParam + (0.5 - mineralSpeckle) * 0.14 + sparseCreviceMask * 0.12,
          0.46,
          0.94
        );
        float dampRough = mix(dryRough, 0.44 + 0.10 * (1.0 - mineralSpeckle), dampZone * 0.72);
        float wetTargetRough = 0.30 + 0.14 * (1.0 - mineralSpeckle) + 0.08 * sparseCreviceMask;
        float waterlineRough = mix(dampRough, wetTargetRough, wetSplashPatch * 0.80);

        roughnessFactor = mix(waterlineRough, 0.40 + 0.10 * (1.0 - mineralSpeckle), submergedZone * 0.68);
        roughnessFactor = clamp(roughnessFactor, 0.28, 0.94);
      } else {
        roughnessFactor = 0.74;
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #include <normal_fragment_maps>
      if (enableNormalMaps) {
        vec3 worldPerturb = vec3(-combinedNormalSlope.x, 0.0, -combinedNormalSlope.y);
        ${
          isPebbleOrRock
            ? /* glsl */ `
            float sideFactor = 1.0 - smoothstep(0.25, 0.75, abs(Wn.y));
            vec3 sidePerturb = vec3(-combinedNormalSlope.x * Wn.z, -combinedNormalSlope.y, combinedNormalSlope.x * Wn.x);
            worldPerturb = mix(worldPerturb, sidePerturb, sideFactor);
            `
            : ''
        }
        worldPerturb -= Wn * dot(worldPerturb, Wn);
        dbgNormalVis = normalize(Wn + worldPerturb * 0.65);

        vec3 viewPerturb = vViewX * worldPerturb.x + vViewY * worldPerturb.y + vViewZ * worldPerturb.z;
        ${
          isPebbleOrRock
            ? /* glsl */ `
            float bumpStrength = (0.56 + 0.32 * vRockParams.z) * (0.65 + 0.35 * distAtten);
            normal = normalize(normal + viewPerturb * bumpStrength);
            `
            : /* glsl */ `
            normal = normalize(normal + viewPerturb * (0.65 + 0.35 * distAtten));
            `
        }
      }
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

      // Development-only Material Inspection Views (4=Albedo, 5=Normal, 6=Roughness, 7=AO/Structure)
      if (uMaterialDebugMode > 3.5) {
        vec3 dbgOut = diffuseColor.rgb;
        if (uMaterialDebugMode < 4.5) {
          dbgOut = diffuseColor.rgb;
        } else if (uMaterialDebugMode < 5.5) {
          dbgOut = dbgNormalVis * 0.5 + 0.5;
        } else if (uMaterialDebugMode < 6.5) {
          dbgOut = vec3(roughnessFactor);
        } else {
          dbgOut = vec3(dbgStructureVal);
        }
        reflectedLight.directDiffuse = dbgOut;
        reflectedLight.indirectDiffuse = vec3(0.0);
        reflectedLight.directSpecular = vec3(0.0);
        reflectedLight.indirectSpecular = vec3(0.0);
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
    this.group.add(this.bedMesh);

    const pebbleGeo = this.buildPebblePrototypeGeometry();
    this.pebbleInstancedMesh = new THREE.InstancedMesh(pebbleGeo, this.pebbleMaterial, 2600);
    this.pebbleInstancedMesh.receiveShadow = true;
    this.pebbleInstancedMesh.castShadow = false;
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
      [0.26, 0.29, 0.31], // Dark weathered slate
      [0.54, 0.49, 0.43], // Smooth pale granodiorite
      [0.22, 0.24, 0.26], // Dark wet mineral basalt
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
