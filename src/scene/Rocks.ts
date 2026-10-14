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

    // Deterministic per-rock material parameters based on geological family and seed:
    // x: unique per-rock UV rotation & scale seed (uvAngle)
    // y: material family ID (0 = Material A Weathered Granite, 1 = Material B Dark River Stone, 2 = Material C Sedimentary Stone)
    // z: fracture & weathering intensity [0.24 .. 0.68]
    // w: moss/periphyton coverage [0.0 .. 0.88]
    const h1 = pcgHash(Math.round(desc.seed * 13.7) + desc.id * 31);
    const h2 = pcgHash(Math.round(desc.seed * 29.3) + desc.id * 53);

    let familyId = 0.0;
    let crackDensity = 0.36;
    let flattenFactor = 1.0;

    if (desc.style === 'rounded-granite') {
      // Material A — Weathered Granite: medium gray, fine crystalline grain, moderate roughness, occasional small fractures
      familyId = 0.0;
      crackDensity = 0.26 + 0.16 * h1;
      flattenFactor = 0.86 + 0.12 * h2;
    } else if (desc.style === 'eroded-basalt') {
      // Material B — Dark River Stone: charcoal & muted brown, slightly smoother surface, sparse fractures
      familyId = 1.0;
      crackDensity = 0.32 + 0.20 * h1;
      flattenFactor = 0.88 + 0.14 * h2;
    } else {
      // Material C — Sedimentary Stone (layered-gneiss & angular-slate): warm gray-brown, broad layering, mixed worn & rough
      familyId = 2.0;
      crackDensity = 0.42 + 0.24 * h1;
      flattenFactor = desc.style === 'layered-gneiss' ? 0.82 + 0.14 * h2 : 0.90 + 0.14 * h1;
    }

    const uvAngle = desc.seed * 0.41 + h1 * 6.28318;
    const mossAmount = clamp01(desc.mossAmount);

    // Precompute 3 natural cleavage/erosion plane normals per rock for believable geological facets
    const a1 = desc.seed * 1.13 + 0.4;
    const p1x = Math.cos(a1) * 0.78;
    const p1y = 0.46 + 0.22 * Math.sin(desc.seed);
    const p1z = Math.sin(a1) * 0.78;

    const a2 = desc.seed * 2.41 + 1.9;
    const p2x = Math.cos(a2) * 0.82;
    const p2y = 0.34 - 0.22 * Math.cos(desc.seed);
    const p2z = Math.sin(a2) * 0.82;

    const a3 = desc.seed * 3.73 - 0.8;
    const p3x = Math.cos(a3) * 0.74;
    const p3y = -0.18 + 0.28 * Math.sin(desc.seed * 1.7);
    const p3z = Math.sin(a3) * 0.74;

    for (let i = 0; i < count; i++) {
      const ux = pos.getX(i);
      const uy = pos.getY(i);
      const uz = pos.getZ(i);

      const angle = Math.atan2(uz, ux);
      // Low-frequency silhouette asymmetry (matches FlowField obstacle contour)
      const shapeMod =
        1.0 +
        0.14 * Math.sin(angle * 2.0 + desc.seed) +
        0.10 * Math.cos(angle * 3.0 - desc.seed * 1.7) +
        0.05 * Math.sin(angle * 4.0 + desc.seed * 0.9);

      // Stream-worn hydrodynamic profile: upstream side (uz < 0) is worn smoother and more sloped,
      // while basal skirt flares slightly outward so boulders sit firmly embedded in the riverbed
      const streamWear = uz < 0.0 ? 1.0 + 0.09 * (-uz) : 1.0 - 0.04 * uz;
      const basalSkirt = uy < -0.12 ? 1.0 + Math.min(0.20, (-0.12 - uy) * 0.24) : 1.0;

      let vx = (ux + 0.14 * uy * Math.sin(desc.seed)) * desc.radiusX * desc.asymmetry[0] * shapeMod * basalSkirt;
      let vz = (uz + 0.12 * ux * Math.cos(desc.seed)) * desc.radiusZ * desc.asymmetry[2] * shapeMod * streamWear * basalSkirt;
      let vy = uy * desc.radiusY * desc.asymmetry[1] * flattenFactor;

      // Firmly embedded lower base in riverbed; naturally weathered upper crown
      if (vy < 0.0) {
        vy *= 0.72;
      } else {
        const crownPower = desc.style === 'rounded-granite' ? 0.88 : 0.78;
        vy = Math.pow(uy, crownPower) * desc.radiusY * desc.asymmetry[1] * flattenFactor;
      }

      // Geological facets, fracture steps, and water-scoured hollows per variant
      const dot1 = ux * p1x + uy * p1y + uz * p1z;
      const dot2 = ux * p2x + uy * p2y + uz * p2z;
      const dot3 = ux * p3x + uy * p3y + uz * p3z;
      let styleDisp = 0.0;

      if (desc.style === 'angular-slate') {
        const bevel1 = Math.max(0.0, dot1 - 0.28) * 0.20;
        const bevel2 = Math.max(0.0, dot2 - 0.34) * 0.17;
        const bevel3 = Math.max(0.0, dot3 - 0.40) * 0.12;
        const ridgeCrest = (1.0 - Math.min(1.0, Math.abs(dot1 - dot2) * 1.4)) * 0.042;
        styleDisp = -bevel1 - bevel2 - bevel3 + ridgeCrest;
      } else if (desc.style === 'layered-gneiss') {
        const terracePlane1 = Math.max(0.0, dot1 - 0.32) * 0.15;
        const terracePlane2 = Math.max(0.0, uy * 0.85 + ux * 0.35 - 0.38) * 0.12;
        const gentleLedge = Math.tanh((uy + ux * 0.35 - 0.05) * 2.2) * 0.026;
        styleDisp = gentleLedge - terracePlane1 - terracePlane2;
      } else if (desc.style === 'eroded-basalt') {
        const scour = Math.max(0.0, dot2 - 0.22) * (1.0 - Math.max(0.0, dot2 - 0.22)) * 0.16;
        const jointBevel = Math.max(0.0, dot3 - 0.34) * 0.12;
        const shoulder = Math.max(0.0, dot1 - 0.38) * 0.13;
        styleDisp = -scour - jointBevel - shoulder;
      } else {
        const flatTop = Math.max(0.0, uy - 0.48) * 0.12;
        const sideBevel = Math.max(0.0, dot1 - 0.42) * 0.10;
        const subFacet = Math.max(0.0, dot3 - 0.45) * 0.07;
        styleDisp = -flatTop - sideBevel - subFacet;
      }

      const normX = ux + 0.15 * uy;
      const normZ = uz - 0.15 * uy;
      const macroForm = (fbm2D(normX * 1.15 + desc.seed, normZ * 1.15 - desc.seed, 2) - 0.5) * 0.12;
      const radialDisp = 1.0 + macroForm + styleDisp;

      vx *= radialDisp;
      vy += (macroForm * 0.78 + styleDisp * 0.74) * desc.radiusY;
      vz *= radialDisp;

      pos.setXYZ(i, vx, vy, vz);

      // Broad, asymmetric macro mineral regions across the boulder
      const macroToneNoise = fbm2D(normX * 0.95 + desc.seed * 0.7, normZ * 0.95 - uy * 0.85, 2);
      const secondaryPatch = fbm2D(normX * 1.65 - desc.seed * 1.4, normZ * 1.65 + uy * 1.1, 2);
      const heightGrad = smoothstep(-0.35, 0.65, uy);
      const rawMix = (macroToneNoise - 0.48) * 1.35 + (secondaryPatch - 0.5) * 0.55 + (heightGrad - 0.5) * 0.30;
      const toneMix = clamp01(0.5 + rawMix);

      const rCol = desc.colorTint[0] * (1.0 - toneMix) + desc.secondaryTint[0] * toneMix;
      const gCol = desc.colorTint[1] * (1.0 - toneMix) + desc.secondaryTint[1] * toneMix;
      const bCol = desc.colorTint[2] * (1.0 - toneMix) + desc.secondaryTint[2] * toneMix;

      const reliefDelta = macroForm + styleDisp * 0.85;
      const formShade = Math.max(0.78, Math.min(1.12, 0.97 + reliefDelta * 1.25));
      const gentleBasalAO = 0.84 + 0.16 * smoothstep(-0.68, 0.08, uy);
      const vertexShade = formShade * gentleBasalAO * 1.16;

      colors[i * 3 + 0] = rCol * vertexShade;
      colors[i * 3 + 1] = gCol * vertexShade;
      colors[i * 3 + 2] = bCol * vertexShade;

      rockParams[i * 4 + 0] = uvAngle;
      rockParams[i * 4 + 1] = familyId;
      rockParams[i * 4 + 2] = crackDensity;
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
        tint: [0.33, 0.36, 0.34],
        secTint: [0.21, 0.25, 0.22],
        moss: 0.44
      },
      {
        x: 0.14,
        z: -2.06,
        rx: 0.39,
        ry: 0.28,
        rz: 0.37,
        rotY: -0.22,
        style: 'eroded-basalt',
        tint: [0.21, 0.23, 0.25],
        secTint: [0.35, 0.29, 0.23],
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
        tint: [0.47, 0.39, 0.30],
        secTint: [0.31, 0.25, 0.20],
        moss: 0.42
      },
      {
        x: -3.18,
        z: -1.85,
        rx: 1.10,
        ry: 0.62,
        rz: 0.90,
        rotY: -0.18,
        style: 'angular-slate',
        tint: [0.35, 0.38, 0.34],
        secTint: [0.23, 0.27, 0.22],
        moss: 0.74
      },
      {
        x: 3.12,
        z: -1.78,
        rx: 1.14,
        ry: 0.64,
        rz: 0.92,
        rotY: 0.28,
        style: 'angular-slate',
        tint: [0.33, 0.36, 0.32],
        secTint: [0.22, 0.26, 0.21],
        moss: 0.70
      },
      // Natural companion cluster stones (flattened river cobbles & weathered fragments firmly embedded beside main boulders)
      {
        x: 1.08,
        z: 3.42,
        rx: 0.35,
        ry: 0.20,
        rz: 0.29,
        rotY: 1.12,
        style: 'rounded-granite',
        tint: [0.56, 0.53, 0.49],
        secTint: [0.37, 0.35, 0.33],
        moss: 0.06
      },
      {
        x: -0.46,
        z: 1.28,
        rx: 0.36,
        ry: 0.23,
        rz: 0.31,
        rotY: -0.84,
        style: 'eroded-basalt',
        tint: [0.22, 0.24, 0.26],
        secTint: [0.36, 0.30, 0.24],
        moss: 0.14
      },
      {
        x: -1.24,
        z: 2.68,
        rx: 0.32,
        ry: 0.19,
        rz: 0.27,
        rotY: 0.45,
        style: 'layered-gneiss',
        tint: [0.48, 0.40, 0.31],
        secTint: [0.33, 0.27, 0.21],
        moss: 0.10
      }
    ];

    extraStones.forEach((s, idx) => {
      const waterY = flowField.getBaseWaterHeight(s.x, s.z);
      const bedY = flowField.getRiverbedHeight(s.x, s.z);
      const r1 = pcgHash(idx * 23 + 77);
      const desc: RockDescriptor = {
        id: 100 + idx,
        x: s.x,
        y: Math.min(waterY - s.ry * 0.48, bedY + s.ry * 0.28),
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
