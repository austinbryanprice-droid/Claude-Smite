import * as THREE from 'three/webgpu';
import {
  cameraPosition, dot, exp, float, fog, max, min, mix, positionWorld, pow, uniform, vec3, vec4,
} from '../render/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import type { QualitySettings } from '../render/Quality';

/**
 * Sky, sun, image-based lighting and atmosphere.
 *
 * The sky is a physically based scattering model (Preetham) with procedural
 * clouds. The same sky is rendered into a prefiltered (PMREM) environment map,
 * so the ambient and reflected light always match the visible sky and sun
 * angle, which is what an HDRI does in UE but without a fixed photo.
 */
export class Environment {
  readonly sky: SkyMesh;
  readonly sun: THREE.DirectionalLight;
  readonly sunDirection = new THREE.Vector3();
  private csm: CSMShadowNode | null = null;
  private envTarget: THREE.RenderTarget | null = null;

  /** Brightness multiplier that puts the sky model in the same units as the sun. */
  readonly skyScale = uniform(0.5);
  readonly fogDensity = uniform(0.0068);
  readonly fogHeightFalloff = uniform(0.028);
  readonly fogColor = uniform(new THREE.Color(0.44, 0.5, 0.8));
  readonly sunColor = new THREE.Color(1.0, 0.86, 0.68);

  /** Sun elevation and azimuth in degrees. Late-morning sun gives long, readable shadows. */
  elevation = 36;
  azimuth = -142;

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera) {
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(4000);
    this.sky.turbidity.value = 2.2;
    this.sky.rayleigh.value = 2.6;
    this.sky.mieCoefficient.value = 0.004;
    this.sky.mieDirectionalG.value = 0.82;
    this.sky.cloudCoverage.value = 0.55;
    this.sky.cloudDensity.value = 0.9;
    this.sky.cloudElevation.value = 0.55;
    this.sky.cloudScale.value = 0.00028;
    this.sky.cloudSpeed.value = 0.00001;
    const mat = this.sky.material as THREE.NodeMaterial;
    const baseColor = mat.colorNode as any;
    mat.colorNode = vec4(baseColor.rgb.mul(this.skyScale), 1);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(this.sunColor, 5.5);
    this.sun.castShadow = true;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.updateSunDirection();
    this.scene.fogNode = this.buildFog();
  }

  private updateSunDirection(): void {
    const phi = THREE.MathUtils.degToRad(90 - this.elevation);
    const theta = THREE.MathUtils.degToRad(this.azimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    this.sky.sunPosition.value.copy(this.sunDirection);
    this.sun.position.copy(this.sunDirection).multiplyScalar(200);
    this.sun.target.position.set(0, 0, 0);
  }

  /**
   * Exponential height fog with sun-tinted in-scattering (like UE's Exponential
   * Height Fog with a directional inscattering lobe). Thicker in the valley,
   * thinner up the cliffs, glowing toward the sun.
   */
  private buildFog(): any {
    const sunDir = uniform(this.sunDirection);
    const sunTint = uniform(new THREE.Color(1.0, 0.8, 0.55));
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = toFrag.length();
    const viewDir = toFrag.div(dist.max(1e-3));
    // Integrate density along the ray through a medium that thins exponentially
    // with height: d(h) = density * exp(-k h).
    const k = this.fogHeightFalloff;
    const kdy = k.mul(toFrag.y);
    const safeKdy = kdy.abs().max(1e-3).mul(kdy.sign().add(kdy.equal(0).select(1, 0)));
    const lineInt = exp(k.mul(cameraPosition.y.max(0)).negate()).mul(float(1).sub(exp(safeKdy.negate())).div(safeKdy));
    const optical = this.fogDensity.mul(dist).mul(lineInt);
    const factor = float(1).sub(exp(optical.negate())).clamp(0, 0.95);
    const sunAmount = pow(max(dot(viewDir, sunDir), 0), float(8));
    const fogCol = mix(this.fogColor, sunTint.mul(1.6), sunAmount.mul(0.7));
    return fog(fogCol, factor);
  }

  applyQuality(renderer: THREE.WebGPURenderer, q: QualitySettings): void {
    const s = this.sun.shadow;
    s.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    s.camera.near = 1;
    s.camera.far = 600;
    s.bias = -0.0002;
    s.normalBias = 0.04;
    s.radius = 3;
    const ext = 260;
    const cam = s.camera as THREE.OrthographicCamera;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.updateProjectionMatrix();
    if (s.map) {
      s.map.dispose();
      s.map = null as any;
    }
    this.csm?.dispose();
    this.csm = new CSMShadowNode(this.sun, {
      cascades: q.shadowCascades,
      maxFar: q.shadowDistance,
      mode: 'practical',
      lightMargin: 80,
    });
    this.csm.fade = true;
    s.shadowNode = this.csm as any;
    renderer.shadowMap.enabled = true;
  }

  /** Bakes the current sky into the scene environment (ambient + reflections). */
  bakeEnvironment(renderer: THREE.WebGPURenderer, groundColor: THREE.Color): void {
    const envScene = new THREE.Scene();
    const sky = new SkyMesh();
    sky.scale.setScalar(100);
    for (const key of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity', 'cloudElevation', 'cloudScale'] as const) {
      (sky[key] as any).value = (this.sky[key] as any).value;
    }
    sky.sunPosition.value.copy(this.sunDirection);
    sky.showSunDisc.value = 0; // the directional light already provides the sun
    const smat = sky.material as THREE.NodeMaterial;
    // Clamp the bright Mie lobe around the sun: the directional light already
    // provides that energy, and leaving it in the map makes specular blotchy.
    smat.colorNode = vec4(min((smat.colorNode as any).rgb.mul(this.skyScale), vec3(2.5)), 1);
    envScene.add(sky);
    // A lit ground disc so the lower hemisphere bounces warm light back up,
    // the way the ground in a real HDRI does.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(90, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicNodeMaterial({ color: groundColor }),
    );
    ground.position.y = -2;
    envScene.add(ground);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget?.dispose();
    this.envTarget = pmrem.fromScene(envScene, 0.0, 0.1, 400);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 1.05;
    pmrem.dispose();
    sky.geometry.dispose();
    ground.geometry.dispose();
  }

  update(): void {
    // Keep the sky dome centered on the camera so it never clips.
    this.sky.position.copy(this.camera.position);
  }
}
