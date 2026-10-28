import { alongPolyline, nearestOnPolyline, type Vec2 } from '../map/ConquestLayout';
import type { Sim } from './Sim';
import { isStructure, WORLD_SCALE, type Brain, type Unit } from './Unit';

/** How far a minion notices enemies. */
export const MINION_AGGRO = 9;
/** Seconds after an enemy god hits an allied god that structures and minions switch to it. */
export const GOD_AGGRO_WINDOW = 1.6;
/** Towers hit a god harder with every consecutive shot, up to this multiplier. */
const TOWER_MAX_RAMP = 2.2;
const TOWER_RAMP_STEP = 0.3;

/** Reach of a unit's basic attack against a target, arena meters. */
export function attackReach(u: Unit, t: Unit): number {
  return u.combatant.god.basicAttack.range * WORLD_SCALE + u.radius + t.radius;
}

/** An enemy god that just hurt one of `u`'s allied gods within `range` of `u`. */
function godAggressor(sim: Sim, u: Unit, range: number): Unit | null {
  for (const g of sim.enemiesOf(u)) {
    if (g.kind !== 'god' || !g.lastGodHit) continue;
    if (sim.time - g.lastGodHit.at > GOD_AGGRO_WINDOW) continue;
    const v = g.lastGodHit.victim;
    if (v.team !== u.team) continue;
    if (Math.hypot(g.x - u.x, g.z - u.z) > range) continue;
    if (Math.hypot(v.x - u.x, v.z - u.z) > range) continue;
    return g;
  }
  return null;
}

/**
 * Lane minions walk their lane toward the enemy base and fight what they
 * meet: enemy minions first, then structures, then gods, but they switch to a
 * god who attacks one of their gods nearby (Smite's minion aggro).
 */
export class MinionBrain implements Brain {
  private think = 0;
  private target: Unit | null = null;

  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
    private readonly path: readonly Vec2[],
    /** Sideways offset from the lane centerline so a wave walks as a group. */
    private readonly lateral: number,
  ) {}

  update(dt: number): void {
    const { u, sim } = this;
    u.move = null;
    if (!u.alive || u.forced) return;
    this.think -= dt;
    if (this.think <= 0 || (this.target && !this.valid(this.target))) {
      this.think = 0.25;
      this.target = this.choose();
    }
    const t = this.target;
    if (t) {
      const dx = t.x - u.x;
      const dz = t.z - u.z;
      const d = Math.hypot(dx, dz);
      u.body.yaw = Math.atan2(-dx, -dz);
      u.aim.x = t.x;
      u.aim.z = t.z;
      const reach = attackReach(u, t);
      if (d > reach * 0.9) u.move = this.separate(dx / d, dz / d);
      if (d <= reach) {
        const ranged = u.combatant.god.basicAttack.projectileSpeed !== undefined;
        sim.basic(u, ranged ? { homing: t } : {});
      }
      return;
    }
    // walk the lane
    const here = nearestOnPolyline(this.path, u.x, u.z);
    const ahead = alongPolyline(this.path, here.along + 5);
    const next = alongPolyline(this.path, here.along + 6);
    const tx = next[0] - ahead[0];
    const tz = next[1] - ahead[1];
    const tl = Math.hypot(tx, tz) || 1;
    // offset to the side of the walking direction
    const gx = ahead[0] + (-tz / tl) * this.lateral;
    const gz = ahead[1] + (tx / tl) * this.lateral;
    const dx = gx - u.x;
    const dz = gz - u.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3) return;
    u.move = this.separate(dx / d, dz / d);
    u.body.yaw = Math.atan2(-u.move.x, -u.move.z);
  }

  private valid(t: Unit): boolean {
    if (!t.targetable || t.stealth > 0) return false;
    if (isStructure(t) && t.shielded()) return false;
    return Math.hypot(t.x - this.u.x, t.z - this.u.z) <= MINION_AGGRO + t.radius + 2;
  }

  private choose(): Unit | null {
    const { u, sim } = this;
    const aggressor = godAggressor(sim, u, MINION_AGGRO);
    if (aggressor) return aggressor;
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (const t of sim.enemiesOf(u)) {
      if (t.kind === 'dummy' || t.kind === 'summon' || t.stealth > 0) continue;
      if (isStructure(t) && t.shielded()) continue;
      const d = Math.hypot(t.x - u.x, t.z - u.z) - t.radius;
      if (d > MINION_AGGRO) continue;
      // keep fighting what we fight; otherwise minions, then structures, then gods
      const priority = t === this.target ? -1 : t.kind === 'minion' ? 0 : isStructure(t) ? 1 : 2;
      const score = priority * 100 + d;
      if (score < bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best;
  }

  /** Steer away from allied minions that are too close so a wave spreads out. */
  private separate(x: number, z: number): { x: number; z: number } {
    const { u, sim } = this;
    let sx = 0;
    let sz = 0;
    for (const o of sim.units) {
      if (o === u || o.kind !== 'minion' || !o.alive || o.team !== u.team) continue;
      const dx = u.x - o.x;
      const dz = u.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = u.radius + o.radius + 0.4;
      if (d > 0.001 && d < min) {
        sx += (dx / d) * (min - d);
        sz += (dz / d) * (min - d);
      }
    }
    const mx = x + sx * 1.5;
    const mz = z + sz * 1.5;
    const l = Math.hypot(mx, mz) || 1;
    return { x: mx / l, z: mz / l };
  }
}

/**
 * Towers, Phoenixes and the Titan. They shoot the nearest enemy minion in
 * range and keep shooting it until it dies or leaves; with no minions they
 * shoot gods. An enemy god who hurts an allied god in range draws their fire
 * at once. Each consecutive shot at the same god hits harder.
 */
export class StructureBrain implements Brain {
  private target: Unit | null = null;
  private ramp = 1;
  private think = 0;

  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
  ) {}

  /** Arena meters from the structure's center. */
  get range(): number {
    return this.u.combatant.god.basicAttack.range * WORLD_SCALE;
  }

  update(dt: number): void {
    const { u, sim } = this;
    u.move = null;
    if (!u.alive) {
      this.target = null;
      return;
    }
    // look around ten times a second; between looks only shoot when ready
    this.think -= dt;
    if (this.think > 0 && (!this.target || this.target.targetable) && !u.combatant.basicReady) return;
    this.think = 0.1;
    const aggressor = godAggressor(sim, u, this.range);
    if (aggressor && aggressor !== this.target) this.switchTo(aggressor);
    if (this.target && !this.inRange(this.target)) this.target = null;
    if (!this.target) this.switchTo(this.choose());
    const t = this.target;
    if (!t) return;
    u.aim.x = t.x;
    u.aim.z = t.z;
    const fired = sim.basic(u, { homing: t, scale: t.kind === 'god' ? this.ramp : 1 });
    if (fired && t.kind === 'god') this.ramp = Math.min(TOWER_MAX_RAMP, this.ramp + TOWER_RAMP_STEP);
  }

  /** What the structure is shooting, for the view's targeting beam. */
  get current(): Unit | null {
    return this.target;
  }

  private switchTo(t: Unit | null): void {
    if (t !== this.target) this.ramp = 1;
    this.target = t;
  }

  private inRange(t: Unit): boolean {
    return t.targetable && Math.hypot(t.x - this.u.x, t.z - this.u.z) <= this.range + t.radius;
  }

  private choose(): Unit | null {
    let minion: Unit | null = null;
    let god: Unit | null = null;
    let md = Infinity;
    let gd = Infinity;
    for (const t of this.sim.enemiesOf(this.u)) {
      if (!this.inRange(t)) continue;
      const d = Math.hypot(t.x - this.u.x, t.z - this.u.z);
      if (t.kind === 'minion' || t.kind === 'summon') {
        if (d < md) {
          minion = t;
          md = d;
        }
      } else if (t.kind === 'god' && d < gd) {
        god = t;
        gd = d;
      }
    }
    return minion ?? god;
  }
}
