import type { BasicShot, CastError, ResolvedSkill, Team } from '../game/combatant';
import { ranked } from '../game/progression';
import {
  nextEntityId,
  Unit,
  WORLD_SCALE,
  worldSpeed,
  type Flash,
  type FlashShape,
  type Point,
  type Projectile,
  type SimEvent,
  type Zone,
} from './Unit';

/** What the simulation needs from the arena. CollisionWorld satisfies it. */
export interface SimTerrain {
  groundAt(x: number, z: number): number;
  resolve(x: number, z: number, radius: number, feetY: number): { x: number; z: number };
}

export interface BaseZone {
  x: number;
  z: number;
  radius: number;
}

export const RECALL_TIME = 8;
/** Height above the ground that projectiles fly at. */
export const PROJECTILE_HEIGHT = 1.5;
/** How far a bouncing projectile looks for its next target, arena meters. */
const BOUNCE_RANGE = 9;
const LEAP_SPEED = 24;
const DASH_SPEED = 28;
/** Melee basic attacks hit everything in this arc (degrees). */
const MELEE_ARC = 100;

export type CastResult = CastError | 'forced' | null;

/**
 * The match simulation: positions, projectiles, areas, dashes and leaps on top
 * of the rules engine. It never touches three.js; the view reads its state and
 * drains `events` each frame. Runs on the fixed 60 Hz step.
 */
export class Sim {
  readonly units: Unit[] = [];
  readonly projectiles: Projectile[] = [];
  readonly zones: Zone[] = [];
  readonly flashes: Flash[] = [];
  private pending: { at: number; owner: Unit; cast: ResolvedSkill; target: Unit }[] = [];
  private events: SimEvent[] = [];
  time = 0;

  constructor(
    readonly terrain: SimTerrain,
    readonly bases: Record<Team, BaseZone>,
    readonly rng: () => number = Math.random,
  ) {}

  add(unit: Unit): Unit {
    this.units.push(unit);
    unit.body.y = this.terrain.groundAt(unit.x, unit.z);
    unit.combatant.inBase = this.inBase(unit);
    return unit;
  }

  remove(unit: Unit): void {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  unitByCombatantUid(uid: number): Unit | undefined {
    return this.units.find((u) => u.combatant.uid === uid);
  }

  inBase(u: Unit): boolean {
    const b = this.bases[u.team];
    return Math.hypot(u.x - b.x, u.z - b.z) <= b.radius;
  }

  /** Whether input (or a bot) may walk this unit right now. */
  canMove(u: Unit): boolean {
    if (!u.alive || u.forced) return false;
    const locks = u.combatant.cc.locks();
    return !locks.move && !locks.forcedMovement;
  }

  /** Arena meters per second. */
  moveSpeed(u: Unit): number {
    return worldSpeed(u.combatant.moveSpeed);
  }

  // -------------------------------------------------------------------------
  // Actions

  /** Fire a basic attack along the unit's aim. Returns false if it was not ready. */
  basic(u: Unit): boolean {
    if (u.forced) return false;
    const shot = u.combatant.startBasic(this.rng);
    if (!shot) return false;
    this.interruptRecall(u);
    u.stealth = 0;
    u.sinceAction = 0;
    const def = u.combatant.god.basicAttack;
    const dir = this.aimDir(u);
    const range = def.range * WORLD_SCALE;
    if (def.projectileSpeed === undefined) {
      this.events.push({ type: 'basic', unit: u, melee: true });
      for (const t of this.enemiesOf(u)) {
        const d = Math.hypot(t.x - u.x, t.z - u.z);
        if (d > range + t.radius) continue;
        if (d > t.radius && angleBetween(dir, { x: t.x - u.x, z: t.z - u.z }) > MELEE_ARC / 2) continue;
        this.landBasic(u, t, shot);
      }
    } else {
      this.events.push({ type: 'basic', unit: u, melee: false });
      this.spawnProjectile(u, dir, null, shot, def.projectileSpeed * WORLD_SCALE, range, 0.45, false, 0);
    }
    return true;
  }

  /** Cast the skill in `slot` toward the unit's aim point. */
  cast(u: Unit, slot: number): CastResult {
    if (u.forced) return 'forced';
    const r = u.combatant.cast(slot);
    if (!r.ok) return r.error;
    this.interruptRecall(u);
    u.sinceAction = 0;
    const grantsStealth = r.cast.hits.some((e) => e.kind === 'stealth');
    if (!grantsStealth) u.stealth = 0;
    this.execute(u, r.cast);
    return null;
  }

  startRecall(u: Unit): boolean {
    if (!u.alive || u.recall > 0 || this.inBase(u)) return false;
    u.recall = RECALL_TIME;
    this.events.push({ type: 'recall', unit: u, state: 'start' });
    return true;
  }

  interruptRecall(u: Unit): void {
    if (u.recall <= 0) return;
    u.recall = 0;
    this.events.push({ type: 'recall', unit: u, state: 'cancel' });
  }

  /** Where a cast aimed at the unit's aim point would land, clamped to `range`. */
  aimPoint(u: Unit, range: number): Point {
    const dx = u.aim.x - u.x;
    const dz = u.aim.z - u.z;
    const d = Math.hypot(dx, dz);
    if (d <= range) return { x: u.aim.x, z: u.aim.z };
    return { x: u.x + (dx / d) * range, z: u.z + (dz / d) * range };
  }

  /** Unit vector from the unit toward its aim, or its facing when aiming at its feet. */
  aimDir(u: Unit): Point {
    const dx = u.aim.x - u.x;
    const dz = u.aim.z - u.z;
    const d = Math.hypot(dx, dz);
    return d > 0.5 ? { x: dx / d, z: dz / d } : u.forward;
  }

  private execute(u: Unit, cast: ResolvedSkill): void {
    const t = cast.targeting;
    const range = (r: number) => r * WORLD_SCALE * cast.rangeScale;
    const radius = (r: number) => r * WORLD_SCALE * cast.radiusScale;
    const dir = this.aimDir(u);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const movement = cast.hits.find((e) => e.kind === 'movement');
    const ticking = cast.hits.find((e) => e.kind === 'damage' && e.hits > 1 && e.interval > 0);

    for (const e of cast.hits) {
      if (e.kind === 'stealth') u.stealth = Math.max(u.stealth, e.duration);
    }

    let at: Point = { x: u.x, z: u.z };
    switch (t.type) {
      case 'projectile': {
        const bounces = (t.bounces === undefined ? 0 : ranked(t.bounces, cast.rank)) + cast.extraBounces;
        this.spawnProjectile(u, dir, cast, null, t.speed * WORLD_SCALE, range(t.range), radius(t.radius), !!t.pierce, bounces);
        this.applySelf(u, cast);
        at = { x: u.x + dir.x * range(t.range), z: u.z + dir.z * range(t.range) };
        break;
      }
      case 'line': {
        const len = range(t.range);
        const w = radius(t.width);
        for (const target of this.unitsInLine(u, u.x, u.z, dir, len, w / 2)) this.hit(u, cast, target);
        this.applySelf(u, cast);
        this.flash(u, { type: 'line', x: u.x, z: u.z, yaw, length: len, width: w });
        at = { x: u.x + dir.x * len, z: u.z + dir.z * len };
        break;
      }
      case 'cone': {
        const r = range(t.range);
        for (const target of this.enemiesOf(u)) {
          const dx = target.x - u.x;
          const dz = target.z - u.z;
          if (Math.hypot(dx, dz) > r + target.radius) continue;
          if (angleBetween(dir, { x: dx, z: dz }) > t.angle / 2) continue;
          this.hit(u, cast, target);
        }
        this.applySelf(u, cast);
        this.flash(u, { type: 'cone', x: u.x, z: u.z, yaw, range: r, angle: t.angle });
        break;
      }
      case 'ground': {
        at = this.aimPoint(u, range(t.range));
        const r = radius(t.radius);
        if (ticking && ticking.kind === 'damage') {
          const followAim = movement?.kind === 'movement' && movement.style === 'leap' && movement.distance === 0;
          this.spawnZone(u, cast, at, r, ticking.hits, ticking.interval, followAim ? 'aim' : null, range(t.range));
          if (followAim) u.untargetable = ticking.hits * ticking.interval;
        } else {
          this.area(u, cast, at, r);
          this.flash(u, { type: 'circle', x: at.x, z: at.z, radius: r });
        }
        break;
      }
      case 'self': {
        if (t.radius === undefined) {
          this.hit(u, cast, u);
          break;
        }
        const r = radius(t.radius);
        if (ticking && ticking.kind === 'damage') {
          this.spawnZone(u, cast, at, r, ticking.hits, ticking.interval, 'caster', 0);
        } else {
          this.area(u, cast, at, r);
          this.flash(u, { type: 'circle', x: u.x, z: u.z, radius: r });
        }
        break;
      }
      case 'dash': {
        const dist = t.distance * WORLD_SCALE * cast.rangeScale;
        const width = radius(t.width);
        this.applySelf(u, cast);
        if (movement?.kind === 'movement' && movement.style === 'blink') {
          const end = this.sweepEnd(u, dir, dist);
          const len = Math.hypot(end.x - u.x, end.z - u.z);
          for (const target of this.unitsInLine(u, u.x, u.z, dir, len, width / 2)) this.hit(u, cast, target);
          this.flash(u, { type: 'line', x: u.x, z: u.z, yaw, length: len, width });
          this.teleport(u, end.x, end.z);
          at = end;
        } else {
          const time = dist / DASH_SPEED;
          u.forced = {
            vx: dir.x * DASH_SPEED,
            vz: dir.z * DASH_SPEED,
            remaining: time,
            total: time,
            arc: 0,
            collide: true,
            sweep: { cast, width, hit: new Set() },
          };
          at = { x: u.x + dir.x * dist, z: u.z + dir.z * dist };
        }
        break;
      }
      case 'leap': {
        at = this.aimPoint(u, range(t.range));
        const r = radius(t.radius);
        const d = Math.hypot(at.x - u.x, at.z - u.z);
        const time = Math.min(1.1, Math.max(0.45, d / LEAP_SPEED));
        u.forced = {
          vx: (at.x - u.x) / time,
          vz: (at.z - u.z) / time,
          remaining: time,
          total: time,
          arc: Math.min(6, 1.2 + d * 0.12),
          collide: false,
          land: () => {
            this.area(u, cast, { x: u.x, z: u.z }, r);
            this.flash(u, { type: 'circle', x: u.x, z: u.z, radius: r });
            this.events.push({ type: 'impact', x: u.x, z: u.z, owner: u, big: true });
          },
        };
        break;
      }
      case 'ally': {
        const r = range(t.range);
        let best: Unit = u;
        let bestAngle = 35;
        for (const a of this.units) {
          if (a === u || a.team !== u.team || !a.alive || a.kind === 'dummy') continue;
          const dx = a.x - u.x;
          const dz = a.z - u.z;
          if (Math.hypot(dx, dz) > r) continue;
          const ang = angleBetween(dir, { x: dx, z: dz });
          if (ang < bestAngle) {
            best = a;
            bestAngle = ang;
          }
        }
        this.hit(u, cast, best);
        if (best !== u) this.applySelf(u, cast);
        at = { x: best.x, z: best.z };
        break;
      }
    }

    for (const e of cast.hits) {
      if (e.kind !== 'summon') continue;
      const where = t.type === 'ground' ? at : { x: u.x, z: u.z };
      this.summon(u, e.unit, e.duration, where);
    }
    this.events.push({ type: 'cast', unit: u, cast, x: at.x, z: at.z });
  }

  // -------------------------------------------------------------------------
  // Hit resolution

  /** Apply a skill to one unit, schedule its extra hits, and report what happened. */
  hit(owner: Unit, cast: ResolvedSkill, target: Unit): void {
    if (target !== owner && !target.targetable) return;
    this.applyOnce(owner, cast, target);
    // Multi-hit skills that are not areas strike the same target again over time.
    for (const e of cast.hits) {
      if (e.kind !== 'damage' || e.hits <= 1 || target.team === owner.team) continue;
      for (let i = 1; i < e.hits; i++) this.pending.push({ at: this.time + e.interval * i, owner, cast, target });
      break;
    }
  }

  private applyOnce(owner: Unit, cast: ResolvedSkill, target: Unit): void {
    const c = target.combatant;
    const before = c.health + c.shieldTotal;
    const wasAlive = c.alive;
    const credit = owner.owner ?? owner;
    const levelBefore = credit.combatant.level;
    owner.combatant.applySkillTo(cast, c);
    this.report(owner, target, before, wasAlive, false, true);
    if (target.team !== owner.team && c.alive) this.applyMovementCC(owner, cast, target);
    if (target.team !== owner.team) {
      for (const e of cast.hits) {
        if (e.kind !== 'mark') continue;
        const m = target.marks.get(e.mark) ?? { stacks: 0, remaining: 0 };
        m.stacks = Math.min(3, m.stacks + (e.stacks ?? 1));
        m.remaining = e.duration;
        target.marks.set(e.mark, m);
      }
    }
    this.checkLevel(credit, levelBefore);
  }

  private landBasic(u: Unit, target: Unit, shot: BasicShot): void {
    const c = target.combatant;
    const before = c.health + c.shieldTotal;
    const wasAlive = c.alive;
    const credit = u.owner ?? u;
    const levelBefore = credit.combatant.level;
    const r = u.combatant.landBasic(c, shot);
    if (!r) return;
    this.report(u, target, before, wasAlive, r.crit, false);
    this.checkLevel(credit, levelBefore);
  }

  private report(source: Unit, target: Unit, before: number, wasAlive: boolean, crit: boolean, ability: boolean): void {
    const c = target.combatant;
    const delta = before - (c.health + c.shieldTotal);
    if (delta > 0.05) {
      this.events.push({ type: 'damage', target, source, amount: delta, crit, ability });
      this.interruptRecall(target);
    } else if (delta < -0.05) {
      this.events.push({ type: 'heal', target, amount: -delta });
    }
    if (wasAlive && !c.alive) this.onDeath(target, source);
  }

  private applySelf(u: Unit, cast: ResolvedSkill): void {
    const selfish = cast.hits.some(
      (e) => (e.kind === 'heal' || e.kind === 'shield' || e.kind === 'buff') && e.target !== 'enemies' && e.target !== 'allies',
    );
    if (selfish) this.applyOnce(u, cast, u);
  }

  /** Everything in a circle (the engine filters effects by team), then the caster's own buffs. */
  private area(owner: Unit, cast: ResolvedSkill, at: Point, r: number): void {
    for (const t of [...this.units]) {
      if (!t.alive || t === owner) continue;
      if (Math.hypot(t.x - at.x, t.z - at.z) > r + t.radius) continue;
      if (t.team === owner.team && !touchesAllies(cast)) continue;
      this.hit(owner, cast, t);
    }
    this.applySelf(owner, cast);
  }

  private applyMovementCC(owner: Unit, cast: ResolvedSkill, target: Unit): void {
    for (const e of cast.hits) {
      if (e.kind !== 'cc') continue;
      if (!target.combatant.cc.has(e.cc)) continue;
      const dx = target.x - owner.x;
      const dz = target.z - owner.z;
      const d = Math.hypot(dx, dz) || 1;
      if (e.cc === 'knockback') {
        const time = 0.3;
        const dist = 3.5;
        target.forced = { vx: (dx / d) * (dist / time), vz: (dz / d) * (dist / time), remaining: time, total: time, arc: 0.6, collide: true };
      } else if (e.cc === 'pull' || e.cc === 'grab') {
        const time = 0.3;
        const dist = Math.max(0, d - (owner.radius + target.radius + 0.6));
        target.forced = { vx: (-dx / d) * (dist / time), vz: (-dz / d) * (dist / time), remaining: time, total: time, arc: 0.3, collide: true };
      } else if (e.cc === 'knockup') {
        const time = Math.max(0.4, e.duration);
        target.forced = { vx: 0, vz: 0, remaining: time, total: time, arc: 1.6, collide: true };
      }
    }
  }

  private onDeath(victim: Unit, source: Unit | null): void {
    const killer = source?.owner ?? source;
    this.events.push({ type: 'death', unit: victim, killer });
    victim.forced = null;
    victim.recall = 0;
    victim.marks.clear();
    for (const z of this.zones) if (z.owner === victim && z.follow) z.ticks = 0;
    if (!killer || killer.team === victim.team || victim.kind === 'summon') return;
    const xp = victim.kind === 'god' ? 120 + 30 * victim.combatant.level : 90;
    const favor = victim.kind === 'god' ? 25 : 8;
    const before = killer.combatant.level;
    killer.combatant.gainXp(xp);
    killer.combatant.gainFavor(favor);
    this.events.push({ type: 'reward', unit: killer, xp, favor });
    this.checkLevel(killer, before);
  }

  private checkLevel(u: Unit, before: number): void {
    const now = u.combatant.level;
    if (now > before) this.events.push({ type: 'levelUp', unit: u, level: now });
  }

  // -------------------------------------------------------------------------
  // Spawning

  private spawnProjectile(
    owner: Unit,
    dir: Point,
    cast: ResolvedSkill | null,
    shot: BasicShot | null,
    speed: number,
    range: number,
    radius: number,
    pierce: boolean,
    bounces: number,
  ): void {
    const start = owner.radius * 0.8;
    this.projectiles.push({
      id: nextEntityId(),
      owner,
      cast,
      shot,
      x: owner.x + dir.x * start,
      z: owner.z + dir.z * start,
      dx: dir.x,
      dz: dir.z,
      speed,
      traveled: 0,
      range,
      radius,
      pierce,
      bounces,
      hit: new Set(),
      alive: true,
    });
  }

  private spawnZone(
    owner: Unit,
    cast: ResolvedSkill,
    at: Point,
    radius: number,
    ticks: number,
    interval: number,
    follow: Zone['follow'],
    range: number,
  ): void {
    this.zones.push({
      id: nextEntityId(),
      owner,
      cast,
      x: at.x,
      z: at.z,
      radius,
      ticks,
      interval,
      timer: 0,
      follow,
      range,
      age: 0,
      duration: ticks * interval,
    });
  }

  private flash(owner: Unit, shape: FlashShape): void {
    this.flashes.push({ id: nextEntityId(), shape, owner, age: 0, life: 0.45 });
  }

  /** Set by the game to build summoned units; without it summons are skipped. */
  summonFactory: ((owner: Unit, kind: string, at: Point, index: number) => Unit) | null = null;

  private summon(owner: Unit, kind: string, duration: number, at: Point): void {
    if (!this.summonFactory) return;
    const count = kind === 'einherjar' || kind === 'mirror-copy' ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const s = this.summonFactory(owner, kind, at, i);
      s.owner = owner;
      s.lifetime = duration;
      this.add(s);
    }
  }

  teleport(u: Unit, x: number, z: number, yaw?: number): void {
    const fromX = u.x;
    const fromZ = u.z;
    if (u.body.teleport) u.body.teleport(x, z, yaw);
    else {
      u.body.x = x;
      u.body.z = z;
      if (yaw !== undefined) u.body.yaw = yaw;
    }
    u.body.y = this.terrain.groundAt(x, z);
    this.events.push({ type: 'teleport', unit: u, fromX, fromZ });
  }

  // -------------------------------------------------------------------------
  // Queries

  enemiesOf(u: Unit): Unit[] {
    return this.units.filter((t) => t.team !== u.team && t.targetable);
  }

  /** Enemies whose circle touches the segment from (x, z) along dir. */
  private unitsInLine(owner: Unit, x: number, z: number, dir: Point, length: number, halfWidth: number): Unit[] {
    return this.units.filter((t) => {
      if (!t.targetable || t.team === owner.team) return false;
      const px = t.x - x;
      const pz = t.z - z;
      const along = px * dir.x + pz * dir.z;
      if (along < -t.radius || along > length + t.radius) return false;
      const side = Math.abs(px * dir.z - pz * dir.x);
      return side <= halfWidth + t.radius;
    });
  }

  /** How far a blink can go before a wall stops it. */
  private sweepEnd(u: Unit, dir: Point, dist: number): Point {
    let x = u.x;
    let z = u.z;
    const steps = Math.ceil(dist / 0.5);
    for (let i = 1; i <= steps; i++) {
      const nx = u.x + dir.x * (dist * i) / steps;
      const nz = u.z + dir.z * (dist * i) / steps;
      const r = this.terrain.resolve(nx, nz, u.radius, this.terrain.groundAt(nx, nz));
      if (Math.hypot(r.x - nx, r.z - nz) > 0.05) break;
      x = nx;
      z = nz;
    }
    return { x, z };
  }

  // -------------------------------------------------------------------------
  // Tick

  step(dt: number): void {
    this.time += dt;
    for (const u of [...this.units]) this.stepUnit(u, dt);
    this.stepProjectiles(dt);
    this.stepZones(dt);
    this.stepPending();
    for (const f of this.flashes) f.age += dt;
    removeWhere(this.flashes, (f) => f.age >= f.life);
  }

  private stepUnit(u: Unit, dt: number): void {
    const c = u.combatant;
    const startX = u.x;
    const startZ = u.z;
    c.update(dt);
    u.sinceAction += dt;

    if (u.lifetime !== Infinity) {
      u.lifetime -= dt;
      if (u.lifetime <= 0 || !u.alive) {
        this.remove(u);
        return;
      }
    }
    if (!u.wasAlive && u.alive) {
      this.teleport(u, u.home.x, u.home.z, u.home.yaw);
      this.events.push({ type: 'respawn', unit: u });
    }
    u.wasAlive = u.alive;
    if (!u.alive) {
      u.vx = u.vz = 0;
      return;
    }

    u.stealth = Math.max(0, u.stealth - dt);
    u.untargetable = Math.max(0, u.untargetable - dt);
    for (const [k, m] of u.marks) {
      m.remaining -= dt;
      if (m.remaining <= 0) u.marks.delete(k);
    }

    if (u.brain) u.brain.update(dt);

    if (u.forced) this.stepForced(u, dt);
    else if (c.cc.locks().forcedMovement) this.stepFearTaunt(u, dt);
    else if (u.move && this.canMove(u)) this.walk(u, u.move.x, u.move.z, this.moveSpeed(u) * dt);

    const moved = Math.hypot(u.x - startX, u.z - startZ);
    u.vx = (u.x - startX) / dt;
    u.vz = (u.z - startZ) / dt;
    if (u.recall > 0) {
      if (moved > 0.02) this.interruptRecall(u);
      else {
        u.recall -= dt;
        if (u.recall <= 0) {
          u.recall = 0;
          this.teleport(u, u.home.x, u.home.z, u.home.yaw);
          this.events.push({ type: 'recall', unit: u, state: 'done' });
        }
      }
    }
    c.inBase = this.inBase(u);
  }

  private walk(u: Unit, dx: number, dz: number, dist: number): void {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const nx = u.x + (dx / len) * dist;
    const nz = u.z + (dz / len) * dist;
    const r = this.terrain.resolve(nx, nz, u.radius, u.body.y);
    u.body.x = r.x;
    u.body.z = r.z;
    u.body.y = this.terrain.groundAt(r.x, r.z);
  }

  private stepForced(u: Unit, dt: number): void {
    const f = u.forced!;
    const step = Math.min(dt, f.remaining);
    f.remaining -= step;
    let nx = u.x + f.vx * step;
    let nz = u.z + f.vz * step;
    if (f.collide) {
      const r = this.terrain.resolve(nx, nz, u.radius, u.body.y);
      nx = r.x;
      nz = r.z;
    }
    u.body.x = nx;
    u.body.z = nz;
    const p = 1 - f.remaining / f.total;
    u.body.y = this.terrain.groundAt(nx, nz) + Math.sin(Math.PI * p) * f.arc;
    if (f.sweep) {
      for (const t of this.enemiesOf(u)) {
        if (f.sweep.hit.has(t)) continue;
        if (Math.hypot(t.x - nx, t.z - nz) > f.sweep.width / 2 + t.radius + u.radius) continue;
        f.sweep.hit.add(t);
        this.hit(u, f.sweep.cast, t);
      }
    }
    if (f.remaining <= 0) {
      u.forced = null;
      u.body.y = this.terrain.groundAt(nx, nz);
      if (u.body.teleport && !f.collide) u.body.teleport(nx, nz);
      f.land?.();
    }
  }

  private stepFearTaunt(u: Unit, dt: number): void {
    const entry = u.combatant.cc.active.find((c) => c.kind === 'taunt' || c.kind === 'fear');
    const uid = entry?.source ? Number(entry.source.split(':')[0]) : NaN;
    const src = this.unitByCombatantUid(uid);
    if (!entry || !src) return;
    const sign = entry.kind === 'fear' ? -1 : 1;
    const dx = (src.x - u.x) * sign;
    const dz = (src.z - u.z) * sign;
    if (entry.kind === 'taunt' && Math.hypot(dx, dz) < u.radius + src.radius + 1) return;
    this.walk(u, dx, dz, this.moveSpeed(u) * dt);
    u.body.yaw = Math.atan2(-(src.x - u.x), -(src.z - u.z));
  }

  private stepProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      const step = p.speed * dt;
      const sub = Math.max(1, Math.ceil(step / 0.6));
      for (let i = 0; i < sub && p.alive; i++) {
        const s = step / sub;
        p.x += p.dx * s;
        p.z += p.dz * s;
        p.traveled += s;
        this.projectileHits(p);
        if (p.traveled >= p.range) p.alive = false;
        else if (this.blocked(p.x, p.z)) {
          p.alive = false;
          this.events.push({ type: 'impact', x: p.x, z: p.z, owner: p.owner, big: false });
        }
      }
    }
    removeWhere(this.projectiles, (p) => !p.alive);
  }

  private projectileHits(p: Projectile): void {
    for (const t of this.units) {
      if (!p.alive) return;
      if (t.team === p.owner.team || !t.targetable || p.hit.has(t)) continue;
      if (Math.hypot(t.x - p.x, t.z - p.z) > p.radius + t.radius) continue;
      p.hit.add(t);
      this.events.push({ type: 'impact', x: p.x, z: p.z, owner: p.owner, big: !!p.cast });
      if (p.shot) this.landBasic(p.owner, t, p.shot);
      if (p.cast) {
        this.hit(p.owner, p.cast, t);
        const blink = p.cast.hits.find((e) => e.kind === 'movement' && e.style === 'blink');
        if (blink && p.owner.alive) {
          // reappear behind the target, facing it
          const bx = t.x + p.dx * (t.radius + p.owner.radius + 0.4);
          const bz = t.z + p.dz * (t.radius + p.owner.radius + 0.4);
          this.teleport(p.owner, bx, bz, Math.atan2(p.dx, p.dz));
        }
      }
      if (p.bounces > 0) {
        const next = this.nearestEnemy(p, t);
        if (next) {
          p.bounces--;
          const dx = next.x - p.x;
          const dz = next.z - p.z;
          const d = Math.hypot(dx, dz);
          p.dx = dx / d;
          p.dz = dz / d;
          p.traveled = Math.max(0, p.range - BOUNCE_RANGE - 2);
          continue;
        }
      }
      if (!p.pierce) p.alive = false;
    }
  }

  private nearestEnemy(p: Projectile, from: Unit): Unit | null {
    let best: Unit | null = null;
    let bestD = BOUNCE_RANGE;
    for (const t of this.units) {
      if (t.team === p.owner.team || !t.targetable || p.hit.has(t)) continue;
      const d = Math.hypot(t.x - from.x, t.z - from.z);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  private blocked(x: number, z: number): boolean {
    const ground = this.terrain.groundAt(x, z);
    const r = this.terrain.resolve(x, z, 0.1, ground + PROJECTILE_HEIGHT - 0.55);
    return Math.hypot(r.x - x, r.z - z) > 0.01;
  }

  private stepZones(dt: number): void {
    for (const zn of this.zones) {
      zn.age += dt;
      const o = zn.owner;
      if (zn.follow === 'caster') {
        zn.x = o.x;
        zn.z = o.z;
      } else if (zn.follow === 'aim') {
        const goal = this.aimPoint(o, zn.range);
        const dx = goal.x - zn.x;
        const dz = goal.z - zn.z;
        const d = Math.hypot(dx, dz);
        const maxStep = 14 * dt;
        if (d > maxStep) {
          zn.x += (dx / d) * maxStep;
          zn.z += (dz / d) * maxStep;
        } else {
          zn.x = goal.x;
          zn.z = goal.z;
        }
      }
      zn.timer -= dt;
      while (zn.timer <= 0 && zn.ticks > 0) {
        zn.ticks--;
        zn.timer += zn.interval;
        for (const t of [...this.units]) {
          if (!t.alive || Math.hypot(t.x - zn.x, t.z - zn.z) > zn.radius + t.radius) continue;
          if (t.team === o.team && t !== o && !touchesAllies(zn.cast)) continue;
          if (t !== o && !t.targetable) continue;
          this.applyOnce(o, zn.cast, t);
        }
        this.events.push({ type: 'impact', x: zn.x, z: zn.z, owner: o, big: false });
      }
    }
    removeWhere(this.zones, (z) => z.ticks <= 0 && z.timer <= -0.4);
  }

  private stepPending(): void {
    const due = this.pending.filter((p) => p.at <= this.time);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.at > this.time);
    for (const p of due) if (p.target.targetable) this.applyOnce(p.owner, p.cast, p.target);
  }
}

/** Angle in degrees between two XZ vectors. */
export function angleBetween(a: Point, b: Point): number {
  const la = Math.hypot(a.x, a.z);
  const lb = Math.hypot(b.x, b.z);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const c = (a.x * b.x + a.z * b.z) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

function touchesAllies(cast: ResolvedSkill): boolean {
  return cast.hits.some(
    (e) => (e.kind === 'heal' || e.kind === 'shield' || e.kind === 'buff') && (e.target === 'allies' || e.target === 'alliesAndSelf'),
  );
}

function removeWhere<T>(list: T[], pred: (t: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) list.splice(i, 1);
}
