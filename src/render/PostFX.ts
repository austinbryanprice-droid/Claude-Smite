import * as THREE from 'three/webgpu';
import {
  builtinAOContext, cdl, float, floor, Fn, hash, int, ivec2, max, min, mrt, output, pass,
  renderOutput, screenUV, smoothstep, texture, textureLoad, textureSize, time, uniform, vec2, vec3,
  vec4, velocity,
} from './tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { QualitySettings } from './Quality';

/** Artist controls for the final image. Values are live uniforms. */
export const grading = {
  exposure: uniform(0.92),
  /**
   * ASC CDL in display space: slope (gain), offset (lift), power (gamma).
   * Kept close to neutral: a lifted blue offset veils the whole frame, and a
   * power above 1 crushes everything in shadow.
   */
  slope: uniform(new THREE.Vector3(1.04, 1.0, 0.96)),
  offset: uniform(new THREE.Vector3(-0.01, -0.01, -0.008)),
  power: uniform(new THREE.Vector3(1.04, 1.03, 1.0)),
  saturation: uniform(1.15),
  vignette: uniform(0.2),
  grain: uniform(0.01),
  bloomStrength: uniform(0.22),
  bloomRadius: uniform(0.4),
  /**
   * Scene luminance where bloom starts, ramping in over `bloomKnee`. Sunlit
   * ground and sky reach 1 to 2, so a lower threshold glows the whole frame
   * (a milky haze); only fire, spells and emissive trim should bloom.
   */
  bloomThreshold: uniform(2.5),
  bloomKnee: uniform(1.5),
  /** Contrast-adaptive sharpening after temporal AA, which softens detail (0 = off). */
  sharpness: uniform(0.6),
};

/**
 * Builds and owns the post-processing chain:
 *
 *   scene pass (last frame's AO feeds the ambient term) -> GTAO from its depth
 *   -> TRAA (or SMAA/FXAA at the end) -> sharpen (with TRAA) -> bloom
 *   -> tone map -> color grade -> vignette + film grain
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
    // Every pass that draws the scene (the main pass and each shadow cascade)
    // would walk the whole scene graph to update matrices; once a frame is enough.
    scene.matrixWorldAutoUpdate = false;
  }

  build(q: QualitySettings): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.bloomNode = null;
    const { scene, camera } = this;

    const scenePass = pass(scene, camera);
    let depthNode: any;
    let velocityNode: any;
    let aoTouch: any = null;

    if (q.ao) {
      // One pass draws the scene, writing depth and motion as well. GTAO reads
      // that depth (normals rebuilt from it) and the next frame's pass samples
      // its result where each surface was a frame earlier, so AO still darkens
      // only indirect light. A separate depth/normal pre-pass drew every object
      // a second time, and on a fast GPU sending draws is the frame's bottleneck.
      scenePass.setMRT(mrt({ output, velocity }));
      depthNode = scenePass.getTextureNode('depth');
      velocityNode = scenePass.getTextureNode('velocity');
      // a plain texture, so the AO doesn't draw the scene pass from inside it
      const aoPass = ao(texture(scenePass.getTexture('depth')), null as any, camera);
      aoPass.resolutionScale = q.aoResolution;
      aoPass.samples.value = q.aoSamples;
      aoPass.radius.value = 0.9;
      aoPass.distanceExponent.value = 1.4;
      aoPass.thickness.value = 1.2;
      aoPass.scale.value = 1.0;
      aoPass.useTemporalFiltering = q.antiAliasing === 'traa';
      this.disposables.push(aoPass);
      const aoMap: THREE.Texture = aoPass.getTextureNode().value;
      const lastFrame = screenUV.sub(velocity.xy.mul(vec2(0.5, -0.5)));
      scenePass.contextNode = builtinAOContext(texture(aoMap).sample(lastFrame).r);
      // GTAO renders when a pass that samples it does, and the scene samples a
      // plain texture, so the final pass samples it too (adding nothing). Built
      // first there, it renders first each frame, from the previous frame's
      // depth: a new map is never read before GTAO has drawn it.
      aoTouch = aoPass.getTextureNode().sample(vec2(0.5)).r.mul(0);
    } else if (q.antiAliasing === 'traa') {
      scenePass.setMRT(mrt({ output, velocity }));
      depthNode = scenePass.getTextureNode('depth');
      velocityNode = scenePass.getTextureNode('velocity');
    }
    this.disposables.push(scenePass);

    let hdr: any = scenePass.getTextureNode('output');
    let bloomInput: any = hdr;
    if (q.antiAliasing === 'traa') {
      const t = traa(scenePass, depthNode, velocityNode, camera);
      t.useSubpixelCorrection = false;
      this.disposables.push(t);
      bloomInput = t;
      // sharpened in the grading pass itself, so it costs no extra pass
      hdr = sharpen((t as unknown as { getTextureNode(): { value: THREE.Texture } }).getTextureNode().value, grading.sharpness);
    }

    if (q.bloom) {
      const b = bloom(bloomInput, grading.bloomStrength.value, grading.bloomRadius.value, grading.bloomThreshold.value);
      b.smoothWidth = grading.bloomKnee;
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

    let out: any = aoTouch ? aoTouch.add(graded) : graded;
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
    this.scene.updateMatrixWorld();
    this.pipeline.render();
  }
}

/**
 * Robust contrast-adaptive sharpening (RCAS, from AMD FSR 1, as in three's
 * SharpenNode) of an HDR texture at the current pixel. RCAS expects values in
 * 0..1, so it runs on x / (1 + x) and maps the result back. The lobe is
 * limited by the local contrast, so edges sharpen without halos.
 */
function sharpen(tex: THREE.Texture, sharpness: any): any {
  return Fn(() => {
    const size = textureSize(textureLoad(tex));
    const p = ivec2(int(floor(screenUV.x.mul(size.x))), int(floor(screenUV.y.mul(size.y)))).toConst();
    const center = textureLoad(tex, p);
    const fit = (c: any) => c.rgb.div(c.rgb.add(1));
    const e = fit(center).toConst();
    const b = fit(textureLoad(tex, p.add(ivec2(0, -1)))).toConst();
    const d = fit(textureLoad(tex, p.add(ivec2(-1, 0)))).toConst();
    const f = fit(textureLoad(tex, p.add(ivec2(1, 0)))).toConst();
    const h = fit(textureLoad(tex, p.add(ivec2(0, 1)))).toConst();
    const mn4 = min(min(b, d), min(f, h)).toConst();
    const mx4 = max(max(b, d), max(f, h)).toConst();
    const hitMin = min(mn4, e).div(mx4.mul(4)).toConst();
    const hitMax = vec3(1).sub(max(mx4, e)).div(mn4.mul(4).sub(4)).toConst();
    const lobeRGB = max(hitMin.negate(), hitMax).toConst();
    const lobe = max(float(-(0.25 - 1 / 16)), min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0)).mul(sharpness).toConst();
    const r = b.add(d).add(f).add(h).mul(lobe).add(e).div(lobe.mul(4).add(1)).clamp(0, 0.999).toConst();
    return vec4(r.div(float(1).sub(r)), center.a);
  })();
}
