import * as THREE from 'three';
import { FlowField, STREAM_DOMAIN, CASCADE_CHUTES } from './FlowField';
import foamVert from '../shaders/foam.vert.glsl';
import foamFrag from '../shaders/foam.frag.glsl';

interface FoamParticleState {
  x: number;
  z: number;
  age: number;
  lifetime: number;
  scaleX: number;
  scaleZ: number;
  seed: number;
  kind: number;
}

export class FoamSystem {
  public readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly maxCount = 850;
  private activeCount: number;

  private readonly particles: FoamParticleState[] = [];
  private readonly offsetArray: Float32Array;
  private readonly propsArray: Float32Array;
  private readonly offsetAttr: THREE.InstancedBufferAttribute;
  private readonly propsAttr: THREE.InstancedBufferAttribute;

  private spawnLocations: Array<{ x: number; z: number; spreadX: number; spreadZ: number; weight: number }> = [];

  constructor(
    flowField: FlowField,
    sunDirection: THREE.Vector3,
    noiseTexture: THREE.Texture,
    initialCount: number
  ) {
    this.activeCount = Math.min(this.maxCount, initialCount);

    this.buildSpawnTable(flowField);

    // 1x1 plane (2 triangles instead of 8 triangles per instance — cuts foam vertex work by 75%!)
    const basePlane = new THREE.PlaneGeometry(1.0, 1.0, 1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = basePlane.index;
    this.geometry.attributes.position = basePlane.attributes.position;
    this.geometry.attributes.uv = basePlane.attributes.uv;

    this.offsetArray = new Float32Array(this.maxCount * 3);
    this.propsArray = new Float32Array(this.maxCount * 4);

    this.offsetAttr = new THREE.InstancedBufferAttribute(this.offsetArray, 3);
    this.offsetAttr.setUsage(THREE.DynamicDrawUsage);
    this.propsAttr = new THREE.InstancedBufferAttribute(this.propsArray, 4);
    this.propsAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('aOffset', this.offsetAttr);
    this.geometry.setAttribute('aProps', this.propsAttr);
    this.geometry.instanceCount = this.activeCount;

    for (let i = 0; i < this.maxCount; i++) {
      const p: FoamParticleState = {
        x: 0,
        z: 0,
        age: 0,
        lifetime: 2.0,
        scaleX: 0.2,
        scaleZ: 0.3,
        seed: i * 1.73 + 0.5,
        kind: i % 3
      };
      this.respawnParticle(p, flowField, true);
      this.particles.push(p);
    }

    this.syncBuffers();

    this.material = new THREE.ShaderMaterial({
      vertexShader: foamVert,
      fragmentShader: foamFrag,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDirection.clone().normalize() },
        uFlowMap: { value: flowField.flowTexture },
        uTerrainMap: { value: flowField.terrainTexture },
        uNoiseTex: { value: noiseTexture }
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  private buildSpawnTable(flowField: FlowField): void {
    // 1. Spawn foam specifically at the waterfall pouring chute impact zones
    for (const chute of CASCADE_CHUTES) {
      this.spawnLocations.push({
        x: chute.centerX + chute.skewX * 0.85,
        z: chute.dropEndZ + 0.05,
        spreadX: chute.width * 0.34,
        spreadZ: 0.16,
        weight: 2.0
      });
    }

    // 2. Around each emergent, semi-submerged, or submerged rock obstacle
    for (const rock of flowField.rocks) {
      if (rock.submersionType === 'bank') continue;
      // Left and right flow-separation flanks
      this.spawnLocations.push({
        x: rock.x - rock.radiusX * 0.66,
        z: rock.z - rock.radiusZ * 0.08,
        spreadX: rock.radiusX * 0.24,
        spreadZ: rock.radiusZ * 0.24,
        weight: 1.6
      });
      this.spawnLocations.push({
        x: rock.x + rock.radiusX * 0.66,
        z: rock.z - rock.radiusZ * 0.08,
        spreadX: rock.radiusX * 0.24,
        spreadZ: rock.radiusZ * 0.24,
        weight: 1.6
      });
      // Offset leeward vortex shedding pockets behind the boulder
      this.spawnLocations.push({
        x: rock.x + (rock.id % 2 === 0 ? -1 : 1) * rock.radiusX * 0.26,
        z: rock.z + rock.radiusZ * 0.62,
        spreadX: rock.radiusX * 0.38,
        spreadZ: rock.radiusZ * 0.30,
        weight: 1.8
      });
    }
  }

  private respawnParticle(p: FoamParticleState, flowField: FlowField, randomAge = false): void {
    const idx = Math.floor(Math.random() * this.spawnLocations.length);
    const loc = this.spawnLocations[idx];

    p.x = loc.x + (Math.random() - 0.5) * 2.0 * loc.spreadX;
    p.z = loc.z + (Math.random() - 0.5) * 2.0 * loc.spreadZ;
    p.lifetime = 1.7 + Math.random() * 2.3;
    p.age = randomAge ? Math.random() * p.lifetime : 0.0;

    // All particle types are cohesive organic patches or elongated flow streaks (NO small isolated dots!)
    const kindRoll = Math.random();
    if (kindRoll < 0.38) {
      // Irregular organic turbulent foam patch
      p.kind = 0;
      p.scaleX = 0.18 + Math.random() * 0.14;
      p.scaleZ = 0.28 + Math.random() * 0.26;
    } else if (kindRoll < 0.76) {
      // Elongated flow-aligned shear ribbon
      p.kind = 1;
      p.scaleX = 0.13 + Math.random() * 0.10;
      p.scaleZ = 0.34 + Math.random() * 0.34;
    } else {
      // Medium swirling eddy foam plume
      p.kind = 2;
      p.scaleX = 0.16 + Math.random() * 0.12;
      p.scaleZ = 0.24 + Math.random() * 0.22;
    }

    if (randomAge && p.age > 0.01) {
      const steps = 5;
      const stepDt = p.age / steps;
      for (let s = 0; s < steps; s++) {
        const sample = flowField.sampleFlow(p.x, p.z);
        p.x += sample.vx * stepDt * 0.85;
        p.z += sample.vz * stepDt * 0.85;
      }
    }
  }

  private syncBuffers(): void {
    for (let i = 0; i < this.activeCount; i++) {
      const p = this.particles[i];
      const oIdx = i * 3;
      this.offsetArray[oIdx + 0] = p.x;
      this.offsetArray[oIdx + 1] = p.seed;
      this.offsetArray[oIdx + 2] = p.z;

      const pIdx = i * 4;
      this.propsArray[pIdx + 0] = p.scaleX;
      this.propsArray[pIdx + 1] = p.scaleZ;
      this.propsArray[pIdx + 2] = Math.min(1.0, p.age / p.lifetime);
      this.propsArray[pIdx + 3] = p.kind;
    }
    this.offsetAttr.needsUpdate = true;
    this.propsAttr.needsUpdate = true;
  }

  public update(flowField: FlowField, elapsedTime: number, dt: number): void {
    if (!this.mesh.visible) return;
    this.material.uniforms.uTime.value = elapsedTime;

    const clampedDt = Math.min(0.05, dt);
    for (let i = 0; i < this.activeCount; i++) {
      const p = this.particles[i];
      p.age += clampedDt;

      if (p.age >= p.lifetime || p.z > STREAM_DOMAIN.maxZ - 0.5) {
        this.respawnParticle(p, flowField, false);
      } else {
        const flow = flowField.sampleFlow(p.x, p.z);
        p.x += flow.vx * clampedDt * 0.88;
        p.z += flow.vz * clampedDt * 0.88;

        if (flow.sdf < 0.02) {
          p.x += (p.x > 0 ? 1 : -1) * clampedDt * 0.45;
        }
      }
    }

    this.syncBuffers();
  }

  public setCount(count: number): void {
    this.activeCount = Math.min(this.maxCount, count);
    this.geometry.instanceCount = this.activeCount;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
