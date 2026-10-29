import * as THREE from 'three/webgpu';
import {
  cos, float, fract, hash, instanceIndex, mix, sin, smoothstep, time, uniform, uv, vec2, vec3, vec4,
} from '../render/tsl';
import type { Sim } from '../sim/Sim';
import { PROJECTILE_HEIGHT } from '../sim/Sim';
import { isStructure, WORLD_SCALE, type FlashShape, type Projectile, type SimEvent } from '../sim/Unit';
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
    this.group.add(this.halo, this.coreSprite);
    for (const o of [this.coreSprite, this.halo, ...this.trail]) {
      o.frustumCulled = false;
      o.renderOrder = 12;
    }
  }

  reset(p: GodPalette, size: number, at: THREE.Vector3): void {
    this.main.value.setHex(p.vfx);
    this.hot.value.setHex(p.core);
    this.size = size;
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

  constructor() {
    const fade = float(1).sub(this.age.div(0.6)).clamp(0, 1);
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

  start(p: GodPalette, at: THREE.Vector3, power: number): void {
    this.group.position.copy(at);
    this.main.value.setHex(p.vfx);
    this.hot.value.setHex(p.core);
    this.seed.value = Math.random() * 100;
    this.power.value = power;
    this.age.value = 0;
    this.flash.scale.setScalar(0.1);
  }

  update(dt: number): boolean {
    this.age.value += dt;
    const k = Math.min(1, this.age.value / 0.18);
    this.flash.scale.setScalar((1.0 + k * 1.6) * this.power.value);
    return this.age.value < this.life;
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

  set(p: GodPalette, x: number, z: number, radius: number, fade: number, ground: Ground): void {
    this.decal.setColors(p.vfx, p.core);
    this.decal.opacity.value = fade;
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
  constructor(ground: Ground) {
    this.decal = new GroundDecal(ground);
    this.decal.setStyle('flash');
    this.group.add(this.decal.mesh);
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
  private readonly lights: THREE.PointLight[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly ground: Ground) {
    this.group.name = 'combat-vfx';
    this.projectilePool = new Pool(this.group, () => new ProjectileView(), 8);
    this.zonePool = new Pool(this.group, () => new ZoneView(ground), 4);
    this.flashPool = new Pool(this.group, () => new FlashView(ground), 6);
    this.burstPool = new Pool(this.group, () => new Burst(), 16);
    for (let i = 0; i < SPELL_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 14, 2);
      l.castShadow = false;
      this.lights.push(l);
      this.group.add(l);
    }
  }

  frame(sim: Sim, dt: number, t: number): void {
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
    b.start(p, this.tmp.set(x, y, z), power);
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
      case 'death': {
        const k = e.unit.kind;
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
      v.set(paletteOf(z.owner), z.x, z.z, z.radius, fadeIn * fadeOut, this.ground);
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
        v.decal.setColors(p.vfx, p.core);
        const d = flashDecal(f.shape);
        v.decal.place(d.shape, d.x, d.z, d.yaw);
        this.flashes.set(f.id, v);
      }
      const k = f.age / f.life;
      v.decal.opacity.value = (1 - k) * (1 - k) * 1.4;
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
