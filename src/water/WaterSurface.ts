import * as THREE from 'three';
import { STREAM_DOMAIN } from './FlowField';
import { WaterMaterial } from './WaterMaterial';

export class WaterSurface {
  public readonly mesh: THREE.Mesh;
  public readonly material: WaterMaterial;

  constructor(material: WaterMaterial, segmentsX: number, segmentsZ: number) {
    this.material = material;
    const geometry = this.buildSurfaceGeometry(segmentsX, segmentsZ);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  private buildSurfaceGeometry(segmentsX: number, segmentsZ: number): THREE.BufferGeometry {
    const geo = new THREE.PlaneGeometry(
      STREAM_DOMAIN.width,
      STREAM_DOMAIN.length,
      segmentsX,
      segmentsZ
    );
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  public updateGeometryResolution(segmentsX: number, segmentsZ: number): void {
    const oldGeo = this.mesh.geometry;
    this.mesh.geometry = this.buildSurfaceGeometry(segmentsX, segmentsZ);
    oldGeo.dispose();
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
