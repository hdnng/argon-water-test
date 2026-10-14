import * as THREE from 'three';

export const STREAM_DOMAIN = {
  width: 16.0,
  length: 24.0,
  minX: -8.0,
  maxX: 8.0,
  minZ: -12.0,
  maxZ: 12.0,
  ledgeZ: -2.0,
  ledgeDrop: 0.48
};

export type RockGeologicalStyle = 'angular-slate' | 'rounded-granite' | 'layered-gneiss' | 'eroded-basalt';

export interface RockDescriptor {
  id: number;
  x: number;
  y: number;
  z: number;
  radiusX: number;
  radiusY: number;
  radiusZ: number;
  rotationY: number;
  rotationX: number;
  rotationZ: number;
  seed: number;
  submersionType: 'emergent' | 'semi-submerged' | 'submerged' | 'ledge' | 'bank';
  style: RockGeologicalStyle;
  asymmetry: [number, number, number];
  colorTint: [number, number, number];
  secondaryTint: [number, number, number];
  mossAmount: number;
}

export function pcgHash(input: number): number {
  const state = Math.imul(input >>> 0, 747796405) + 2891336453;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737);
  return (((word >>> 22) ^ word) >>> 0) / 4294967295;
}

function hash2D(ix: number, iz: number): number {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise2D(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3.0 - 2.0 * fx);
  const uz = fz * fz * (3.0 - 2.0 * fz);

  const a = hash2D(ix, iz);
  const b = hash2D(ix + 1, iz);
  const c = hash2D(ix, iz + 1);
  const d = hash2D(ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm2D(x: number, z: number, octaves = 4): number {
  let value = 0.0;
  let amp = 0.5;
  let freq = 1.0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    value += amp * (valueNoise2D(px * freq, pz * freq) * 2.0 - 1.0);
    const nx = px * 0.8 - pz * 0.6;
    const nz = px * 0.6 + pz * 0.8;
    px = nx;
    pz = nz;
    freq *= 2.03;
    amp *= 0.5;
  }
  return value;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0.0, Math.min(1.0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3.0 - 2.0 * t);
}

export interface CascadeChuteDescriptor {
  centerX: number;
  width: number;
  strength: number;
  skewX: number;
  lipZ: number;
  dropEndZ: number;
  archHeight: number;
  seed: number;
}

// Waterfall pouring chutes aligned with the natural physical gaps and saddles between ledge rocks:
// Rock 9 (-2.18), Rock 11 (-0.52), Rock 12 (+0.68), Rock 10 (+2.08)
export const CASCADE_CHUTES: CascadeChuteDescriptor[] = [
  { centerX: -1.03, width: 0.46, strength: 0.92, skewX: 0.16, lipZ: -2.38, dropEndZ: -1.20, archHeight: 0.048, seed: 1.7 },
  { centerX: -0.09, width: 0.48, strength: 0.95, skewX: -0.05, lipZ: -2.44, dropEndZ: -1.16, archHeight: 0.054, seed: 4.3 },
  { centerX: 0.10, width: 0.60, strength: 1.06, skewX: -0.02, lipZ: -2.48, dropEndZ: -1.10, archHeight: 0.066, seed: 7.9 },
  { centerX: 0.27, width: 0.46, strength: 0.90, skewX: 0.06, lipZ: -2.42, dropEndZ: -1.18, archHeight: 0.050, seed: 11.2 },
  { centerX: 1.07, width: 0.44, strength: 0.88, skewX: -0.18, lipZ: -2.34, dropEndZ: -1.18, archHeight: 0.045, seed: 14.6 }
];

export class FlowField {
  public readonly resolution: number;
  public readonly rocks: RockDescriptor[] = [];
  public readonly flowTexture: THREE.DataTexture;
  public readonly terrainTexture: THREE.DataTexture;
  public readonly flowData: Float32Array;
  public readonly terrainData: Float32Array;

  constructor(resolution = 256) {
    this.resolution = resolution;
    this.flowData = new Float32Array(resolution * resolution * 4);
    this.terrainData = new Float32Array(resolution * resolution * 4);

    this.initRockDescriptors();
    this.bakeFields();

    const len = resolution * resolution * 4;
    const flowHalf = new Uint16Array(len);
    const terrainHalf = new Uint16Array(len);
    for (let i = 0; i < len; i++) {
      flowHalf[i] = THREE.DataUtils.toHalfFloat(this.flowData[i]);
      terrainHalf[i] = THREE.DataUtils.toHalfFloat(this.terrainData[i]);
    }

    this.flowTexture = new THREE.DataTexture(
      flowHalf as unknown as BufferSource,
      resolution,
      resolution,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    this.flowTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.flowTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.flowTexture.magFilter = THREE.LinearFilter;
    this.flowTexture.minFilter = THREE.LinearFilter;
    this.flowTexture.needsUpdate = true;

    this.terrainTexture = new THREE.DataTexture(
      terrainHalf as unknown as BufferSource,
      resolution,
      resolution,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    this.terrainTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.terrainTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.terrainTexture.magFilter = THREE.LinearFilter;
    this.terrainTexture.minFilter = THREE.LinearFilter;
    this.terrainTexture.needsUpdate = true;
  }

  public getChannelCenter(z: number): number {
    return (
      0.58 * Math.sin(z * 0.21 + 0.35) +
      0.24 * Math.cos(z * 0.46 - 0.65) +
      0.12 * Math.sin(z * 0.85 + 1.4)
    );
  }

  public getChannelSlopeX(z: number): number {
    return (
      0.58 * 0.21 * Math.cos(z * 0.21 + 0.35) -
      0.24 * 0.46 * Math.sin(z * 0.46 - 0.65) +
      0.12 * 0.85 * Math.cos(z * 0.85 + 1.4)
    );
  }

  public getChannelHalfWidth(z: number): number {
    const ledgeConstriction = Math.exp(-Math.pow((z - STREAM_DOMAIN.ledgeZ) / 1.45, 2.0));
    const poolWidening = Math.exp(-Math.pow((z - 0.35) / 2.2, 2.0));
    const naturalVariation = 0.26 * Math.sin(z * 0.51 + 1.1) + 0.14 * Math.cos(z * 0.93 - 0.4);
    return 3.25 - 0.72 * ledgeConstriction + 0.55 * poolWidening + naturalVariation;
  }

  public getBaseWaterHeight(x: number, z: number): number {
    const upstreamSlope = -0.015 * (z + 12.0);
    const cascadeT = smoothstep(-2.42, -1.32, z);
    const dropCurve = Math.pow(cascadeT, 1.35);
    const baseElevation = 0.64 + upstreamSlope - STREAM_DOMAIN.ledgeDrop * dropCurve;

    const center = this.getChannelCenter(z);
    const dx = x - center;
    const crossRipple = 0.003 * Math.cos(dx * 0.85);

    return baseElevation + crossRipple;
  }

  /**
   * Evaluates the continuous cascade water elevation profile including the convex nappe arch
   * over the curved rock lip, chute crown, impact trough, and downstream hydraulic roller crest.
   */
  public getCascadeWaterHeight(x: number, z: number): number {
    const baseY = this.getBaseWaterHeight(x, z);
    if (z < -2.90 || z > -0.45) return baseY;

    let chuteOffset = 0.0;
    for (const chute of CASCADE_CHUTES) {
      const tDrop = smoothstep(chute.lipZ, chute.dropEndZ, z);
      const xc = chute.centerX + chute.skewX * tDrop;
      const dx = x - xc;
      const lat = Math.exp(-Math.pow(dx / (chute.width * 0.58), 2.0));

      // Convex parabolic free-fall nappe over the lip and upper drop
      const nappeEnv =
        smoothstep(chute.lipZ - 0.18, chute.lipZ + 0.14, z) *
        (1.0 - smoothstep(chute.dropEndZ - 0.28, chute.dropEndZ + 0.04, z));
      const nappeArch = 0.026 * Math.sin(Math.pow(tDrop, 0.72) * Math.PI) * nappeEnv;

      // Plunge impact depression followed by hydraulic jump standing roller wave
      const impactTrough = -0.014 * Math.exp(-Math.pow((z - chute.dropEndZ) / 0.16, 2.0));
      const jumpRoller = 0.019 * Math.exp(-Math.pow((z - (chute.dropEndZ + 0.24)) / 0.22, 2.0));

      const contrib = (nappeArch + impactTrough + jumpRoller) * lat * chute.strength;
      if (Math.abs(contrib) > Math.abs(chuteOffset)) {
        chuteOffset = contrib;
      }
    }

    return baseY + chuteOffset;
  }

  /**
   * Domain-warped, non-repetitive geological riverbed and bank elevation
   */
  public getRiverbedHeight(x: number, z: number): number {
    const center = this.getChannelCenter(z);
    const halfWidth = this.getChannelHalfWidth(z);
    const waterBase = this.getBaseWaterHeight(x, z);

    // Domain warp coordinates so banks and gravel bars follow irregular natural erosion contours
    const warpX = x + fbm2D(x * 0.32 + 4.1, z * 0.32 - 2.3, 3) * 0.48;
    const warpZ = z + fbm2D(x * 0.32 - 7.2, z * 0.32 + 5.8, 3) * 0.48;

    const signedOffset = warpX - center;
    const distFromCenter = Math.abs(signedOffset);
    const normDist = distFromCenter / halfWidth;

    // Asymmetric thalweg scour (deeper on outside of bend, shallower gravel point-bar on inside)
    const bendCurvature = -0.25 * Math.sin(z * 0.21 + 0.35);
    const thalwegShift = signedOffset * bendCurvature * 0.14;

    let crossProfile: number;
    if (normDist < 0.75) {
      crossProfile = -0.37 + thalwegShift + 0.15 * Math.pow(normDist / 0.75, 1.85);
    } else if (normDist < 1.38) {
      const bankT = smoothstep(0.75, 1.38, normDist);
      // Irregular stepped alluvial bank transition
      const terrace = 0.04 * Math.sin(bankT * Math.PI * 2.0 + fbm2D(warpX, warpZ, 2) * 2.5);
      crossProfile = -0.22 + 0.66 * Math.pow(bankT, 1.38) + terrace;
    } else {
      const outerT = Math.min(1.0, (normDist - 1.38) / 1.25);
      crossProfile = 0.44 + 0.78 * Math.pow(outerT, 1.12);
    }

    // Ledge sill rise right at the waterfall lip (z ~ -2.25) with eroded pouring channels
    const ledgeLipFactor = Math.exp(-Math.pow((z - (STREAM_DOMAIN.ledgeZ - 0.22)) / 0.56, 2.0));
    const bedChutes = [
      { cx: -1.68, w: 0.52 },
      { cx: -0.92, w: 0.46 },
      { cx: -0.14, w: 0.54 },
      { cx: 0.42, w: 0.40 },
      { cx: 1.04, w: 0.56 }
    ];
    let chuteCarve = 0.0;
    for (const c of bedChutes) {
      chuteCarve += 0.065 * Math.exp(-Math.pow((x - c.cx) / (c.w * 0.65), 2.0));
    }
    const sillRise = (0.22 - chuteCarve) * ledgeLipFactor * (1.0 - 0.38 * Math.min(1.0, normDist));

    // Plunge pool scour immediately downstream of waterfall (z ~ -0.95)
    const plungeFactor =
      Math.exp(-Math.pow((z - (STREAM_DOMAIN.ledgeZ + 0.92)) / 1.18, 2.0)) *
      Math.exp(-Math.pow(distFromCenter / 2.25, 2.0));
    const plungeScour = -0.35 * plungeFactor;

    // Non-periodic multi-scale geological relief
    const macroNoise = fbm2D(warpX * 0.38 + 3.1, warpZ * 0.28 - 1.7, 4) * 0.115;
    const mesoNoise = fbm2D(warpX * 1.25 - 5.4, warpZ * 0.95 + 2.3, 3) * 0.048;
    const bankRuggedness = smoothstep(0.68, 1.45, normDist) * fbm2D(warpX * 0.82, warpZ * 0.74, 4) * 0.21;

    return waterBase + crossProfile + sillRise + plungeScour + macroNoise + mesoNoise + bankRuggedness;
  }

  private initRockDescriptors(): void {
    const rawRocks: Array<{
      x: number;
      z: number;
      rx: number;
      ry: number;
      rz: number;
      rotY: number;
      yOffset: number;
      type: RockDescriptor['submersionType'];
      style: RockGeologicalStyle;
      asym: [number, number, number];
      tint: [number, number, number];
      secTint: [number, number, number];
      moss: number;
    }> = [
      // --- Foreground & Midground Instream Emergent Rocks ---
      {
        // Family 2: Warm Brown Sedimentary Stone
        x: 0.65,
        z: 3.15,
        rx: 0.65,
        ry: 0.46,
        rz: 0.53,
        rotY: 0.42,
        yOffset: 0.15,
        type: 'emergent',
        style: 'layered-gneiss',
        asym: [1.14, 0.92, 0.85],
        tint: [0.48, 0.38, 0.28],
        secTint: [0.37, 0.30, 0.23],
        moss: 0.28
      },
      {
        // Family 4: Smooth Pale River Granodiorite
        x: -0.88,
        z: 2.35,
        rx: 0.55,
        ry: 0.38,
        rz: 0.47,
        rotY: -0.55,
        yOffset: 0.12,
        type: 'emergent',
        style: 'rounded-granite',
        asym: [0.91, 1.05, 1.15],
        tint: [0.56, 0.52, 0.46],
        secTint: [0.42, 0.40, 0.37],
        moss: 0.08
      },
      {
        // Family 1: Dark Gray Weathered River Stone
        x: 0.12,
        z: 0.95,
        rx: 0.78,
        ry: 0.52,
        rz: 0.63,
        rotY: 0.18,
        yOffset: 0.18,
        type: 'emergent',
        style: 'angular-slate',
        asym: [1.16, 0.88, 0.94],
        tint: [0.33, 0.32, 0.30],
        secTint: [0.38, 0.37, 0.35],
        moss: 0.34
      },
      {
        // Family 5: Dark Wet Mineral Amphibolite
        x: -1.45,
        z: 0.25,
        rx: 0.59,
        ry: 0.42,
        rz: 0.50,
        rotY: 1.05,
        yOffset: 0.13,
        type: 'emergent',
        style: 'eroded-basalt',
        asym: [0.88, 1.08, 1.13],
        tint: [0.26, 0.25, 0.24],
        secTint: [0.32, 0.29, 0.26],
        moss: 0.18
      },
      {
        // Family 4: Smooth Pale River Quartzite
        x: 1.52,
        z: 1.75,
        rx: 0.48,
        ry: 0.34,
        rz: 0.42,
        rotY: -0.35,
        yOffset: 0.07,
        type: 'semi-submerged',
        style: 'rounded-granite',
        asym: [1.09, 0.94, 0.90],
        tint: [0.54, 0.49, 0.43],
        secTint: [0.40, 0.37, 0.33],
        moss: 0.06
      },
      {
        // Family 1: Dark Gray Weathered Basalt
        x: -0.32,
        z: 4.35,
        rx: 0.50,
        ry: 0.33,
        rz: 0.44,
        rotY: 0.78,
        yOffset: 0.09,
        type: 'emergent',
        style: 'eroded-basalt',
        asym: [0.93, 0.95, 1.16],
        tint: [0.29, 0.28, 0.27],
        secTint: [0.36, 0.35, 0.33],
        moss: 0.16
      },
      {
        // Family 2: Warm Brown Sedimentary Stone
        x: 1.18,
        z: 4.85,
        rx: 0.57,
        ry: 0.39,
        rz: 0.49,
        rotY: -0.92,
        yOffset: 0.11,
        type: 'emergent',
        style: 'layered-gneiss',
        asym: [1.15, 0.90, 0.91],
        tint: [0.46, 0.36, 0.26],
        secTint: [0.35, 0.29, 0.22],
        moss: 0.32
      },
      // --- Submerged Reef / Riffle Stones ---
      {
        // Family 4: Smooth Pale Submerged Cobble
        x: -0.22,
        z: 2.85,
        rx: 0.46,
        ry: 0.26,
        rz: 0.42,
        rotY: 0.25,
        yOffset: -0.09,
        type: 'submerged',
        style: 'rounded-granite',
        asym: [1.06, 0.88, 0.96],
        tint: [0.52, 0.46, 0.38],
        secTint: [0.38, 0.34, 0.29],
        moss: 0.05
      },
      {
        // Family 5: Dark Submerged Mineral Rock
        x: 0.88,
        z: -0.35,
        rx: 0.51,
        ry: 0.28,
        rz: 0.46,
        rotY: -0.60,
        yOffset: -0.10,
        type: 'submerged',
        style: 'eroded-basalt',
        asym: [0.92, 0.90, 1.12],
        tint: [0.28, 0.27, 0.25],
        secTint: [0.34, 0.31, 0.27],
        moss: 0.10
      },
      // --- Cascade / Waterfall Ledge Outcrops (z ~ -2.0) ---
      {
        // Family 3: Muted Green Moss-Covered Ledge Outcrop
        x: -2.18,
        z: -1.95,
        rx: 1.20,
        ry: 0.68,
        rz: 0.92,
        rotY: 0.22,
        yOffset: 0.24,
        type: 'ledge',
        style: 'angular-slate',
        asym: [1.16, 0.92, 0.88],
        tint: [0.32, 0.33, 0.29],
        secTint: [0.26, 0.27, 0.24],
        moss: 0.78
      },
      {
        // Family 3: Muted Green Moss-Covered Gneiss Outcrop
        x: 2.08,
        z: -1.85,
        rx: 1.26,
        ry: 0.72,
        rz: 0.95,
        rotY: -0.28,
        yOffset: 0.26,
        type: 'ledge',
        style: 'layered-gneiss',
        asym: [0.90, 0.95, 1.14],
        tint: [0.36, 0.35, 0.30],
        secTint: [0.27, 0.28, 0.24],
        moss: 0.74
      },
      {
        // Family 1: Dark Gray Weathered Ledge Divide
        x: -0.52,
        z: -1.98,
        rx: 0.53,
        ry: 0.47,
        rz: 0.49,
        rotY: 0.14,
        yOffset: 0.14,
        type: 'ledge',
        style: 'angular-slate',
        asym: [1.10, 0.96, 0.88],
        tint: [0.31, 0.30, 0.29],
        secTint: [0.36, 0.35, 0.33],
        moss: 0.42
      },
      {
        // Family 2: Warm Brown Weathered Ledge Divide
        x: 0.68,
        z: -1.92,
        rx: 0.47,
        ry: 0.43,
        rz: 0.45,
        rotY: -0.40,
        yOffset: 0.12,
        type: 'ledge',
        style: 'eroded-basalt',
        asym: [0.92, 1.04, 1.10],
        tint: [0.44, 0.35, 0.27],
        secTint: [0.32, 0.27, 0.22],
        moss: 0.36
      },
      // --- Upstream Boulders (z < -3.0) ---
      {
        // Family 4: Smooth Pale River Stone
        x: 0.25,
        z: -3.85,
        rx: 0.61,
        ry: 0.42,
        rz: 0.52,
        rotY: 0.65,
        yOffset: 0.14,
        type: 'emergent',
        style: 'rounded-granite',
        asym: [1.08, 0.92, 0.94],
        tint: [0.53, 0.48, 0.42],
        secTint: [0.39, 0.36, 0.32],
        moss: 0.20
      },
      {
        // Family 2: Warm Sedimentary Gneiss
        x: -1.05,
        z: -5.20,
        rx: 0.69,
        ry: 0.46,
        rz: 0.57,
        rotY: -0.48,
        yOffset: 0.16,
        type: 'emergent',
        style: 'layered-gneiss',
        asym: [0.90, 0.96, 1.14],
        tint: [0.45, 0.36, 0.27],
        secTint: [0.35, 0.29, 0.23],
        moss: 0.46
      },
      {
        // Family 1: Dark Gray Weathered Slate
        x: 1.15,
        z: -6.40,
        rx: 0.55,
        ry: 0.38,
        rz: 0.48,
        rotY: 0.85,
        yOffset: 0.10,
        type: 'emergent',
        style: 'angular-slate',
        asym: [1.12, 0.91, 0.90],
        tint: [0.30, 0.29, 0.28],
        secTint: [0.36, 0.35, 0.34],
        moss: 0.28
      },
      // --- Shoreline / Bank Anchor Boulders ---
      {
        // Family 3: Moss-Covered Bank Anchor Boulder
        x: 2.68,
        z: 3.45,
        rx: 0.98,
        ry: 0.58,
        rz: 0.82,
        rotY: -0.32,
        yOffset: 0.22,
        type: 'bank',
        style: 'layered-gneiss',
        asym: [1.14, 0.88, 0.94],
        tint: [0.38, 0.35, 0.29],
        secTint: [0.28, 0.27, 0.23],
        moss: 0.76
      },
      {
        // Family 3: Moss-Covered Slate Bank Boulder
        x: -2.58,
        z: 1.85,
        rx: 0.90,
        ry: 0.54,
        rz: 0.78,
        rotY: 0.44,
        yOffset: 0.20,
        type: 'bank',
        style: 'angular-slate',
        asym: [0.91, 0.94, 1.15],
        tint: [0.29, 0.31, 0.28],
        secTint: [0.23, 0.25, 0.22],
        moss: 0.72
      }
    ];

    rawRocks.forEach((r, idx) => {
      const waterY = this.getBaseWaterHeight(r.x, r.z);
      const centerY = waterY + r.yOffset - r.ry * 0.55;
      this.rocks.push({
        id: idx,
        x: r.x,
        y: centerY,
        z: r.z,
        radiusX: r.rx,
        radiusY: r.ry,
        radiusZ: r.rz,
        rotationY: r.rotY,
        rotationX: (hash2D(idx, 17) - 0.5) * 0.18,
        rotationZ: (hash2D(idx, 31) - 0.5) * 0.18,
        seed: idx * 17.37 + 5.1,
        submersionType: r.type,
        style: r.style,
        asymmetry: r.asym,
        colorTint: r.tint,
        secondaryTint: r.secTint,
        mossAmount: r.moss
      });
    });
  }

  public evaluateRockField(x: number, z: number, waterY: number): {
    maxRockY: number;
    minSignedDist: number;
    gradX: number;
    gradZ: number;
    deflectVx: number;
    deflectVz: number;
    rockTurbulence: number;
    bowWaveHeight: number;
  } {
    let maxRockY = -10.0;
    let minSignedDist = 10.0;
    let gradX = 0.0;
    let gradZ = 0.0;
    let deflectVx = 0.0;
    let deflectVz = 0.0;
    let rockTurbulence = 0.0;
    let bowWaveHeight = 0.0;

    for (let i = 0; i < this.rocks.length; i++) {
      const rock = this.rocks[i];
      const dx = x - rock.x;
      const dz = z - rock.z;

      const maxR = Math.max(rock.radiusX, rock.radiusZ) * 4.2;
      if (Math.abs(dx) > maxR || Math.abs(dz) > maxR + 2.2) continue;

      const cosY = Math.cos(-rock.rotationY);
      const sinY = Math.sin(-rock.rotationY);
      const lx = dx * cosY - dz * sinY;
      const lz = dx * sinY + dz * cosY;

      const nx = lx / (rock.radiusX * rock.asymmetry[0]);
      const nz = lz / (rock.radiusZ * rock.asymmetry[2]);
      const horizDistSq = nx * nx + nz * nz;
      const horizDist = Math.sqrt(horizDistSq);

      const angle = Math.atan2(lz, lx);
      const shapeMod =
        1.0 +
        0.13 * Math.sin(angle * 2.0 + rock.seed) +
        0.09 * Math.cos(angle * 3.0 - rock.seed * 1.7) +
        0.05 * Math.sin(angle * 4.0 + rock.seed * 0.9);

      const effHorizNorm = horizDist / shapeMod;

      if (effHorizNorm < 1.15) {
        const clampedNorm = Math.min(1.0, effHorizNorm);
        const dome = Math.pow(1.0 - clampedNorm * clampedNorm, 0.56);
        const topNoise = fbm2D(lx * 2.2 + rock.seed, lz * 2.2 - rock.seed, 2) * 0.06;
        const rockTopY = rock.y + rock.radiusY * rock.asymmetry[1] * dome + topNoise;
        if (rockTopY > maxRockY) {
          maxRockY = rockTopY;
        }
      }

      const apexY = rock.y + rock.radiusY * rock.asymmetry[1];
      const emergence = apexY - waterY;
      if (emergence > -0.20) {
        const avgRadius = 0.5 * (rock.radiusX + rock.radiusZ) * shapeMod;
        const waterlineFraction =
          emergence > 0.0
            ? Math.min(0.95, Math.sqrt(Math.max(0.08, (apexY - waterY) / rock.radiusY)))
            : 0.38;
        const waterlineRadius = avgRadius * waterlineFraction;
        const worldDist = horizDist * 0.5 * (rock.radiusX + rock.radiusZ);
        const signedDist = worldDist - waterlineRadius;

        if (signedDist < minSignedDist) {
          minSignedDist = signedDist;
          const invLen = 1.0 / Math.max(0.0001, Math.hypot(dx, dz));
          gradX = dx * invLen;
          gradZ = dz * invLen;
        }

        const rEff = Math.max(0.22, waterlineRadius);
        const dist = Math.max(rEff * 0.65, worldDist);
        const ratioSq = (rEff * rEff) / (dist * dist);

        const dirX = dx / Math.max(0.001, worldDist);
        const dirZ = dz / Math.max(0.001, worldDist);
        const falloff = Math.exp(-Math.max(0.0, signedDist) / (rEff * 1.95));
        const submersionWeight = smoothstep(-0.20, 0.08, emergence);

        const lateralPush = 1.48 * dirX * (dirZ < 0.30 ? 1.0 : 0.48) * falloff * submersionWeight;
        deflectVx += lateralPush;

        const flankBoost =
          Math.exp(-Math.pow(dz / (rEff * 0.95), 2.0)) *
          Math.exp(-Math.pow((Math.abs(dx) - rEff * 1.12) / (rEff * 0.65), 2.0));
        const upstreamStagnation =
          dz < 0.0
            ? Math.exp(-Math.pow(dx / (rEff * 0.78), 2.0)) *
              Math.exp(-Math.pow((dz + rEff * 0.92) / (rEff * 0.72), 2.0))
            : 0.0;
        const wakeDeficit =
          dz > 0.0
            ? Math.exp(-Math.pow(dx / (rEff * (0.85 + dz * 0.22)), 2.0)) *
              Math.exp(-dz / (rEff * 3.6))
            : 0.0;

        deflectVz +=
          (0.75 * flankBoost - 0.82 * upstreamStagnation - 0.58 * wakeDeficit * ratioSq) *
          submersionWeight;

        const bowPileup =
          dz < 0.18
            ? Math.exp(-Math.pow(dx / (rEff * 0.98), 2.0)) *
              Math.exp(-Math.pow((dz + rEff * 0.98) / (rEff * 0.56), 2.0))
            : 0.0;
        const wakeTrough =
          dz > -0.10
            ? Math.exp(-Math.pow(dx / (rEff * 1.05), 2.0)) *
              Math.exp(-Math.pow((dz - rEff * 0.82) / (rEff * 0.88), 2.0))
            : 0.0;

        bowWaveHeight +=
          (0.056 * bowPileup - 0.028 * wakeTrough - 0.016 * flankBoost) * submersionWeight;

        // Physically localized turbulence around the obstacle:
        // 1) Leading-edge hydraulic compression collar & flank wrap around the rock
        const bowFoam =
          Math.exp(-Math.pow(Math.max(0.0, signedDist - 0.015) / 0.15, 2.0)) *
          smoothstep(0.35, -0.65, dirZ);

        // 2) Near-wake recirculation boil + separated V-shaped flank shear arms & vortex street
        let wakeFoam = 0.0;
        if (dz > -0.15 * rEff && dz < rEff * 3.8) {
          const wakeMeander = fbm2D(x * 2.1 + rock.seed, z * 1.7 - rock.seed, 2) * 0.16 * dz;
          const shiftedDx = dx + wakeMeander;
          const armOffset = rEff * 0.62 + Math.max(0.0, dz) * 0.20;
          const armWidth = rEff * 0.28 + Math.max(0.0, dz) * 0.09;

          // Two distinct shear-layer arms peeling off the left and right shoulders of the boulder
          const shearArms = Math.exp(-Math.pow((Math.abs(shiftedDx) - armOffset) / armWidth, 2.0));

          // Localized near-wake turbulent boil immediately behind the boulder (decays within 1.5 * rEff)
          const nearWakeBoil =
            Math.exp(-Math.pow(shiftedDx / (rEff * 0.68), 2.0)) *
            smoothstep(-0.08 * rEff, 0.25 * rEff, dz) *
            Math.exp(-Math.max(0.0, dz) / (rEff * 1.15));

          // Coherent vortex pocket modulation along the wake
          const vortexBreakup =
            0.48 + 0.52 * Math.max(0.0, fbm2D(x * 2.4 - rock.seed, z * 2.1 + rock.seed, 2) + 0.30);

          const streamDecay =
            smoothstep(-0.15 * rEff, 0.20 * rEff, dz) * Math.exp(-Math.max(0.0, dz) / (rEff * 2.15));
          wakeFoam = (shearArms * 0.88 + nearWakeBoil * 0.72) * vortexBreakup * streamDecay;
        }

        const rockContrib = (bowFoam * 0.96 + wakeFoam * 1.08) * submersionWeight;
        // Soft-saturating accumulation prevents overlapping boulder wakes from blowing out into a flat slab
        rockTurbulence += rockContrib * Math.max(0.20, 1.0 - rockTurbulence * 0.48);
      }
    }

    return {
      maxRockY,
      minSignedDist,
      gradX,
      gradZ,
      deflectVx,
      deflectVz,
      rockTurbulence,
      bowWaveHeight
    };
  }

  private bakeFields(): void {
    const res = this.resolution;
    for (let iz = 0; iz < res; iz++) {
      const v = iz / (res - 1);
      const z = STREAM_DOMAIN.minZ + v * STREAM_DOMAIN.length;

      const center = this.getChannelCenter(z);
      const slopeX = this.getChannelSlopeX(z);
      const halfWidth = this.getChannelHalfWidth(z);

      const widthFactor = 3.25 / Math.max(1.8, halfWidth);
      // Hydraulic acceleration over the waterfall ledge lip and drop
      const cascadeAccel = 1.72 * Math.exp(-Math.pow((z - (STREAM_DOMAIN.ledgeZ + 0.18)) / 0.76, 2.0));

      for (let ix = 0; ix < res; ix++) {
        const u = ix / (res - 1);
        const x = STREAM_DOMAIN.minX + u * STREAM_DOMAIN.width;

        const waterBase = this.getBaseWaterHeight(x, z);
        const cascadeWaterY = this.getCascadeWaterHeight(x, z);
        const bedY = this.getRiverbedHeight(x, z);
        const rockEval = this.evaluateRockField(x, z, waterBase);

        const solidY = Math.max(bedY, rockEval.maxRockY);
        const finalWaterBase = cascadeWaterY + rockEval.bowWaveHeight;

        const distFromCenter = Math.abs(x - center);
        const bankFactor = 1.0 - 0.62 * smoothstep(halfWidth * 0.55, halfWidth * 1.15, distFromCenter);

        const tangentLen = Math.hypot(slopeX, 1.0);
        const tanX = slopeX / tangentLen;
        const tanZ = 1.0 / tangentLen;

        const baseSpeed = (1.12 * widthFactor + cascadeAccel * 0.72) * bankFactor;

        const curlVx = fbm2D(x * 0.65 + 9.2, z * 0.65 - 4.1, 2) * 0.15;
        const curlVz = fbm2D(x * 0.65 - 3.7, z * 0.65 + 7.4, 2) * 0.15;

        // Localized cascade chute streamline funneling, acceleration over the lip, and plunge impact turbulence
        let chuteVx = 0.0;
        let chuteVz = 0.0;
        let chutePlungeTurb = 0.0;
        const chuteNoise = Math.max(0.0, fbm2D(x * 2.3 + 1.7, z * 1.9 - 3.1, 2) + 0.36);

        for (const chute of CASCADE_CHUTES) {
          const tDrop = smoothstep(chute.lipZ, chute.dropEndZ, z);
          const xc = chute.centerX + chute.skewX * tDrop;
          const dx = x - xc;
          const lateralEnv = Math.exp(-Math.pow(dx / (chute.width * 0.56), 2.0));

          // 1. Upstream drawdown convergence into gap + chute acceleration over drop + plunge fan-out
          const approachEnv = Math.exp(-Math.pow((z - (chute.lipZ - 0.08)) / 0.45, 2.0));
          const dropEnv =
            smoothstep(chute.lipZ - 0.35, chute.lipZ + 0.10, z) *
            (1.0 - smoothstep(chute.dropEndZ - 0.10, chute.dropEndZ + 0.45, z));
          const impactFanEnv = Math.exp(-Math.pow((z - (chute.dropEndZ + 0.12)) / 0.36, 2.0));

          chuteVx +=
            (-0.34 * dx * approachEnv +
              chute.skewX * 0.85 * dropEnv +
              0.28 * dx * impactFanEnv) *
            lateralEnv *
            chute.strength;

          chuteVz = Math.max(
            chuteVz,
            0.92 * dropEnv * lateralEnv * chute.strength * smoothstep(-0.02, 0.08, rockEval.minSignedDist)
          );

          // 2. Connected lip shear, localized impact boil, and downstream turbulent wake
          const lipEnv = Math.exp(-Math.pow((z - (chute.lipZ + 0.18)) / 0.28, 2.0));
          const impactZ = chute.dropEndZ + 0.06;
          const impactEnv = Math.exp(-Math.pow((z - impactZ) / 0.34, 2.0));

          const impactCenterX = chute.centerX + chute.skewX;
          const meanderX = x + fbm2D(x * 1.9 + chute.seed, z * 1.5 - chute.seed, 2) * 0.18;
          const plumeLat = Math.exp(-Math.pow((meanderX - impactCenterX) / (chute.width * 0.64), 2.0));
          const plumeDownstream =
            z > chute.dropEndZ - 0.15
              ? Math.exp(-Math.max(0.0, z - impactZ) / 1.48) *
                smoothstep(chute.dropEndZ - 0.18, impactZ + 0.12, z)
              : 0.0;

          const chuteVal =
            (lateralEnv * (impactEnv * 0.96 + lipEnv * 0.34) + plumeLat * plumeDownstream * 0.54) *
            (0.48 + 0.52 * chuteNoise) *
            chute.strength;
          chutePlungeTurb = Math.max(chutePlungeTurb, chuteVal);
        }

        const vx = baseSpeed * tanX + rockEval.deflectVx + chuteVx + curlVx;
        const vz = Math.max(0.08, baseSpeed * tanZ + rockEval.deflectVz + chuteVz + curlVz);

        const waterDepth = Math.max(0.0, finalWaterBase - bedY);
        const shallowRiffle =
          smoothstep(0.22, 0.04, waterDepth) *
          smoothstep(0.01, 0.06, waterDepth) *
          Math.max(0.0, fbm2D(x * 1.6, z * 1.6, 2) + 0.15) *
          0.26;

        const rawTurb = rockEval.rockTurbulence + chutePlungeTurb + shallowRiffle;
        // Soft shoulder compression so turbulence is strong around obstacles without saturating into a flat plateau
        const totalTurbulence = rawTurb / (1.0 + rawTurb * 0.34);

        const idx = (iz * res + ix) * 4;
        this.flowData[idx + 0] = vx;
        this.flowData[idx + 1] = vz;
        this.flowData[idx + 2] = totalTurbulence;
        this.flowData[idx + 3] = rockEval.minSignedDist;

        this.terrainData[idx + 0] = solidY;
        this.terrainData[idx + 1] = finalWaterBase;
        this.terrainData[idx + 2] = rockEval.gradX;
        this.terrainData[idx + 3] = rockEval.gradZ;
      }
    }
  }

  public sampleFlow(x: number, z: number): { vx: number; vz: number; turbulence: number; sdf: number } {
    const u = Math.max(0.0, Math.min(1.0, (x - STREAM_DOMAIN.minX) / STREAM_DOMAIN.width));
    const v = Math.max(0.0, Math.min(1.0, (z - STREAM_DOMAIN.minZ) / STREAM_DOMAIN.length));
    const ix = Math.min(this.resolution - 1, Math.floor(u * (this.resolution - 1)));
    const iz = Math.min(this.resolution - 1, Math.floor(v * (this.resolution - 1)));
    const idx = (iz * this.resolution + ix) * 4;
    return {
      vx: this.flowData[idx + 0],
      vz: this.flowData[idx + 1],
      turbulence: this.flowData[idx + 2],
      sdf: this.flowData[idx + 3]
    };
  }

  public dispose(): void {
    this.flowTexture.dispose();
    this.terrainTexture.dispose();
  }
}
