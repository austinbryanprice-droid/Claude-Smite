import * as THREE from 'three/webgpu';
import {
  cos, float, fract, hash, instanceIndex, mix, mx_noise_float, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4,
} from '../render/tsl';
import type { Sim } from '../sim/Sim';
import { PROJECTILE_HEIGHT } from '../sim/Sim';
import { isStructure, WORLD_SCALE, type Flash, type FlashShape, type Projectile, type SimEvent } from '../sim/Unit';
import { ArcView } from './Arcs';
import { GroundDecal, type DecalShape } from './GroundDecal';
import { paletteFor, paletteOf, type GodPalette } from './palette';

type Ground = (x: number, z: number) => number;

/**
 * A soft round sprite. Additive sprites are hot cores; alpha-blended ones are
 * colored glows that stay saturated even over sunlit marble (additive light
 * washes out to white there). Colors above 1 feed bloom either way.
 */
function glowMaterial(col: any, intensity: any, softness = 2, additive = true, alpha = 1): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
  const r = uv().sub(0.5).length().mul(2);
  const f = smoothstep(1, 0, r).pow(softness);
  m.colorNode = vec4(col.mul(intensity).mul(additive ? f : 1), 1);
  m.opacityNode = f.mul(alpha);
  return m;
}

/** Recycles effect objects so nothing is created (or compiled) mid-fight. */
class Pool<T extends { group: THREE.Object3D }> {
  private readonly free: T[] = [];
  constructor(
    private readonly parent: THREE.Object3D,
    private readonly make: () => T,
    warm: number,
  ) {
    for (let i = 0; i < warm; i++) this.release(this.make());
  }

  take(): T {
    const t = this.free.pop() ?? this.make();
    this.parent.add(t.group);
    t.group.visible = true;
    return t;
  }

  release(t: T): void {
    t.group.visible = false;
    this.parent.remove(t.group);
    this.free.push(t);
  }
}

const TRAIL = 9;

class ProjectileView {
  readonly group = new THREE.Group();
  private readonly main = uniform(new THREE.Color());
  private readonly hot = uniform(new THREE.Color());
  private readonly coreSprite: THREE.Sprite;
  private readonly halo: THREE.Sprite;
  private readonly trail: THREE.Sprite[] = [];
  private readonly history: THREE.Vector3[] = [];
  private readonly arc = new ArcView();
  private lightning = false;
  private crackle = 0;
  size = 1;

  constructor() {
    this.coreSprite = new THREE.Sprite(glowMaterial(this.hot, float(5), 2.5));
    this.halo = new THREE.Sprite(glowMaterial(this.main, float(1.8), 1.6, false, 0.75));
    const trailMat = glowMaterial(this.main, float(1.5), 1.8, false, 0.55);
    for (let i = 0; i < TRAIL; i++) {
      const s = new THREE.Sprite(trailMat);
      this.trail.push(s);
      this.group.add(s);
    }
    this.group.add(this.halo, this.coreSprite, this.arc.group);
    for (const o of [this.coreSprite, this.halo, ...this.trail]) {
      o.frustumCulled = false;
      o.renderOrder = 12;
    }
  }

  reset(p: GodPalette, size: number, at: THREE.Vector3): void {
    this.main.value.setHex(p.vfx);
    this.hot.value.setHex(p.core);
    this.size = size;
    this.lightning = p.element === 'lightning';
    this.arc.setColors(p.vfx, p.core);
    this.arc.clear();
    this.crackle = 0;
    this.history.length = 0;
    for (let i = 0; i < TRAIL; i++) this.history.push(at.clone());
  }

  update(at: THREE.Vector3, t: number): void {
    this.history.pop();
    this.history.unshift(at.clone());
    const flicker = 1 + Math.sin(t * 40) * 0.08;
    this.coreSprite.position.copy(at);
    this.coreSprite.scale.setScalar(this.size * 0.7 * flicker);
    this.halo.position.copy(at);
    this.halo.scale.setScalar(this.size * 2.6);
    this.trail.forEach((s, i) => {
      // trail sprites sit between history samples so fast shots stay continuous
      const a = this.history[Math.min(i, this.history.length - 1)]!;
      const b = this.history[Math.min(i + 1, this.history.length - 1)]!;
      s.position.lerpVectors(a, b, 0.5);
      s.scale.setScalar(this.size * 1.9 * (1 - i / TRAIL));
    });
    if (this.lightning) this.crackleArcs(at, t);
  }

  /** Lightning shots crackle: fresh jagged arcs along the trail and off the head, many times a second. */
  private crackleArcs(at: THREE.Vector3, t: number): void {
    if (t - this.crackle < 0.045) return;
    this.crackle = t;
    const a = this.arc;
    a.clear();
    const tail = this.history[this.history.length - 1]!;
    const w = Math.max(0.05, this.size * 0.14);
    if (tail.distanceToSquared(at) > 0.01) a.bolt(at, tail, w, 0.35, 0.9, 3);
    for (let i = 0; i < 2; i++) {
      const r = this.size * (1.1 + Math.random());
      const to = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2 * r, (Math.random() - 0.5) * r, (Math.random() - 0.5) * 2 * r));
      a.bolt(at, to, w * 0.6, 0.4, 0.6, 2);
    }
  }
}

/** Elements whose hits and areas raise billowing puffs, and the puff color for each. */
const PUFF_COLORS: Partial<Record<string, number>> = { smoke: 0x4f9466, sand: 0xe0b77e };

/**
 * Soft, alpha-blended clouds: Loki's smoke and Anubis's sand. One instanced
 * sprite set; a burst throws puffs out once, a zone keeps them rolling.
 */
class Puffs {
  readonly sprite: THREE.Sprite;
  readonly age = uniform(0);
  readonly seed = uniform(0);
  readonly power = uniform(1);
  readonly radius = uniform(1);
  readonly fade = uniform(1);
  /** 0 for a one-shot burst, 1 for a looping area. */
  readonly loop = uniform(0);
  /** Swirl speed: sand spirals, smoke drifts. */
  readonly swirl = uniform(0);
  readonly tint = uniform(new THREE.Color());

  constructor(count: number) {
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const id = instanceIndex.toFloat();
    const h1 = hash(id.add(this.seed));
    const h2 = hash(id.mul(2.9).add(this.seed));
    const h3 = hash(id.mul(6.1).add(this.seed));
    // burst: life is the burst's age; loop: each puff cycles on its own clock
    const cycle = fract(time.mul(h2.mul(0.25).add(0.3)).add(h3));
    const life = mix(this.age.div(1.2).clamp(0, 1), cycle, this.loop);
    const out = float(1).sub(float(1).sub(life).pow(3));
    const ang = h1.mul(6.283).add(life.mul(this.swirl).mul(3)).add(time.mul(this.swirl).mul(this.loop));
    const dist = mix(out.mul(h2.mul(1.6).add(0.6)).mul(this.power), h2.sqrt().mul(this.radius), this.loop);
    mat.positionNode = vec3(cos(ang).mul(dist), life.mul(mix(float(1.1), float(2.2), this.loop)).add(h3.mul(0.5)).add(0.3), sin(ang).mul(dist));
    const size = mix(float(0.6), float(1.6), out).mul(h3.mul(0.6).add(0.7)).mul(mix(this.power, this.radius.mul(0.3).add(0.8).min(2.6), this.loop));
    mat.scaleNode = vec2(size, size);
    const p = uv().sub(0.5);
    const billow = mx_noise_float(vec3(p.x.mul(3), p.y.mul(3), h1.mul(40).add(time.mul(0.4)))).mul(0.5).add(0.5);
    const soft = smoothstep(0.5, 0.2, p.length()).pow(0.6).mul(billow.mul(0.5).add(0.5));
    const fadeLife = smoothstep(0, 0.08, life).mul(float(1).sub(life).pow(0.8));
    // lit from above: tops a little lighter than undersides
    const shade = mix(float(0.75), float(1.25), uv().y);
    mat.colorNode = vec4(this.tint.mul(shade), 1);
    mat.opacityNode = soft.mul(fadeLife).mul(this.fade).mul(0.9);
    this.sprite = new THREE.Sprite(mat);
    (this.sprite as any).count = count;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
  }

  set(color: number | undefined): void {
    this.sprite.visible = color !== undefined;
    if (color !== undefined) this.tint.value.setHex(color);
  }
}

/** A short burst: a flash plus sparks thrown outward, all animated on the GPU from `age`. */
class Burst {
  readonly group = new THREE.Group();
  readonly age = uniform(0);
  readonly main = uniform(new THREE.Color());
  readonly hot = uniform(new THREE.Color());
  readonly seed = uniform(0);
  readonly power = uniform(1);
  life = 0.6;
  private readonly flash: THREE.Sprite;
  /** Flat shockwave ring rolling out over the ground. */
  private readonly ring: THREE.Mesh;
  private readonly puffs = new Puffs(10);

  constructor() {
    const fade = float(1).sub(this.age.div(0.6)).clamp(0, 1);
    const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const ringFade = float(1).sub(this.age.div(0.45)).clamp(0, 1);
    const band = smoothstep(0, 0.5, uv().x).mul(smoothstep(1, 0.6, uv().x));
    rm.colorNode = vec4(mix(this.main, this.hot, band.mul(0.5)).mul(float(2).add(band.mul(4))), 1);
    rm.opacityNode = band.mul(ringFade.pow(1.4)).mul(0.9);
    const rg = new THREE.RingGeometry(0.7, 1, 48, 1).rotateX(-Math.PI / 2);
    // RingGeometry's uv is planar; rebuild u as the radial position across the band
    const uvs = rg.getAttribute('uv') as THREE.BufferAttribute;
    const ps = rg.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < ps.count; i++) uvs.setX(i, (Math.hypot(ps.getX(i), ps.getZ(i)) - 0.7) / 0.3);
    this.ring = new THREE.Mesh(rg, rm);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 6;
    this.group.add(this.ring, this.puffs.sprite);
    this.flash = new THREE.Sprite(glowMaterial(mix(this.main, this.hot, 0.3).mul(2.5), float(1), 1.8, false, fade.pow(1.5).mul(0.9)));
    this.flash.frustumCulled = false;
    this.group.add(this.flash);

    const COUNT = 18;
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const id = instanceIndex.toFloat();
    const h1 = hash(id.add(this.seed));
    const h2 = hash(id.mul(3.7).add(this.seed));
    const h3 = hash(id.mul(9.1).add(this.seed));
    const ang = h1.mul(6.283);
    const up = h2.mul(0.9).add(0.2);
    const speed = h3.mul(5).add(3).mul(this.power);
    const a = this.age;
    const dist = speed.mul(a).mul(float(1).sub(a.mul(0.6)));
    mat.positionNode = vec3(
      cos(ang).mul(dist),
      up.mul(speed).mul(a).sub(a.mul(a).mul(9)),
      sin(ang).mul(dist),
    );
    const s = float(0.09).mul(this.power).mul(fade).mul(h2.add(0.6));
    mat.scaleNode = vec2(s, s);
    const r = uv().sub(0.5).length();
    const dot = smoothstep(0.5, 0, r);
    mat.colorNode = vec4(mix(this.main, this.hot, h3.mul(0.6)).mul(9).mul(fade), 1);
    mat.opacityNode = dot.mul(fade);
    const sparks = new THREE.Sprite(mat);
    (sparks as any).count = COUNT;
    sparks.frustumCulled = false;
    sparks.renderOrder = 13;
    this.group.add(sparks);
  }

  start(p: GodPalette, at: THREE.Vector3, power: number, groundY: number): void {
    this.group.position.copy(at);
    // the ring only for hits near the ground and strong enough to shake it
    this.ring.visible = power >= 0.75 && at.y - groundY < 2.5;
    this.ring.position.y = groundY - at.y + 0.12;
    const puff = p.element ? PUFF_COLORS[p.element] : undefined;
    this.puffs.set(power >= 0.5 ? puff : undefined);
    this.puffs.age.value = 0;
    this.puffs.seed.value = this.seed.value;
    this.puffs.power.value = power;
    this.puffs.sprite.position.y = groundY - at.y;
    this.puffs.swirl.value = p.element === 'sand' ? 1 : 0.15;
    this.life = this.puffs.sprite.visible ? 1.2 : 0.6;
    this.main.value.setHex(p.vfx);
    this.hot.value.setHex(p.core);
    this.seed.value = Math.random() * 100;
    this.power.value = power;
    this.age.value = 0;
    this.flash.scale.setScalar(0.1);
  }

  update(dt: number): boolean {
    this.age.value += dt;
    this.puffs.age.value = this.age.value;
    const k = Math.min(1, this.age.value / 0.18);
    this.flash.scale.setScalar((1.0 + k * 1.6) * this.power.value);
    const r = 1 - (1 - Math.min(1, this.age.value / 0.45)) ** 3;
    this.ring.scale.setScalar(0.3 + r * 2.6 * this.power.value);
    return this.age.value < this.life;
  }
}

/** A column of light where a god falls, rising and thinning out. */
class Pillar {
  readonly group = new THREE.Group();
  readonly age = uniform(0);
  readonly main = uniform(new THREE.Color());
  readonly hot = uniform(new THREE.Color());
  readonly life = 1.6;
  private readonly beam: THREE.Mesh;

  constructor() {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const v = uv().y;
    const fade = float(1).sub(this.age.div(this.life)).clamp(0, 1);
    // bright at the foot, streaked as it climbs
    const streak = sin(uv().x.mul(6.283 * 7).add(this.age.mul(3))).mul(0.25).add(0.75);
    const body = float(1).sub(v).pow(1.6).mul(streak);
    m.colorNode = vec4(mix(this.main, this.hot, float(1).sub(v).pow(10)).mul(body).mul(3).mul(fade.pow(1.5)), 1);
    m.opacityNode = body.mul(fade);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0), m);
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 12;
    this.group.add(this.beam);
  }

  start(p: GodPalette, x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.main.value.setHex(p.vfx);
    this.hot.value.setHex(p.core);
    this.age.value = 0;
  }

  update(dt: number): boolean {
    this.age.value += dt;
    const k = this.age.value;
    const rise = 1 - Math.exp(-k * 5);
    this.beam.scale.set(0.5 + 0.9 * (1 - rise) + 0.3, 2 + rise * 30, 0.5 + 0.9 * (1 - rise) + 0.3);
    return k < this.life;
  }
}

/** A lingering area: a churning ground decal with motes rising through it. */
class ZoneView {
  readonly group = new THREE.Group();
  readonly decal: GroundDecal;
  private readonly radius = uniform(1);
  private readonly main = uniform(new THREE.Color());
  private readonly fade = uniform(1);

  constructor(ground: Ground) {
    this.decal = new GroundDecal(ground);
    this.decal.setStyle('zone');
    this.group.add(this.decal.mesh);

    const COUNT = 40;
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const id = instanceIndex.toFloat();
    const life = fract(time.mul(hash(id).mul(0.4).add(0.35)).add(hash(id.mul(2.3))));
    const ang = hash(id.mul(5.1)).mul(6.283).add(time.mul(0.6));
    const rad = hash(id.mul(7.7)).sqrt().mul(this.radius);
    mat.positionNode = vec3(cos(ang).mul(rad), life.mul(2.8).add(0.1), sin(ang).mul(rad));
    const s = float(0.07).mul(float(1).sub(life)).mul(hash(id.mul(1.3)).add(0.5));
    mat.scaleNode = vec2(s, s);
    const dot = smoothstep(0.5, 0, uv().sub(0.5).length());
    mat.colorNode = vec4(this.main.mul(7).mul(this.fade), 1);
    mat.opacityNode = dot.mul(smoothstep(1, 0.5, life)).mul(this.fade);
    const motes = new THREE.Sprite(mat);
    (motes as any).count = COUNT;
    motes.frustumCulled = false;
    motes.renderOrder = 13;
    this.group.add(motes);
    this.motes = motes;
  }

  private readonly motes: THREE.Sprite;
  private readonly arc = new ArcView();
  private strikeAt = 0;
  private readonly puffs = new Puffs(40);

  set(p: GodPalette, x: number, z: number, radius: number, fade: number, ground: Ground, t: number): void {
    if (this.arc.group.parent !== this.group) this.group.add(this.arc.group, this.puffs.sprite);
    this.decal.glyphs.value = p.element === 'runes' ? 1 : 0;
    this.puffs.set(p.element ? PUFF_COLORS[p.element] : undefined);
    this.puffs.loop.value = 1;
    this.puffs.radius.value = radius;
    this.puffs.fade.value = fade;
    this.puffs.swirl.value = p.element === 'sand' ? 1.4 : 0.1;
    this.puffs.sprite.position.set(x, ground(x, z), z);
    this.arc.fade.value = fade * Math.max(0, 1 - (t - this.strikeAt) / 0.14);
    // a lightning god's storm keeps striking somewhere inside it
    if (p.element === 'lightning' && t - this.strikeAt > 0.22) {
      this.strikeAt = t;
      this.arc.setColors(p.vfx, p.core);
      this.arc.clear();
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 0.85;
      const sx = x + Math.sin(ang) * r;
      const sz = z + Math.cos(ang) * r;
      const top = new THREE.Vector3(sx + (Math.random() - 0.5) * 4, ground(sx, sz) + 16, sz + (Math.random() - 0.5) * 4);
      this.arc.strike(top, new THREE.Vector3(sx, ground(sx, sz) + 0.1, sz), 0.4, 2, 0.12);
    } else if (p.element !== 'lightning') this.arc.clear();
    this.decal.setColors(p.vfx, p.core);
    // clouds carry smoke and sand areas, so their ground glow steps back
    this.decal.opacity.value = fade * (p.element === 'smoke' || p.element === 'sand' ? 0.55 : 1);
    this.decal.place({ type: 'circle', radius }, x, z, 0);
    this.radius.value = radius;
    this.main.value.setHex(p.vfx);
    this.fade.value = fade;
    this.motes.position.set(x, ground(x, z), z);
  }
}

class FlashView {
  readonly group = new THREE.Group();
  readonly decal: GroundDecal;
  readonly arc = new ArcView();
  lightning = false;
  private struck = -1;
  constructor(private readonly ground: Ground) {
    this.decal = new GroundDecal(ground);
    this.decal.setStyle('flash');
    this.group.add(this.decal.mesh, this.arc.group);
  }

  reset(p: GodPalette, circle: boolean): void {
    this.decal.setColors(p.vfx, p.core);
    this.lightning = p.element === 'lightning';
    this.decal.glyphs.value = p.element === 'runes' && circle ? 1 : 0;
    this.arc.setColors(p.vfx, p.core);
    this.arc.clear();
    this.struck = -1;
  }

  /** Lightning gods' shapes are struck by bolts, re-forked several times while the wave rolls out. */
  update(f: Flash, wave: number, fade: number): void {
    if (!this.lightning) return;
    this.arc.fade.value = fade;
    const step = Math.floor(f.age / 0.06);
    if (step === this.struck || f.age > f.life * 0.6) return;
    this.struck = step;
    const a = this.arc;
    a.clear();
    const s = f.shape;
    const g = (x: number, z: number) => this.ground(x, z);
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    switch (s.type) {
      case 'circle': {
        const fromCaster = Math.hypot(f.owner.x - s.x, f.owner.z - s.z) < 1;
        if (!fromCaster || s.radius < 6) {
          // a bolt from the sky into the center
          const top = v(s.x + (Math.random() - 0.5) * 3, g(s.x, s.z) + 18, s.z + (Math.random() - 0.5) * 3);
          a.strike(top, v(s.x, g(s.x, s.z) + 0.1, s.z), Math.min(0.5, 0.18 + s.radius * 0.05), 3, 0.12);
        }
        // arcs racing over the ground out to the wave front
        const n = s.radius > 8 ? 7 : 4;
        const reach = Math.max(0.6, s.radius * wave);
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * Math.PI * 2 + Math.random() * 0.8;
          const x = s.x + Math.sin(ang) * reach;
          const z = s.z + Math.cos(ang) * reach;
          a.bolt(v(s.x, g(s.x, s.z) + 0.4, s.z), v(x, g(x, z) + 0.15, z), 0.12, 0.25, 0.7, 3);
        }
        break;
      }
      case 'line': {
        const len = s.length * Math.max(0.15, wave);
        const ex = s.x - Math.sin(s.yaw) * len;
        const ez = s.z - Math.cos(s.yaw) * len;
        a.strike(v(s.x, g(s.x, s.z) + 1.3, s.z), v(ex, g(ex, ez) + 1.0, ez), Math.min(0.45, s.width * 0.18), 4, 0.08);
        break;
      }
      case 'cone': {
        const half = (s.angle * Math.PI) / 360;
        for (let i = 0; i < 4; i++) {
          const ang = s.yaw + (Math.random() - 0.5) * 2 * half;
          const r = s.range * Math.max(0.3, wave);
          const x = s.x - Math.sin(ang) * r;
          const z = s.z - Math.cos(ang) * r;
          a.bolt(v(s.x, g(s.x, s.z) + 1.2, s.z), v(x, g(x, z) + 0.3, z), 0.16, 0.22, 0.8, 4);
        }
        break;
      }
    }
  }
}

function flashDecal(s: FlashShape): { shape: DecalShape; x: number; z: number; yaw: number } {
  switch (s.type) {
    case 'circle':
      return { shape: { type: 'circle', radius: s.radius }, x: s.x, z: s.z, yaw: 0 };
    case 'line':
      return { shape: { type: 'rect', length: s.length, width: s.width }, x: s.x, z: s.z, yaw: s.yaw };
    case 'cone':
      return { shape: { type: 'cone', range: s.range, angle: s.angle }, x: s.x, z: s.z, yaw: s.yaw };
  }
}

/** Number of point lights reserved for spells. Fixed so the light count never changes (which would recompile shaders). */
const SPELL_LIGHTS = 4;

/**
 * Draws everything the simulation spawns: projectiles, lingering areas,
 * instant shapes and impact bursts. Reads `sim` state every frame and turns
 * sim events into one-shot effects.
 */
export class CombatVfx {
  readonly group = new THREE.Group();
  private readonly projectiles = new Map<number, ProjectileView>();
  private readonly zones = new Map<number, ZoneView>();
  private readonly flashes = new Map<number, FlashView>();
  private readonly bursts: Burst[] = [];
  private readonly projectilePool: Pool<ProjectileView>;
  private readonly zonePool: Pool<ZoneView>;
  private readonly flashPool: Pool<FlashView>;
  private readonly burstPool: Pool<Burst>;
  private readonly pillarPool: Pool<Pillar>;
  private readonly pillars: Pillar[] = [];
  /** Last time each unit flared from a hit, so damage over time doesn't spam sparks. */
  private readonly lastFlare = new WeakMap<object, number>();
  private clock = 0;
  private readonly lights: THREE.PointLight[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly ground: Ground) {
    this.group.name = 'combat-vfx';
    this.projectilePool = new Pool(this.group, () => new ProjectileView(), 8);
    this.zonePool = new Pool(this.group, () => new ZoneView(ground), 4);
    this.flashPool = new Pool(this.group, () => new FlashView(ground), 6);
    this.burstPool = new Pool(this.group, () => new Burst(), 16);
    this.pillarPool = new Pool(this.group, () => new Pillar(), 2);
    for (let i = 0; i < SPELL_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 14, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  frame(sim: Sim, dt: number, t: number): void {
    this.clock = t;
    for (let i = this.pillars.length - 1; i >= 0; i--) {
      const p = this.pillars[i]!;
      if (!p.update(dt)) {
        this.pillars.splice(i, 1);
        this.pillarPool.release(p);
      }
    }
    this.syncProjectiles(sim, t);
    this.syncZones(sim);
    this.syncFlashes(sim);
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      if (!b.update(dt)) {
        this.bursts.splice(i, 1);
        this.burstPool.release(b);
      }
    }
    this.placeLights(sim);
  }

  burst(p: GodPalette, x: number, y: number, z: number, power = 1): void {
    const b = this.burstPool.take();
    b.start(p, this.tmp.set(x, y, z), power, this.ground(x, z));
    this.bursts.push(b);
  }

  onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'impact': {
        const k = e.owner.kind;
        const power = e.big ? 1.6 : k === 'minion' ? 0.35 : isStructure(e.owner) ? 1.1 : 0.8;
        this.burst(paletteOf(e.owner), e.x, this.ground(e.x, e.z) + (e.big ? 0.4 : PROJECTILE_HEIGHT), e.z, power);
        break;
      }
      case 'cast': {
        const u = e.unit;
        const f = u.forward;
        this.burst(paletteOf(u), u.x + f.x * 0.7, u.body.y + 1.9, u.z + f.z * 0.7, 0.7);
        break;
      }
      case 'teleport':
        if (e.unit.alive) {
          const p = paletteOf(e.unit);
          this.burst(p, e.fromX, this.ground(e.fromX, e.fromZ) + 1.2, e.fromZ, 1.2);
          this.burst(p, e.unit.x, e.unit.body.y + 1.2, e.unit.z, 1.2);
        }
        break;
      case 'levelUp':
        this.burst({ ...paletteFor(''), vfx: 0xffc24a, core: 0xfff3c8 }, e.unit.x, e.unit.body.y + 0.3, e.unit.z, 2.2);
        break;
      case 'damage': {
        // a quick flare on gods that get hit, in the attacker's colors
        const u = e.target;
        if ((u.kind !== 'god' && u.kind !== 'dummy') || !e.source || e.amount <= 0) break;
        if (this.clock - (this.lastFlare.get(u) ?? -1) < 0.12) break;
        this.lastFlare.set(u, this.clock);
        this.burst(paletteOf(e.source), u.x, u.body.y + 1.4, u.z, e.crit ? 0.7 : 0.4);
        break;
      }
      case 'death': {
        const k = e.unit.kind;
        if (k === 'god') {
          const p = this.pillarPool.take();
          p.start(paletteOf(e.unit), e.unit.x, this.ground(e.unit.x, e.unit.z), e.unit.z);
          this.pillars.push(p);
        }
        const power = k === 'minion' ? 0.6 : isStructure(e.unit) ? 4 : 1.8;
        this.burst(paletteOf(e.unit), e.unit.x, e.unit.body.y + (isStructure(e.unit) ? 4 : 1.2), e.unit.z, power);
        break;
      }
      default:
        break;
    }
  }

  private syncProjectiles(sim: Sim, t: number): void {
    const live = new Set<number>();
    for (const p of sim.projectiles) {
      live.add(p.id);
      const at = this.tmp.set(p.x, this.ground(p.x, p.z) + projectileHeight(p), p.z);
      let v = this.projectiles.get(p.id);
      if (!v) {
        v = this.projectilePool.take();
        const size = p.cast ? Math.min(1.3, 0.35 + p.radius * 0.45) : isStructure(p.owner) ? 0.75 : p.owner.kind === 'minion' ? 0.16 : 0.28;
        v.reset(paletteOf(p.owner), size, at);
        this.projectiles.set(p.id, v);
      }
      v.update(at, t);
    }
    for (const [id, v] of this.projectiles) {
      if (live.has(id)) continue;
      this.projectiles.delete(id);
      this.projectilePool.release(v);
    }
  }

  private syncZones(sim: Sim): void {
    const live = new Set<number>();
    for (const z of sim.zones) {
      live.add(z.id);
      let v = this.zones.get(z.id);
      if (!v) {
        v = this.zonePool.take();
        this.zones.set(z.id, v);
      }
      const fadeIn = Math.min(1, z.age / 0.25);
      const fadeOut = Math.min(1, Math.max(0, (z.duration + 0.4 - z.age) / 0.6));
      v.set(paletteOf(z.owner), z.x, z.z, z.radius, fadeIn * fadeOut, this.ground, sim.time);
    }
    for (const [id, v] of this.zones) {
      if (live.has(id)) continue;
      this.zones.delete(id);
      this.zonePool.release(v);
    }
  }

  private syncFlashes(sim: Sim): void {
    const live = new Set<number>();
    for (const f of sim.flashes) {
      live.add(f.id);
      let v = this.flashes.get(f.id);
      if (!v) {
        v = this.flashPool.take();
        const p = paletteOf(f.owner);
        v.reset(p, f.shape.type === 'circle');
        // smoke and sand gods kick up a cloud where the shape lands
        if (p.element === 'smoke' || p.element === 'sand') {
          const s = f.shape;
          const reach = s.type === 'circle' ? s.radius : s.type === 'line' ? s.length * 0.5 : s.range * 0.6;
          const yaw = s.type === 'circle' ? 0 : s.yaw;
          const d = s.type === 'circle' ? 0 : reach;
          const cx = s.x - Math.sin(yaw) * d;
          const cz = s.z - Math.cos(yaw) * d;
          this.burst(p, cx, this.ground(cx, cz) + 0.6, cz, Math.min(2.5, 0.6 + reach * 0.35));
        }
        const d = flashDecal(f.shape);
        v.decal.place(d.shape, d.x, d.z, d.yaw);
        this.flashes.set(f.id, v);
      }
      // the front sweeps out over the first half, then everything fades
      const k = Math.min(1, f.age / f.life);
      const wave = 1 - (1 - Math.min(1, k / 0.55)) ** 2;
      const fade = k < 0.5 ? 1 : 1 - (k - 0.5) / 0.5;
      v.decal.wave.value = wave;
      v.decal.opacity.value = fade * 1.3;
      v.update(f, wave, fade);
    }
    for (const [id, v] of this.flashes) {
      if (live.has(id)) continue;
      this.flashes.delete(id);
      this.flashPool.release(v);
    }
  }

  /** Give the brightest current effects real light so they color the ground and gods. */
  private placeLights(sim: Sim): void {
    const sources: { x: number; y: number; z: number; color: number; intensity: number }[] = [];
    for (const z of sim.zones) {
      sources.push({ x: z.x, y: this.ground(z.x, z.z) + 1.2, z: z.z, color: paletteOf(z.owner).vfx, intensity: 14 });
    }
    for (const p of sim.projectiles) {
      if (!p.cast && !isStructure(p.owner)) continue;
      sources.push({ x: p.x, y: this.ground(p.x, p.z) + projectileHeight(p), z: p.z, color: paletteOf(p.owner).vfx, intensity: 9 });
    }
    this.lights.forEach((l, i) => {
      const s = sources[i];
      if (!s) {
        l.intensity = 0;
        return;
      }
      l.position.set(s.x, s.y, s.z);
      l.color.setHex(s.color);
      l.intensity = s.intensity;
    });
  }
}

/** Height of the muzzle shots leave from, per structure kind (the structure models can refine it). */
export const MUZZLE_HEIGHT: Partial<Record<string, number>> = { tower: 8.5, phoenix: 6 };

/** Structure shots fall from the muzzle onto their target; everything else flies level. */
function projectileHeight(p: Projectile): number {
  const top = MUZZLE_HEIGHT[p.owner.kind];
  if (top === undefined || !p.homing) return PROJECTILE_HEIGHT;
  const range = p.owner.combatant.god.basicAttack.range * WORLD_SCALE + p.owner.radius;
  const d = Math.hypot(p.homing.x - p.x, p.homing.z - p.z);
  const k = Math.min(1, d / range);
  return 1.3 + (top - 1.3) * k;
}
