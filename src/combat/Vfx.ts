import * as THREE from 'three/webgpu';
import {
  attribute, cos, float, fract, hash, instanceIndex, mix, mx_noise_float, sin, smoothstep, time, uv, vec2, vec3, vec4,
} from '../render/tsl';
import { instancedSprite, objectUniforms, spriteQuads, useUniforms } from '../render/shared';
import type { Sim } from '../sim/Sim';
import { PROJECTILE_HEIGHT } from '../sim/Sim';
import { isStructure, WORLD_SCALE, type Unit, type Flash, type FlashShape, type Projectile, type SimEvent } from '../sim/Unit';
import { ArcView } from './Arcs';
import { GroundDecal, type DecalShape } from './GroundDecal';
import { BUFF_GLOW } from './MonsterViews';
import { paletteFor, paletteOf, type GodPalette } from './palette';
import { hypot } from '../core/math';

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

  /** Shows every idle object, all of its parts, until the returned function puts them away again. */
  prime(): () => void {
    const flipped: THREE.Object3D[] = [];
    const shown = [...this.free];
    for (const t of shown) {
      this.parent.add(t.group);
      t.group.traverse((o) => {
        if (o.visible) return;
        o.visible = true;
        flipped.push(o);
      });
    }
    return () => {
      for (const o of flipped) o.visible = !o.visible;
      for (const t of shown) this.parent.remove(t.group);
    };
  }
}

const TRAIL = 9;

/** Each shot's own colors for the materials every shot shares. */
const shotUniforms = () => ({ main: new THREE.Color(), hot: new THREE.Color() });
let shotMaterials: { core: THREE.SpriteNodeMaterial; halo: THREE.SpriteNodeMaterial; trail: THREE.SpriteNodeMaterial } | null = null;

function makeShotMaterials(): NonNullable<typeof shotMaterials> {
  const { main, hot } = objectUniforms(shotUniforms());
  const trail = glowMaterial(main, float(1.5), 1.8, false, 0.55);
  // each puff's xyz = position, w = size, from the shot's own `trail` attribute
  const point = attribute('trail', 'vec4');
  trail.positionNode = point.xyz;
  trail.scaleNode = vec2(point.w, point.w);
  return { core: glowMaterial(hot, float(5), 2.5), halo: glowMaterial(main, float(1.8), 1.6, false, 0.75), trail };
}

class ProjectileView {
  readonly group = new THREE.Group();
  private readonly values = shotUniforms();
  private readonly coreSprite: THREE.Sprite;
  private readonly halo: THREE.Sprite;
  /** The whole trail is one instanced sprite (a draw call, not one per puff). */
  private readonly trail: THREE.Sprite;
  private readonly trailPoints: THREE.InstancedBufferAttribute;
  private readonly history: THREE.Vector3[] = [];
  private readonly arc = new ArcView();
  private lightning = false;
  private crackle = 0;
  size = 1;

  constructor() {
    const m = (shotMaterials ??= makeShotMaterials());
    this.group.name = 'shot';
    this.coreSprite = new THREE.Sprite(m.core);
    this.halo = new THREE.Sprite(m.halo);
    this.trail = new THREE.Sprite(m.trail);
    this.trail.geometry = spriteQuads(TRAIL, true);
    this.trailPoints = new THREE.InstancedBufferAttribute(new Float32Array(TRAIL * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.trail.geometry.setAttribute('trail', this.trailPoints);
    this.group.add(this.trail, this.halo, this.coreSprite, this.arc.group);
    for (const o of [this.coreSprite, this.halo, this.trail]) {
      o.frustumCulled = false;
      o.renderOrder = 12;
    }
    useUniforms(this.values, this.coreSprite, this.halo, this.trail);
  }

  reset(p: GodPalette, size: number, at: THREE.Vector3, crackle = false): void {
    this.values.main.setHex(p.vfx);
    this.values.hot.setHex(p.core);
    this.size = size;
    this.lightning = crackle || p.element === 'lightning';
    this.arc.setColors(p.vfx, p.core);
    this.arc.clear();
    this.crackle = 0;
    this.history.length = 0;
    for (let i = 0; i < TRAIL; i++) this.history.push(at.clone());
  }

  update(at: THREE.Vector3, t: number): void {
    this.history.unshift(this.history.pop()!.copy(at));
    const flicker = 1 + Math.sin(t * 40) * 0.08;
    this.coreSprite.position.copy(at);
    this.coreSprite.scale.setScalar(this.size * 0.7 * flicker);
    this.halo.position.copy(at);
    this.halo.scale.setScalar(this.size * 2.6);
    for (let i = 0; i < TRAIL; i++) {
      // trail puffs sit between history samples so fast shots stay continuous
      const a = this.history[Math.min(i, this.history.length - 1)]!;
      const b = this.history[Math.min(i + 1, this.history.length - 1)]!;
      this.trailPoints.setXYZW(i, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, this.size * 1.9 * (1 - i / TRAIL));
    }
    this.trailPoints.needsUpdate = true;
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

/** Each cloud's own values for the material every cloud shares. */
const puffUniforms = () => ({
  age: 0,
  seed: 0,
  power: 1,
  radius: 1,
  fade: 1,
  /** 0 for a one-shot burst, 1 for a looping area. */
  loop: 0,
  /** Swirl speed: sand spirals, smoke drifts. */
  swirl: 0,
  tint: new THREE.Color(),
});
let puffMaterial: THREE.SpriteNodeMaterial | null = null;

function makePuffMaterial(): THREE.SpriteNodeMaterial {
  const u = objectUniforms(puffUniforms());
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const id = instanceIndex.toFloat();
  const h1 = hash(id.add(u.seed));
  const h2 = hash(id.mul(2.9).add(u.seed));
  const h3 = hash(id.mul(6.1).add(u.seed));
  // burst: life is the burst's age; loop: each puff cycles on its own clock
  const cycle = fract(time.mul(h2.mul(0.25).add(0.3)).add(h3));
  const life = mix(u.age.div(1.2).clamp(0, 1), cycle, u.loop);
  const out = float(1).sub(float(1).sub(life).pow(3));
  const ang = h1.mul(6.283).add(life.mul(u.swirl).mul(3)).add(time.mul(u.swirl).mul(u.loop));
  const dist = mix(out.mul(h2.mul(1.6).add(0.6)).mul(u.power), h2.sqrt().mul(u.radius), u.loop);
  mat.positionNode = vec3(cos(ang).mul(dist), life.mul(mix(float(1.1), float(2.2), u.loop)).add(h3.mul(0.5)).add(0.3), sin(ang).mul(dist));
  const size = mix(float(0.6), float(1.6), out).mul(h3.mul(0.6).add(0.7)).mul(mix(u.power, u.radius.mul(0.3).add(0.8).min(2.6), u.loop));
  mat.scaleNode = vec2(size, size);
  const p = uv().sub(0.5);
  const billow = mx_noise_float(vec3(p.x.mul(3), p.y.mul(3), h1.mul(40).add(time.mul(0.4)))).mul(0.5).add(0.5);
  const soft = smoothstep(0.5, 0.2, p.length()).pow(0.6).mul(billow.mul(0.5).add(0.5));
  const fadeLife = smoothstep(0, 0.08, life).mul(float(1).sub(life).pow(0.8));
  // lit from above: tops a little lighter than undersides
  const shade = mix(float(0.75), float(1.25), uv().y);
  mat.colorNode = vec4(u.tint.mul(shade), 1);
  mat.opacityNode = soft.mul(fadeLife).mul(u.fade).mul(0.9);
  return mat;
}

/**
 * Soft, alpha-blended clouds: Loki's smoke and Anubis's sand. One instanced
 * sprite set; a burst throws puffs out once, a zone keeps them rolling.
 */
class Puffs {
  readonly sprite: THREE.Sprite;
  readonly values = puffUniforms();

  constructor(count: number) {
    this.sprite = instancedSprite((puffMaterial ??= makePuffMaterial()), count);
    this.sprite.name = 'puffs';
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
    useUniforms(this.values, this.sprite);
  }

  set(color: number | undefined): void {
    this.sprite.visible = color !== undefined;
    if (color !== undefined) this.values.tint.setHex(color);
  }
}

/** Each burst's own values for the materials every burst shares. */
const burstUniforms = () => ({ age: 0, main: new THREE.Color(), hot: new THREE.Color(), seed: 0, power: 1 });
let burstParts: { ring: THREE.MeshBasicNodeMaterial; ringShape: THREE.BufferGeometry; flash: THREE.SpriteNodeMaterial; sparks: THREE.SpriteNodeMaterial } | null = null;
const SPARKS = 18;

function makeBurstParts(): NonNullable<typeof burstParts> {
  const { age, main, hot, seed, power } = objectUniforms(burstUniforms());
  const fade = float(1).sub(age.div(0.6)).clamp(0, 1);
  const ring = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const ringFade = float(1).sub(age.div(0.45)).clamp(0, 1);
  const band = smoothstep(0, 0.5, uv().x).mul(smoothstep(1, 0.6, uv().x));
  ring.colorNode = vec4(mix(main, hot, band.mul(0.5)).mul(float(2).add(band.mul(4))), 1);
  ring.opacityNode = band.mul(ringFade.pow(1.4)).mul(0.9);
  const ringShape = new THREE.RingGeometry(0.7, 1, 48, 1).rotateX(-Math.PI / 2);
  // RingGeometry's uv is planar; rebuild u as the radial position across the band
  const uvs = ringShape.getAttribute('uv') as THREE.BufferAttribute;
  const ps = ringShape.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < ps.count; i++) uvs.setX(i, (hypot(ps.getX(i), ps.getZ(i)) - 0.7) / 0.3);
  const flash = glowMaterial(mix(main, hot, 0.3).mul(2.5), float(1), 1.8, false, fade.pow(1.5).mul(0.9));

  const sparks = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const id = instanceIndex.toFloat();
  const h1 = hash(id.add(seed));
  const h2 = hash(id.mul(3.7).add(seed));
  const h3 = hash(id.mul(9.1).add(seed));
  const ang = h1.mul(6.283);
  const up = h2.mul(0.9).add(0.2);
  const speed = h3.mul(5).add(3).mul(power);
  const dist = speed.mul(age).mul(float(1).sub(age.mul(0.6)));
  sparks.positionNode = vec3(
    cos(ang).mul(dist),
    up.mul(speed).mul(age).sub(age.mul(age).mul(9)),
    sin(ang).mul(dist),
  );
  const s = float(0.09).mul(power).mul(fade).mul(h2.add(0.6));
  sparks.scaleNode = vec2(s, s);
  const dot = smoothstep(0.5, 0, uv().sub(0.5).length());
  sparks.colorNode = vec4(mix(main, hot, h3.mul(0.6)).mul(9).mul(fade), 1);
  sparks.opacityNode = dot.mul(fade);
  return { ring, ringShape, flash, sparks };
}

/** A short burst: a flash plus sparks thrown outward, all animated on the GPU from `age`. */
class Burst {
  readonly group = new THREE.Group();
  readonly values = burstUniforms();
  life = 0.6;
  private readonly flash: THREE.Sprite;
  /** Flat shockwave ring rolling out over the ground. */
  private readonly ring: THREE.Mesh;
  private readonly puffs = new Puffs(10);

  constructor() {
    const m = (burstParts ??= makeBurstParts());
    this.group.name = 'burst';
    this.ring = new THREE.Mesh(m.ringShape, m.ring);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 6;
    this.flash = new THREE.Sprite(m.flash);
    this.flash.frustumCulled = false;
    const sparks = instancedSprite(m.sparks, SPARKS);
    sparks.frustumCulled = false;
    sparks.renderOrder = 13;
    this.group.add(this.ring, this.puffs.sprite, this.flash, sparks);
    useUniforms(this.values, this.ring, this.flash, sparks);
  }

  start(p: GodPalette, at: THREE.Vector3, power: number, groundY: number): void {
    this.group.position.copy(at);
    // the ring only for hits near the ground and strong enough to shake it
    this.ring.visible = power >= 0.75 && at.y - groundY < 2.5;
    this.ring.position.y = groundY - at.y + 0.12;
    const puff = p.element ? PUFF_COLORS[p.element] : undefined;
    const v = this.values;
    const cloud = this.puffs.values;
    this.puffs.set(power >= 0.5 ? puff : undefined);
    cloud.age = 0;
    cloud.seed = v.seed;
    cloud.power = power;
    this.puffs.sprite.position.y = groundY - at.y;
    cloud.swirl = p.element === 'sand' ? 1 : 0.15;
    this.life = this.puffs.sprite.visible ? 1.2 : 0.6;
    v.main.setHex(p.vfx);
    v.hot.setHex(p.core);
    v.seed = Math.random() * 100;
    v.power = power;
    v.age = 0;
    this.flash.scale.setScalar(0.1);
  }

  update(dt: number): boolean {
    const v = this.values;
    v.age += dt;
    this.puffs.values.age = v.age;
    const k = Math.min(1, v.age / 0.18);
    this.flash.scale.setScalar((1.0 + k * 1.6) * v.power);
    const r = 1 - (1 - Math.min(1, v.age / 0.45)) ** 3;
    this.ring.scale.setScalar(0.3 + r * 2.6 * v.power);
    return v.age < this.life;
  }
}

/** Each pillar's own values for the material every pillar shares. */
const pillarUniforms = () => ({ age: 0, main: new THREE.Color(), hot: new THREE.Color() });
const PILLAR_LIFE = 1.6;
let pillarMaterial: THREE.MeshBasicNodeMaterial | null = null;

function makePillarMaterial(): THREE.MeshBasicNodeMaterial {
  const { age, main, hot } = objectUniforms(pillarUniforms());
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, forceSinglePass: true });
  const v = uv().y;
  const fade = float(1).sub(age.div(PILLAR_LIFE)).clamp(0, 1);
  // bright at the foot, streaked as it climbs
  const streak = sin(uv().x.mul(6.283 * 7).add(age.mul(3))).mul(0.25).add(0.75);
  const body = float(1).sub(v).pow(1.6).mul(streak);
  m.colorNode = vec4(mix(main, hot, float(1).sub(v).pow(10)).mul(body).mul(3).mul(fade.pow(1.5)), 1);
  m.opacityNode = body.mul(fade);
  return m;
}

/** A column of light where a god falls, rising and thinning out. */
class Pillar {
  readonly group = new THREE.Group();
  private readonly values = pillarUniforms();
  private readonly beam: THREE.Mesh;

  constructor() {
    this.group.name = 'pillar';
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0), (pillarMaterial ??= makePillarMaterial()));
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 12;
    useUniforms(this.values, this.beam);
    this.group.add(this.beam);
  }

  start(p: GodPalette, x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.values.main.setHex(p.vfx);
    this.values.hot.setHex(p.core);
    this.values.age = 0;
  }

  update(dt: number): boolean {
    const k = (this.values.age += dt);
    const rise = 1 - Math.exp(-k * 5);
    this.beam.scale.set(0.5 + 0.9 * (1 - rise) + 0.3, 2 + rise * 30, 0.5 + 0.9 * (1 - rise) + 0.3);
    return k < PILLAR_LIFE;
  }
}

/** Each area's own values for the mote material every area shares. */
const moteUniforms = () => ({ radius: 1, main: new THREE.Color(), fade: 1 });
let moteMaterial: THREE.SpriteNodeMaterial | null = null;

function makeMoteMaterial(): THREE.SpriteNodeMaterial {
  const { radius, main, fade } = objectUniforms(moteUniforms());
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const id = instanceIndex.toFloat();
  const life = fract(time.mul(hash(id).mul(0.4).add(0.35)).add(hash(id.mul(2.3))));
  const ang = hash(id.mul(5.1)).mul(6.283).add(time.mul(0.6));
  const rad = hash(id.mul(7.7)).sqrt().mul(radius);
  mat.positionNode = vec3(cos(ang).mul(rad), life.mul(2.8).add(0.1), sin(ang).mul(rad));
  const s = float(0.07).mul(float(1).sub(life)).mul(hash(id.mul(1.3)).add(0.5));
  mat.scaleNode = vec2(s, s);
  const dot = smoothstep(0.5, 0, uv().sub(0.5).length());
  mat.colorNode = vec4(main.mul(7).mul(fade), 1);
  mat.opacityNode = dot.mul(smoothstep(1, 0.5, life)).mul(fade);
  return mat;
}

/** A lingering area: a churning ground decal with motes rising through it. */
class ZoneView {
  readonly group = new THREE.Group();
  readonly decal: GroundDecal;
  private readonly values = moteUniforms();
  private readonly motes: THREE.Sprite;
  private readonly arc = new ArcView();
  private strikeAt = 0;
  private readonly puffs = new Puffs(40);

  constructor(ground: Ground) {
    this.group.name = 'zone';
    this.decal = new GroundDecal(ground);
    this.decal.setStyle('zone');
    this.motes = instancedSprite((moteMaterial ??= makeMoteMaterial()), 40);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 13;
    useUniforms(this.values, this.motes);
    this.group.add(this.decal.mesh, this.motes, this.arc.group, this.puffs.sprite);
  }

  set(p: GodPalette, x: number, z: number, radius: number, fade: number, ground: Ground, t: number): void {
    this.decal.values.glyphs = p.element === 'runes' ? 1 : 0;
    this.puffs.set(p.element ? PUFF_COLORS[p.element] : undefined);
    const cloud = this.puffs.values;
    cloud.loop = 1;
    cloud.radius = radius;
    cloud.fade = fade;
    cloud.swirl = p.element === 'sand' ? 1.4 : 0.1;
    this.puffs.sprite.position.set(x, ground(x, z), z);
    this.arc.values.fade = fade * Math.max(0, 1 - (t - this.strikeAt) / 0.14);
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
    this.decal.values.opacity = fade * (p.element === 'smoke' || p.element === 'sand' ? 0.55 : 1);
    this.decal.place({ type: 'circle', radius }, x, z, 0);
    this.values.radius = radius;
    this.values.main.setHex(p.vfx);
    this.values.fade = fade;
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
    this.group.name = 'flash';
    this.decal = new GroundDecal(ground);
    this.decal.setStyle('flash');
    this.group.add(this.decal.mesh, this.arc.group);
  }

  reset(p: GodPalette, circle: boolean): void {
    this.decal.setColors(p.vfx, p.core);
    this.lightning = p.element === 'lightning';
    this.decal.values.glyphs = p.element === 'runes' && circle ? 1 : 0;
    this.arc.setColors(p.vfx, p.core);
    this.arc.clear();
    this.struck = -1;
  }

  /** Lightning gods' shapes are struck by bolts, re-forked several times while the wave rolls out. */
  update(f: Flash, wave: number, fade: number): void {
    if (!this.lightning) return;
    this.arc.values.fade = fade;
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
        const fromCaster = hypot(f.owner.x - s.x, f.owner.z - s.z) < 1;
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
  private readonly tethers = new Map<object, { arc: ArcView; at: number }>();
  /** Structure → the god it is shooting, set by the game each frame. */
  targets: () => Iterable<readonly [Unit, Unit | null]> = () => [];
  /** The local player, whose tethers are drawn brighter. */
  player: Unit | null = null;
  private readonly tmp = new THREE.Vector3();

  /** `lights` are the map's spell lights (`World.spellLights`), placed on the brightest effects each frame. */
  constructor(
    private readonly ground: Ground,
    private readonly lights: readonly THREE.PointLight[],
  ) {
    this.group.name = 'combat-vfx';
    this.projectilePool = new Pool(this.group, () => new ProjectileView(), 8);
    this.zonePool = new Pool(this.group, () => new ZoneView(ground), 4);
    this.flashPool = new Pool(this.group, () => new FlashView(ground), 6);
    this.burstPool = new Pool(this.group, () => new Burst(), 16);
    this.pillarPool = new Pool(this.group, () => new Pillar(), 2);
  }

  /**
   * Shows every pooled effect until the returned function is called, so that
   * a loading frame draws them and prepares their shaders: generating one on
   * an effect's first cast stalled the fight.
   */
  prime(): () => void {
    const restore = [this.projectilePool, this.zonePool, this.flashPool, this.burstPool, this.pillarPool].map((p) => p.prime());
    return () => {
      for (const r of restore) r();
    };
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
    this.syncTethers(t);
  }

  /** A crackling line from each structure to the god it is targeting, so you see when a tower is on you. */
  private syncTethers(t: number): void {
    const live = new Set<object>();
    for (const [s, target] of this.targets()) {
      if (!s.alive || !target || target.kind !== 'god' || !target.alive) continue;
      live.add(s);
      let v = this.tethers.get(s);
      if (!v) {
        v = { arc: new ArcView(), at: -1 };
        this.group.add(v.arc.group);
        this.tethers.set(s, v);
      }
      v.arc.group.visible = true;
      const p = paletteOf(s);
      v.arc.setColors(p.vfx, p.core);
      v.arc.values.fade = (target === this.player ? 0.9 : 0.4) * (0.8 + Math.sin(t * 14) * 0.2);
      if (t - v.at < 0.08) continue;
      v.at = t;
      v.arc.clear();
      const top = MUZZLE_HEIGHT[s.kind] ?? 4;
      const a = new THREE.Vector3(s.x, s.body.y + top, s.z);
      const b = new THREE.Vector3(target.x, target.body.y + 1.3, target.z);
      v.arc.bolt(a, b, target === this.player ? 0.16 : 0.08, 0.03, target === this.player ? 0.7 : 0.4, 4);
    }
    for (const [s, v] of this.tethers) {
      if (live.has(s)) continue;
      v.arc.group.visible = false;
      v.arc.clear();
    }
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
      case 'basic': {
        // the Warden's two-fisted slam cracks the ground in front of it
        const u = e.unit;
        if (u.kind !== 'monster' || u.tag.includes('thornback')) break;
        const f = u.forward;
        const reach = u.radius + 1.2;
        const x = u.x + f.x * reach;
        const z = u.z + f.z * reach;
        this.burst(monsterPalette(u), x, this.ground(x, z) + 0.3, z, u.radius > 2 ? 2.4 : 1.5);
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
        if ((u.kind !== 'god' && u.kind !== 'dummy' && u.kind !== 'monster') || !e.source || e.amount <= 0) break;
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
        const power = k === 'minion' ? 0.6 : isStructure(e.unit) || e.unit.radius > 2 ? 4 : k === 'monster' ? (e.unit.tag.endsWith('warden') ? 2.6 : 0.9) : 1.8;
        this.burst(monsterPalette(e.unit), e.unit.x, e.unit.body.y + (isStructure(e.unit) ? 4 : 1.2), e.unit.z, power);
        // a buff leaves its Warden in a flare and settles on the god who took it
        if (k === 'monster' && e.unit.tag.endsWith('warden') && e.killer?.kind === 'god') {
          const g = e.killer;
          this.burst(monsterPalette(e.unit), g.x, g.body.y + 1.3, g.z, 1.6);
        }
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
        // structure shots crackle like lightning so they read as heavy
        v.reset(paletteOf(p.owner), size, at, isStructure(p.owner));
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
        const p = monsterPalette(f.owner);
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
      v.decal.values.wave = wave;
      v.decal.values.opacity = fade * 1.3;
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

/** Wardens burn in their buff's color; everything else uses its usual palette. */
function monsterPalette(u: Unit): GodPalette {
  const p = paletteOf(u);
  if (u.tag.endsWith('treasureWyrm')) return { ...p, vfx: 0xffc83a, core: 0xfff6d0 };
  if (u.tag.endsWith('moltenColossus')) return { ...p, vfx: 0xff4a10, core: 0xffd080 };
  if (u.kind !== 'monster' || !u.tag.endsWith('warden')) return p;
  const kind = u.tag.split(':')[0]!.split('-')[1] as keyof typeof BUFF_GLOW;
  const c = BUFF_GLOW[kind];
  return c === undefined ? p : { ...p, vfx: c, core: 0xffffff };
}

/** Height of the muzzle shots leave from, per structure kind (the structure models can refine it). */
export const MUZZLE_HEIGHT: Partial<Record<string, number>> = { tower: 8.5, phoenix: 6 };

/** Structure shots fall from the muzzle onto their target; everything else flies level. */
function projectileHeight(p: Projectile): number {
  const top = MUZZLE_HEIGHT[p.owner.kind];
  if (top === undefined || !p.homing) return PROJECTILE_HEIGHT;
  const range = p.owner.combatant.god.basicAttack.range * WORLD_SCALE + p.owner.radius;
  const d = hypot(p.homing.x - p.x, p.homing.z - p.z);
  const k = Math.min(1, d / range);
  return 1.3 + (top - 1.3) * k;
}
