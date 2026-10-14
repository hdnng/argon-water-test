import * as THREE from 'three';

export class Lighting {
  public readonly group: THREE.Group;
  public readonly sunLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly fillLight: THREE.DirectionalLight;
  public readonly sunDirection: THREE.Vector3;

  constructor(shadowMapSize: number, shadowsEnabled: boolean) {
    this.group = new THREE.Group();

    // Grazing mid-morning/afternoon mountain sun angle:
    // Rakes across the rock fracture planes, wet shoreline rims, waterfall ribs, and ripples
    this.sunDirection = new THREE.Vector3(-0.52, 0.58, -0.63).normalize();

    this.sunLight = new THREE.DirectionalLight(0xfff4e2, 3.05);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(18.0);
    this.sunLight.castShadow = shadowsEnabled;

    this.sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sunLight.shadow.camera.near = 2.0;
    this.sunLight.shadow.camera.far = 34.0;
    const d = 8.8;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.015;

    // Balanced sky-to-riverbed ambient hemisphere illumination for deep crevice contrast
    this.hemiLight = new THREE.HemisphereLight(0x94bce0, 0x342d24, 0.78);
    this.hemiLight.position.set(0, 15, 0);

    // Subtle cool sky bounce light from opposite valley wall
    this.fillLight = new THREE.DirectionalLight(0x82add6, 0.42);
    this.fillLight.position.set(8.0, 6.5, 9.0);

    this.group.add(this.sunLight);
    this.group.add(this.hemiLight);
    this.group.add(this.fillLight);
  }

  public updateQuality(shadowMapSize: number, shadowsEnabled: boolean): void {
    this.sunLight.castShadow = shadowsEnabled;
    if (
      shadowsEnabled &&
      (this.sunLight.shadow.mapSize.width !== shadowMapSize ||
        this.sunLight.shadow.mapSize.height !== shadowMapSize)
    ) {
      this.sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
  }

  public dispose(): void {
    if (this.sunLight.shadow.map) {
      this.sunLight.shadow.map.dispose();
    }
  }
}
