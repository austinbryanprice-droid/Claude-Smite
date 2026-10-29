import * as THREE from 'three/webgpu';
import {
  builtinAOContext, cdl, float, Fn, hash, mrt, normalView, output, packNormalToRGB, pass,
  renderOutput, sample, screenUV, smoothstep, time, uniform, unpackRGBToNormal, vec3, vec4, velocity,
} from './tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { QualitySettings } from './Quality';

/** Artist controls for the final image. Values are live uniforms. */
export const grading = {
  exposure: uniform(0.85),
  /** ASC CDL in display space: slope (gain), offset (lift), power (gamma). */
  slope: uniform(new THREE.Vector3(1.05, 1.0, 0.94)),
  offset: uniform(new THREE.Vector3(-0.016, -0.01, 0.006)),
  power: uniform(new THREE.Vector3(1.14, 1.12, 1.09)),
  saturation: uniform(1.25),
  vignette: uniform(0.32),
  grain: uniform(0.025),
  bloomStrength: uniform(0.22),
  bloomRadius: uniform(0.55),
  bloomThreshold: uniform(0.9),
};

/**
 * Builds and owns the post-processing chain:
 *
 *   [depth/normal pre-pass] -> GTAO -> scene pass (AO feeds the ambient term)
 *   -> TRAA (or SMAA/FXAA at the end) -> bloom -> tone map -> color grade
 *   -> vignette + film grain
 *
 * The chain is rebuilt whenever quality changes. Gameplay never touches this;
 * it only adds objects to the scene.
 */
export class PostFX {
  readonly pipeline: THREE.RenderPipeline;
  private disposables: { dispose(): void }[] = [];
  private bloomNode: ReturnType<typeof bloom> | null = null;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
  }

  build(q: QualitySettings): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.bloomNode = null;
    const { scene, camera } = this;

    const scenePass = pass(scene, camera);
    let depthNode: any;
    let velocityNode: any;

    if (q.ao) {
      // Pre-pass writes view normals + velocity so GTAO can run before lighting
      // and modulate only indirect light (like UE's SSAO/GTAO in the base pass).
      const prePass = pass(scene, camera);
      prePass.name = 'Pre-Pass';
      prePass.transparent = false;
      prePass.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }));
      prePass.getTexture('output').type = THREE.UnsignedByteType;
      const prePassNormal = sample((uv: any) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
      depthNode = prePass.getTextureNode('depth');
      velocityNode = prePass.getTextureNode('velocity');

      const aoPass = ao(depthNode, prePassNormal, camera);
      aoPass.resolutionScale = q.aoResolution;
      aoPass.samples.value = q.aoSamples;
      aoPass.radius.value = 0.9;
      aoPass.distanceExponent.value = 1.4;
      aoPass.thickness.value = 1.2;
      aoPass.scale.value = 1.0;
      aoPass.useTemporalFiltering = q.antiAliasing === 'traa';
      this.disposables.push(aoPass, prePass);
      scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
    } else if (q.antiAliasing === 'traa') {
      scenePass.setMRT(mrt({ output, velocity }));
      depthNode = scenePass.getTextureNode('depth');
      velocityNode = scenePass.getTextureNode('velocity');
    }
    this.disposables.push(scenePass);

    let hdr: any = scenePass.getTextureNode('output');
    if (q.antiAliasing === 'traa') {
      const t = traa(scenePass, depthNode, velocityNode, camera);
      t.useSubpixelCorrection = false;
      this.disposables.push(t);
      hdr = t;
    }

    if (q.bloom) {
      const b = bloom(hdr, grading.bloomStrength.value, grading.bloomRadius.value, grading.bloomThreshold.value);
      this.bloomNode = b;
      this.disposables.push(b);
      hdr = hdr.add(b);
    }

    const graded = Fn(() => {
      const exposed = vec4(hdr.rgb.mul(grading.exposure), 1);
      const display = renderOutput(exposed, this.renderer.toneMapping, THREE.SRGBColorSpace);
      const c = cdl(display, grading.slope, grading.offset, grading.power, grading.saturation).rgb.toVar();
      // Vignette: darkens corners to frame the action.
      const d = screenUV.sub(0.5).mul(vec3(1.0, 0.75, 0).xy).length();
      c.mulAssign(float(1).sub(smoothstep(0.35, 0.95, d).mul(grading.vignette)));
      // Fine film grain, also dithers away banding in the sky.
      const n = hash(screenUV.mul(vec3(1931.7, 1137.3, 0).xy).add(time.mul(13.1)).dot(vec3(1, 57, 0).xy)).sub(0.5);
      c.addAssign(n.mul(grading.grain));
      return vec4(c, 1);
    })();

    let out: any = graded;
    if (q.antiAliasing === 'smaa') out = smaa(graded);
    else if (q.antiAliasing === 'fxaa') out = fxaa(graded);

    this.pipeline.outputNode = out;
    this.pipeline.needsUpdate = true;
  }

  render(): void {
    if (this.bloomNode) {
      this.bloomNode.strength.value = grading.bloomStrength.value;
      this.bloomNode.radius.value = grading.bloomRadius.value;
      this.bloomNode.threshold.value = grading.bloomThreshold.value;
    }
    this.pipeline.render();
  }
}
