import * as THREE from 'three';
import { FlowField, RockDescriptor, fbm2D, pcgHash } from '../water/FlowField';
import {
  UnderwaterShaderUniforms,
  enhanceUnderwaterStoneMaterial,
  weldGeometryVertices
} from './Riverbed';

function clamp01(x: number): number {
  return Math.max(0.0, Math.min(1.0, x));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3.0 - 2.0 * t);
}

export class Rocks {
  public readonly group: THREE.Group;
  public readonly meshes: THREE.Mesh[] = [];
  private readonly rockMaterial: THREE.MeshStandardMaterial;

  constructor(
    flowField: FlowField,
    sharedUniforms: UnderwaterShaderUniforms,
    envMap: THREE.CubeTexture
  ) {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;

    this.rockMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.04,
      envMap,
      envMapIntensity: 0.58
    });
    enhanceUnderwaterStoneMaterial(this.rockMaterial, sharedUniforms, true);

    for (let i = 0; i < flowField.rocks.length; i++) {
      const desc = flowField.rocks[i];
      const geo = this.createSculptedRockGeometry(desc);
      const mesh = new THREE.Mesh(geo, this.rockMaterial);
      mesh.position.set(desc.x, desc.y, desc.z);
      mesh.rotation.set(desc.rotationX, desc.rotationY, desc.rotationZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.renderOrder = -3;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.meshes.push(mesh);
      this.group.add(mesh);
    }

    // Add natural rocky cascade sill stones and irregular companion stones
    this.createCascadeAndClusterStones(flowField);
  }

  /**
   * Builds a welded, naturally weathered river boulder mesh with broad planar facets,
   * water-worn rounded upstream shoulders, diverse aspect ratios, and deterministic
   * per-rock material attributes (aRockParams) without high-frequency procedural wrinkles.
   */
  private createSculptedRockGeometry(desc: RockDescriptor): THREE.BufferGeometry {
    const isNearCamera = desc.z > -2.6;
    const detail = isNearCamera && desc.radiusX > 0.55 ? 4 : isNearCamera ? 3 : 2;

    const rawGeo = new THREE.IcosahedronGeometry(1.0, detail);
    const geo = weldGeometryVertices(rawGeo);
    rawGeo.dispose();

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const count = pos.count;
    const colors = new Float32Array(count * 3);
    const rockParams = new Float32Array(count * 4);

    // Deterministic per-rock material parameters based on geological style and seed:
    // x: unique UV rotation & scale seed
    // y: crack & crevice density [0.14 .. 0.82]
    // z: base dry roughness [0.54 .. 0.88]
    // w: packed moss coverage [0..1] + foliation/vein weight
    const h1 = pcgHash(Math.round(desc.seed * 13.7) + desc.id * 31);
    const h2 = pcgHash(Math.round(desc.seed * 29.3) + desc.id * 53);

    let crackDensity = 0.38;
    let baseRoughness = 0.74;
    let flattenFactor = 1.0;

    if (desc.style === 'rounded-granite') {
      // Smooth river-worn granodiorite / quartzite boulder: minimal cracks, water-polished shoulders
      crackDensity = 0.14 + 0.14 * h1;
      baseRoughness = 0.56 + 0.10 * h2;
      flattenFactor = 0.84 + 0.14 * h1;
    } else if (desc.style === 'angular-slate') {
      // Angular weathered slate / greywacke: distinct cleavage facets, moderate localized joints
      crackDensity = 0.52 + 0.24 * h1;
      baseRoughness = 0.70 + 0.12 * h2;
      flattenFactor = 0.92 + 0.16 * h1;
    } else if (desc.style === 'layered-gneiss') {
      // Warm sedimentary / metamorphic gneiss: broader tabular form, granular roughness
      crackDensity = 0.36 + 0.22 * h1;
      baseRoughness = 0.78 + 0.10 * h2;
      flattenFactor = 0.82 + 0.16 * h2;
    } else {
      // Eroded basalt / dark mineral stone: smooth water-scoured hollows, medium-low roughness
      crackDensity = 0.28 + 0.20 * h1;
      baseRoughness = 0.64 + 0.12 * h2;
      flattenFactor = 0.88 + 0.18 * h1;
    }

    const uvSeed = desc.seed * 0.37 + h1 * 6.28318;
    const mossAmount = clamp01(desc.mossAmount);

    // Precompute 2 natural cleavage plane normals per rock for believable planar facets with worn edges
    const a1 = desc.seed * 1.13;
    const p1x = Math.cos(a1) * 0.78;
    const p1y = 0.48 + 0.22 * Math.sin(desc.seed);
    const p1z = Math.sin(a1) * 0.78;

    const a2 = desc.seed * 2.41 + 1.9;
    const p2x = Math.cos(a2) * 0.82;
    const p2y = 0.36 - 0.20 * Math.cos(desc.seed);
    const p2z = Math.sin(a2) * 0.82;

    for (let i = 0; i < count; i++) {
      const ux = pos.getX(i);
      const uy = pos.getY(i);
      const uz = pos.getZ(i);

      const angle = Math.atan2(uz, ux);
      // Low-frequency silhouette asymmetry (matches FlowField obstacle contour)
      const shapeMod =
        1.0 +
        0.13 * Math.sin(angle * 2.0 + desc.seed) +
        0.09 * Math.cos(angle * 3.0 - desc.seed * 1.7) +
        0.04 * Math.sin(angle * 4.0 + desc.seed * 0.9);

      // Stream-worn hydrodynamic profile: upstream side (uz < 0) is more gently sloped and worn smooth
      const streamWear = uz < 0.0 ? 1.0 + 0.08 * (-uz) : 1.0 - 0.04 * uz;

      let vx = (ux + 0.14 * uy * Math.sin(desc.seed)) * desc.radiusX * desc.asymmetry[0] * shapeMod;
      let vz = (uz + 0.12 * ux * Math.cos(desc.seed)) * desc.radiusZ * desc.asymmetry[2] * shapeMod * streamWear;
      let vy = uy * desc.radiusY * desc.asymmetry[1] * flattenFactor;

      // Flattened base embedded in the riverbed; naturally rounded or tabular upper crown
      if (vy < 0.0) {
        vy *= 0.56;
      } else {
        const crownPower = desc.style === 'rounded-granite' ? 0.88 : 0.78;
        vy = Math.pow(uy, crownPower) * desc.radiusY * desc.asymmetry[1] * flattenFactor;
      }

      // Broad, low-frequency geological facets & water-worn bevels (NO high-frequency sine ripples!)
      const dot1 = ux * p1x + uy * p1y + uz * p1z;
      const dot2 = ux * p2x + uy * p2y + uz * p2z;
      let styleDisp = 0.0;

      if (desc.style === 'angular-slate') {
        // Broad beveled cleavage faces with worn edges
        const bevel1 = Math.max(0.0, dot1 - 0.32) * 0.18;
        const bevel2 = Math.max(0.0, dot2 - 0.38) * 0.15;
        const ridgeCrest = (1.0 - Math.abs(dot1 - dot2)) * 0.045;
        styleDisp = -bevel1 - bevel2 + ridgeCrest;
      } else if (desc.style === 'layered-gneiss') {
        // Gentle, broad tabular terrace inclination (2-3 macro ledges per boulder, not 15 tiny rings)
        const macroStep = Math.tanh(Math.sin(uy * 3.2 + ux * 1.1 + desc.seed) * 1.6) * 0.032;
        const facetBevel = Math.max(0.0, dot1 - 0.42) * 0.12;
        styleDisp = macroStep - facetBevel;
      } else if (desc.style === 'eroded-basalt') {
        // Smooth water-scoured concave dish on flank + broad worn shoulder
        const scour = Math.max(0.0, dot2 - 0.25) * (1.0 - Math.max(0.0, dot2 - 0.25)) * 0.14;
        const shoulder = Math.max(0.0, dot1 - 0.45) * 0.10;
        styleDisp = -scour - shoulder;
      } else {
        // Smooth river-worn granodiorite / river cobble with subtle broad facet flattening
        const flatTop = Math.max(0.0, uy - 0.52) * 0.11;
        const sideBevel = Math.max(0.0, dot1 - 0.48) * 0.08;
        styleDisp = -flatTop - sideBevel;
      }

      // Low-frequency organic stone form undulation (octaves=2 at low frequency so faces stay smooth)
      const macroForm = fbm2D(vx * 1.15 + desc.seed, vz * 1.15 - desc.seed, 2) * 0.068;
      const radialDisp = 1.0 + macroForm + styleDisp;

      vx *= radialDisp;
      vy += (macroForm * 0.75 + styleDisp * 0.70) * desc.radiusY;
      vz *= radialDisp;

      pos.setXYZ(i, vx, vy, vz);

      // Smooth macro mineral color variation across the boulder (no high-frequency zebra stripes
      // and no harsh black basal ring)
      const macroToneNoise = fbm2D(vx * 0.95 + desc.seed * 0.7, vz * 0.95 - vy * 1.1, 2);
      const heightGrad = smoothstep(-0.35, 0.65, uy);
      const toneMix = clamp01(0.45 + 0.42 * macroToneNoise + 0.18 * (heightGrad - 0.5));

      const rCol = desc.colorTint[0] * (1.0 - toneMix) + desc.secondaryTint[0] * toneMix;
      const gCol = desc.colorTint[1] * (1.0 - toneMix) + desc.secondaryTint[1] * toneMix;
      const bCol = desc.colorTint[2] * (1.0 - toneMix) + desc.secondaryTint[2] * toneMix;

      // Subtle, natural convexity shading and gentle basal grounding (avoids dark base outlines!)
      const formShade = Math.max(0.84, Math.min(1.10, 0.97 + (radialDisp - 1.0) * 0.85));
      const gentleBasalAO = 0.84 + 0.16 * smoothstep(-0.65, 0.05, uy);
      const vertexShade = formShade * gentleBasalAO * 1.18;

      colors[i * 3 + 0] = rCol * vertexShade;
      colors[i * 3 + 1] = gCol * vertexShade;
      colors[i * 3 + 2] = bCol * vertexShade;

      rockParams[i * 4 + 0] = uvSeed;
      rockParams[i * 4 + 1] = crackDensity;
      rockParams[i * 4 + 2] = baseRoughness;
      rockParams[i * 4 + 3] = mossAmount;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aRockParams', new THREE.BufferAttribute(rockParams, 4));
    geo.computeVertexNormals();
    return geo;
  }

  private createCascadeAndClusterStones(flowField: FlowField): void {
    const extraStones: Array<{
      x: number;
      z: number;
      rx: number;
      ry: number;
      rz: number;
      rotY: number;
      style: RockDescriptor['style'];
      tint: [number, number, number];
      secTint: [number, number, number];
      moss: number;
    }> = [
      // Cascade ledge dividing stones (framing the pouring waterfall chutes)
      {
        x: -1.30,
        z: -2.02,
        rx: 0.45,
        ry: 0.32,
        rz: 0.41,
        rotY: 0.35,
        style: 'angular-slate',
        tint: [0.31, 0.30, 0.29],
        secTint: [0.36, 0.35, 0.34],
        moss: 0.34
      },
      {
        x: 0.14,
        z: -2.06,
        rx: 0.39,
        ry: 0.28,
        rz: 0.37,
        rotY: -0.22,
        style: 'eroded-basalt',
        tint: [0.26, 0.25, 0.24],
        secTint: [0.32, 0.29, 0.26],
        moss: 0.16
      },
      {
        x: 1.38,
        z: -1.96,
        rx: 0.51,
        ry: 0.35,
        rz: 0.45,
        rotY: 0.52,
        style: 'layered-gneiss',
        tint: [0.46, 0.36, 0.27],
        secTint: [0.34, 0.28, 0.22],
        moss: 0.42
      },
      {
        x: -3.18,
        z: -1.85,
        rx: 1.10,
        ry: 0.62,
        rz: 0.90,
        rotY: -0.18,
        style: 'layered-gneiss',
        tint: [0.35, 0.35, 0.30],
        secTint: [0.27, 0.28, 0.24],
        moss: 0.72
      },
      {
        x: 3.12,
        z: -1.78,
        rx: 1.14,
        ry: 0.64,
        rz: 0.92,
        rotY: 0.28,
        style: 'angular-slate',
        tint: [0.29, 0.31, 0.28],
        secTint: [0.23, 0.25, 0.23],
        moss: 0.68
      },
      // Natural companion cluster stones (flattened river cobbles & weathered fragments beside main boulders)
      {
        x: 1.08,
        z: 3.42,
        rx: 0.35,
        ry: 0.19,
        rz: 0.29,
        rotY: 1.12,
        style: 'rounded-granite',
        tint: [0.54, 0.49, 0.43],
        secTint: [0.41, 0.38, 0.34],
        moss: 0.06
      },
      {
        x: -0.46,
        z: 1.28,
        rx: 0.36,
        ry: 0.22,
        rz: 0.31,
        rotY: -0.84,
        style: 'eroded-basalt',
        tint: [0.29, 0.28, 0.27],
        secTint: [0.35, 0.34, 0.32],
        moss: 0.14
      },
      {
        x: -1.24,
        z: 2.68,
        rx: 0.32,
        ry: 0.17,
        rz: 0.27,
        rotY: 0.45,
        style: 'rounded-granite',
        tint: [0.47, 0.38, 0.29],
        secTint: [0.36, 0.30, 0.24],
        moss: 0.10
      }
    ];

    extraStones.forEach((s, idx) => {
      const waterY = flowField.getBaseWaterHeight(s.x, s.z);
      const r1 = pcgHash(idx * 23 + 77);
      const desc: RockDescriptor = {
        id: 100 + idx,
        x: s.x,
        y: waterY - s.ry * 0.46,
        z: s.z,
        radiusX: s.rx,
        radiusY: s.ry,
        radiusZ: s.rz,
        rotationY: s.rotY,
        rotationX: (r1 - 0.5) * 0.16,
        rotationZ: (pcgHash(idx * 41 + 99) - 0.5) * 0.16,
        seed: 77.3 + idx * 11.7,
        submersionType: 'ledge',
        style: s.style,
        asymmetry: [0.90 + r1 * 0.24, 0.92, 1.10 - r1 * 0.18],
        colorTint: s.tint,
        secondaryTint: s.secTint,
        mossAmount: s.moss
      };
      const geo = this.createSculptedRockGeometry(desc);
      const mesh = new THREE.Mesh(geo, this.rockMaterial);
      mesh.position.set(desc.x, desc.y, desc.z);
      mesh.rotation.set(desc.rotationX, desc.rotationY, desc.rotationZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.renderOrder = -3;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }

  public dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
    }
    this.rockMaterial.dispose();
  }
}
