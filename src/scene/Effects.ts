import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraPosition, color, float, fract, hash, instanceIndex, mix, mx_fractal_noise_float, mx_noise_float,
  pow, sin, cos, smoothstep, time, uniform, uv, vec2, vec3, vec4,
} from '../render/tsl';
import { spriteQuads } from '../render/shared';

type FirePalette = { low: number; high: number; ember: number; light: number };

/** Embers each fire throws up. */
const EMBERS = 28;
let fireMaterials: { flame: THREE.SpriteNodeMaterial; embers: THREE.SpriteNodeMaterial } | null = null;

/**
 * The flame and ember materials of `FireBatch`, which reads each fire's own
 * values from per-copy attributes: `fireAt` (where the fire's base is, and its
 * size, 0 while hidden), `fireState` (seed and strength) and its colours.
 */
function makeFireMaterials(): NonNullable<typeof fireMaterials> {
  const at = attribute('fireAt', 'vec4');
  const state = attribute('fireState', 'vec2');
  const sz = at.w;
  const s = state.x;
  const strength = state.y;
  const low = attribute('fireLow', 'vec3');
  const high = attribute('fireHigh', 'vec3');
  const ember = attribute('fireEmber', 'vec3');
  const flame = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const u = uv();
  const t = time.mul(1.6).add(s);
  const p = vec2(u.x.sub(0.5).mul(2.2), u.y);
  const n = mx_fractal_noise_float(vec3(p.x.mul(2.4), p.y.mul(2.2).sub(t.mul(1.9)), s.add(t.mul(0.35))), 3, 2.0, 0.5).mul(0.5).add(0.5);
  const width = float(1).sub(u.y.mul(0.85)).mul(0.62);
  const sway = mx_noise_float(vec3(u.y.mul(1.5).sub(t), s, 0)).mul(0.2).mul(u.y);
  const body = smoothstep(width, width.mul(0.2), abs(p.x.sub(sway)));
  const core = body.mul(smoothstep(1.0, 0.1, u.y)).mul(smoothstep(0.0, 0.12, u.y));
  const lick = smoothstep(0.32, 0.85, core.mul(n.mul(1.25).add(0.25))).toVar();
  const heat = pow(lick, float(1.6));
  const col = mix(low, high, heat).mul(mix(float(2.2), float(9.0), heat));
  flame.colorNode = vec4(col.mul(lick).mul(strength), 1);
  flame.opacityNode = lick.mul(strength);
  flame.positionNode = at.xyz.add(vec3(0, sz.mul(0.62), 0));
  flame.scaleNode = vec2(0.85, 1.5).mul(sz);

  // Embers: instanced sprites whose motion is computed entirely on the GPU.
  const embers = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const id = instanceIndex.toFloat();
  const life = fract(time.mul(hash(id.add(s)).mul(0.35).add(0.3)).add(hash(id.mul(3.1))));
  const ang = hash(id.mul(7.7)).mul(6.283).add(time.mul(0.8));
  const spread = life.mul(0.55).mul(sz);
  embers.positionNode = at.xyz.add(vec3(
    cos(ang).mul(spread).add(sin(life.mul(9).add(id)).mul(0.08)),
    life.mul(2.6).add(0.4).mul(sz),
    sin(ang).mul(spread),
  ));
  const emberSize = float(0.035).mul(float(1).sub(life)).mul(sz).mul(hash(id.mul(1.7)).add(0.5));
  embers.scaleNode = vec2(emberSize, emberSize);
  const dot = smoothstep(0.5, 0.0, uv().sub(0.5).length());
  embers.colorNode = vec4(ember.mul(14).mul(float(1).sub(life)).mul(strength), 1);
  embers.opacityNode = dot.mul(smoothstep(1, 0.6, life));
  return { flame, embers };
}

/** Fires made since a `FireBatch` last took them in. */
const unbatched: Fire[] = [];

/**
 * Fire for braziers and torches: a billboarded flame shader (HDR, so it
 * feeds bloom), rising embers, and a flickering point light. A `FireBatch`
 * draws the flame and embers of every fire; the fire's group says where it
 * is and whether it shows.
 */
export class Fire {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight;
  readonly low: THREE.Color;
  readonly high: THREE.Color;
  readonly ember: THREE.Color;
  /** 0..1 master strength, for fires that die down or flare. */
  strength = 1;
  private readonly baseIntensity: number;

  constructor(
    position: THREE.Vector3, readonly size = 1, readonly seed = Math.random() * 100, lightIntensity = 30,
    palette: FirePalette = { low: 0xff3a08, high: 0xffc46a, ember: 0xff8a2a, light: 0xff8a3c },
  ) {
    this.baseIntensity = lightIntensity;
    this.group.position.copy(position);
    this.group.name = 'fire';
    this.low = new THREE.Color(palette.low);
    this.high = new THREE.Color(palette.high);
    this.ember = new THREE.Color(palette.ember);
    this.light = new THREE.PointLight(palette.light, lightIntensity, 18 * size, 2);
    this.light.position.y = 0.9 * size;
    this.light.castShadow = false;
    this.group.add(this.light);
    unbatched.push(this);
  }

  update(time: number): void {
    const f = Math.sin(time * 11.3 + this.seed) * 0.08 + Math.sin(time * 23.7 + this.seed * 2) * 0.05 + Math.sin(time * 5.1) * 0.06;
    this.light.intensity = this.baseIntensity * (1 + f) * this.strength;
  }
}

/** Per-copy attributes of one of `FireBatch`'s sprites. */
interface FireCopies {
  at: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
}

/**
 * Draws the flames and embers of every fire: two draw calls in all, where
 * each fire's own sprites cost two (about 70 a frame on Conquest, the embers
 * drawn even off screen). `update` copies where each fire is, its size (0
 * while its group is hidden) and its strength into per-copy attributes.
 */
export class FireBatch {
  readonly group = new THREE.Group();
  private readonly fires: Fire[] = [];
  private flames: FireCopies | null = null;
  private embers: FireCopies | null = null;
  private readonly at = new THREE.Vector3();

  constructor() {
    this.group.name = 'fires';
  }

  update(): void {
    if (unbatched.length) this.build();
    const flames = this.flames;
    const embers = this.embers;
    if (!flames || !embers) return;
    let moved = false;
    for (let i = 0; i < this.fires.length; i++) {
      const f = this.fires[i]!;
      const m = f.group.matrixWorld.elements;
      const at = this.at.set(m[12]!, m[13]!, m[14]!);
      const size = shown(f.group) ? f.size * Math.hypot(m[0]!, m[1]!, m[2]!) : 0;
      const a = flames.at.array;
      if (a[i * 4] === at.x && a[i * 4 + 1] === at.y && a[i * 4 + 2] === at.z && a[i * 4 + 3] === size && flames.state.array[i * 2 + 1] === f.strength) continue;
      moved = true;
      for (const [copies, first, count] of [[flames, i, 1], [embers, i * EMBERS, EMBERS]] as const) {
        for (let k = first; k < first + count; k++) {
          copies.at.setXYZW(k, at.x, at.y, at.z, size);
          copies.state.setXY(k, f.seed, f.strength);
        }
      }
    }
    if (!moved) return;
    for (const c of [flames, embers]) c.at.needsUpdate = c.state.needsUpdate = true;
  }

  /**
   * Takes in the fires made since the last build. Fires are all made while
   * the map loads, so this runs once; the old geometries are left to the
   * garbage collector because disposing them would destroy the sprite quad
   * they share.
   */
  private build(): void {
    this.fires.push(...unbatched.splice(0));
    const n = this.fires.length;
    const materials = (fireMaterials ??= makeFireMaterials());
    const sprite = (material: THREE.SpriteNodeMaterial, copies: number, colors: [string, (f: Fire) => THREE.Color][], renderOrder: number) => {
      const s = new THREE.Sprite(material);
      const g = (s.geometry = spriteQuads(copies, true));
      const per = copies / n;
      const at = new THREE.InstancedBufferAttribute(new Float32Array(copies * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const state = new THREE.InstancedBufferAttribute(new Float32Array(copies * 2), 2).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('fireAt', at);
      g.setAttribute('fireState', state);
      for (const [name, pick] of colors) {
        const c = new THREE.InstancedBufferAttribute(new Float32Array(copies * 3), 3);
        for (let k = 0; k < copies; k++) pick(this.fires[Math.floor(k / per)]!).toArray(c.array, k * 3);
        g.setAttribute(name, c);
      }
      s.frustumCulled = false;
      s.renderOrder = renderOrder;
      this.group.add(s);
      return { at, state };
    };
    this.group.clear();
    this.flames = sprite(materials.flame, n, [['fireLow', (f) => f.low], ['fireHigh', (f) => f.high]], 10);
    this.embers = sprite(materials.embers, n * EMBERS, [['fireEmber', (f) => f.ember]], 11);
  }
}

/** True when the object and all its ancestors are visible, up to a scene. */
function shown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) {
    if (!o.visible) return false;
    if ((o as THREE.Scene).isScene) return true;
  }
  return false;
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
