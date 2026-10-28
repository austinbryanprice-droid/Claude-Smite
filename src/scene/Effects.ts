import * as THREE from 'three/webgpu';
import {
  abs, cameraPosition, color, float, fract, hash, instanceIndex, mix, mx_fractal_noise_float, mx_noise_float,
  pow, sin, cos, smoothstep, time, uniform, uv, vec2, vec3, vec4,
} from '../render/tsl';
import { Layers } from '../render/Layers';

/**
 * Fire for braziers and torches: a billboarded flame shader (HDR, so it
 * feeds bloom), rising embers, and a flickering point light.
 */
export class Fire {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  private readonly seed: number;
  private readonly baseIntensity: number;

  /** 0..1 master strength, for fires that die down or flare. */
  readonly strength = uniform(1);

  constructor(
    position: THREE.Vector3, size = 1, seed = Math.random() * 100, lightIntensity = 30,
    palette: { low: number; high: number; ember: number; light: number } = { low: 0xff3a08, high: 0xffc46a, ember: 0xff8a2a, light: 0xff8a3c },
  ) {
    this.seed = seed;
    this.baseIntensity = lightIntensity;
    this.group.position.copy(position);
    this.group.name = 'fire';

    const s = uniform(seed);
    const flameMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const u = uv();
    const t = time.mul(1.6).add(s);
    const p = vec2(u.x.sub(0.5).mul(2.2), u.y);
    const n = mx_fractal_noise_float(vec3(p.x.mul(2.4), p.y.mul(2.2).sub(t.mul(1.9)), s.add(t.mul(0.35))), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const width = float(1).sub(u.y.mul(0.85)).mul(0.62);
    const sway = mx_noise_float(vec3(u.y.mul(1.5).sub(t), s, 0)).mul(0.2).mul(u.y);
    const body = smoothstep(width, width.mul(0.2), abs(p.x.sub(sway)));
    const core = body.mul(smoothstep(1.0, 0.1, u.y)).mul(smoothstep(0.0, 0.12, u.y));
    const flame = smoothstep(0.32, 0.85, core.mul(n.mul(1.25).add(0.25))).toVar();
    const heat = pow(flame, float(1.6));
    const col = mix(color(palette.low), color(palette.high), heat).mul(mix(float(2.2), float(9.0), heat));
    flameMat.colorNode = vec4(col.mul(flame).mul(this.strength), 1);
    flameMat.opacityNode = flame.mul(this.strength);
    flameMat.scaleNode = vec2(0.85 * size, 1.5 * size);
    const flame1 = new THREE.Sprite(flameMat);
    flame1.position.y = 0.62 * size;
    flame1.layers.set(Layers.WORLD);
    flame1.renderOrder = 10;
    this.group.add(flame1);

    // Embers: instanced sprites whose motion is computed entirely on the GPU.
    const COUNT = 28;
    const emberMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const id = instanceIndex.toFloat();
    const life = fract(time.mul(hash(id.add(s)).mul(0.35).add(0.3)).add(hash(id.mul(3.1))));
    const ang = hash(id.mul(7.7)).mul(6.283).add(time.mul(0.8));
    const spread = life.mul(0.55).mul(size);
    emberMat.positionNode = vec3(
      cos(ang).mul(spread).add(sin(life.mul(9).add(id)).mul(0.08)),
      life.mul(2.6 * size).add(0.4 * size),
      sin(ang).mul(spread),
    );
    const emberSize = float(0.035).mul(float(1).sub(life)).mul(size).mul(hash(id.mul(1.7)).add(0.5));
    emberMat.scaleNode = vec2(emberSize, emberSize);
    const r = uv().sub(0.5).length();
    const dot = smoothstep(0.5, 0.0, r);
    emberMat.colorNode = vec4(color(palette.ember).mul(14).mul(float(1).sub(life)).mul(this.strength), 1);
    emberMat.opacityNode = dot.mul(smoothstep(1, 0.6, life));
    const embers = new THREE.Sprite(emberMat);
    (embers as any).count = COUNT;
    embers.frustumCulled = false;
    embers.renderOrder = 11;
    this.group.add(embers);

    this.light = new THREE.PointLight(palette.light, lightIntensity, 18 * size, 2);
    this.light.position.y = 0.9 * size;
    this.light.castShadow = false;
    this.group.add(this.light);
  }

  update(time: number): void {
    const f = Math.sin(time * 11.3 + this.seed) * 0.08 + Math.sin(time * 23.7 + this.seed * 2) * 0.05 + Math.sin(time * 5.1) * 0.06;
    this.light.intensity = this.baseIntensity * (1 + f) * this.strength.value;
  }
}

/**
 * Floating dust and pollen motes that catch the sunlight around the camera.
 * Purely visual depth cue; wraps around the camera so it costs a fixed amount.
 */
export class DustMotes {
  readonly sprite: THREE.Sprite;
  readonly density = uniform(1);

  constructor(count: number, sunDirection: THREE.Vector3) {
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const id = instanceIndex.toFloat();
    const box = vec3(40, 14, 40);
    const seedPos = vec3(hash(id), hash(id.add(17.3)), hash(id.add(91.7)));
    const drift = vec3(
      sin(time.mul(0.11).add(id)).mul(1.5).add(time.mul(0.35)),
      sin(time.mul(0.07).add(id.mul(1.3))).mul(1.2).add(time.mul(0.05)),
      cos(time.mul(0.09).add(id.mul(0.7))).mul(1.5).add(time.mul(0.2)),
    );
    // wrap the particle into a box that follows the camera
    const local = fract(seedPos.add(drift.div(box)).add(cameraPosition.div(box).negate())).sub(0.5).mul(box);
    const world = cameraPosition.add(local).toVar();
    mat.positionNode = world;
    const size = hash(id.add(5.5)).mul(0.03).add(0.012);
    mat.scaleNode = vec2(size, size);
    const toCam = world.sub(cameraPosition).normalize();
    const sun = uniform(sunDirection);
    const forward = pow(toCam.dot(sun.negate()).negate().max(0), float(2)).mul(3).add(0.35);
    const fade = smoothstep(18, 6, local.length()).mul(smoothstep(0.6, 2.0, world.sub(cameraPosition).length()));
    const twinkle = sin(time.mul(hash(id).mul(3).add(1)).add(id)).mul(0.3).add(0.7);
    mat.colorNode = vec4(color(0xfff1c8).mul(forward).mul(twinkle).mul(1.4), 1);
    mat.opacityNode = smoothstep(0.5, 0.1, uv().sub(0.5).length()).mul(fade).mul(this.density);
    this.sprite = new THREE.Sprite(mat);
    (this.sprite as any).count = count;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 12;
  }
}

/**
 * The relic floating over the temple's central dais: a slowly turning crystal
 * with pulsing runes and a soft light. Doubles as the arena's focal point.
 */
export class Relic {
  readonly group = new THREE.Group();
  private readonly crystal: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private readonly baseY: number;

  constructor(position: THREE.Vector3) {
    this.group.position.copy(position);
    this.baseY = 2.6;
    const geo = new THREE.OctahedronGeometry(0.9, 0);
    geo.scale(0.75, 1.5, 0.75);
    const mat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 });
    const pulse = sin(time.mul(1.7)).mul(0.25).add(0.75);
    const runes = smoothstep(0.42, 0.5, abs(fract(uv().y.mul(8).add(time.mul(0.15))).sub(0.5)))
      .mul(smoothstep(0.2, 0.8, mx_noise_float(vec3(uv().mul(vec2(14, 6)), time.mul(0.2)))));
    const fresnel = pow(float(1).sub(abs(cameraPosition.sub(uniform(position)).normalize().y)), float(1));
    mat.colorNode = color(0x0d1a2a);
    mat.emissiveNode = mix(color(0x2bd6ff).mul(1.6), color(0xffd27a).mul(9), runes).mul(pulse).mul(fresnel.mul(0.3).add(0.7));
    this.crystal = new THREE.Mesh(geo, mat);
    this.crystal.position.y = this.baseY;
    this.crystal.castShadow = true;
    this.group.add(this.crystal);

    this.light = new THREE.PointLight(0x7ad8ff, 25, 16, 2);
    this.light.position.y = this.baseY;
    this.group.add(this.light);
  }

  update(t: number): void {
    this.crystal.rotation.y = t * 0.4;
    this.crystal.position.y = this.baseY + Math.sin(t * 0.9) * 0.18;
    this.light.intensity = 22 + Math.sin(t * 1.7) * 6;
  }
}
