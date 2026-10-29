import { ULTIMATE_SLOT } from '../game/loadout';
import type { Sim } from './Sim';
import { WORLD_SCALE, type Brain, type Point, type Unit } from './Unit';

export interface BotOptions {
  /** Where the bot holds ground when it has nothing to fight. */
  anchor: Point;
  /** How far from the anchor it will chase. */
  leash: number;
  /** How close an enemy must come before the bot engages. */
  aggro: number;
  /** Chance per decision (about 3 a second) to use a ready skill. */
  aggression: number;
  /** Replaces the default "nearest enemy near the anchor" target choice. */
  choose?: () => Unit | null;
  /** Next waypoint toward a goal, for maps with walls between lanes. */
  route?: (goal: Point) => Point;
  /** Channel a recall when low and nobody is close, instead of walking home. */
  recall?: boolean;
}

/**
 * A simple god bot: holds a position, engages enemies that come close, keeps
 * its preferred range, strafes, basic attacks, and casts skills whose reach
 * covers the target. Retreats to base when low and heals at the fountain.
 */
export class GodBot implements Brain {
  private decide = 0;
  private strafe = 1;
  private strafeTimer = 0;
  private retreating = false;

  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
    readonly options: BotOptions,
  ) {}

  update(dt: number): void {
    const { u, sim } = this;
    u.move = null;
    if (!u.alive || u.forced) return;
    const c = u.combatant;
    const hp = c.health / c.stats.maxHealth;

    if (hp < 0.25) this.retreating = true;
    if (this.retreating) {
      if (hp > 0.95 || c.inBase && hp > 0.9) this.retreating = false;
      else {
        if (u.recall > 0) return;
        const threat = sim.enemiesOf(u).some((t) => (t.kind === 'god' || t.kind === 'minion') && Math.hypot(t.x - u.x, t.z - u.z) < 15);
        if (this.options.recall && !threat && !c.inBase && sim.startRecall(u)) return;
        this.moveToward(u.home, 1.5);
        return;
      }
    }
    if (u.recall > 0) return;

    const target = this.options.choose ? this.options.choose() : this.pickTarget();
    if (!target) {
      this.moveToward(this.options.anchor, 3);
      return;
    }

    const dx = target.x - u.x;
    const dz = target.z - u.z;
    const dist = Math.hypot(dx, dz);
    u.body.yaw = Math.atan2(-dx, -dz);
    // lead moving targets a little, like a player would
    const lead = Math.min(0.5, dist / 40);
    u.aim.x = target.x + target.vx * lead;
    u.aim.z = target.z + target.vz * lead;

    const basic = c.god.basicAttack;
    const melee = basic.projectileSpeed === undefined;
    const reach = basic.range * WORLD_SCALE + target.radius;
    const desired = melee ? u.radius + target.radius + 0.8 : reach * 0.8;
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafe = sim.rng() < 0.5 ? -1 : 1;
      this.strafeTimer = 0.8 + sim.rng() * 1.4;
    }
    if (dist > desired) u.move = { x: dx / dist, z: dz / dist };
    else if (!melee) u.move = { x: (-dz / dist) * this.strafe, z: (dx / dist) * this.strafe };

    if (dist <= reach) sim.basic(u);

    this.decide -= dt;
    if (this.decide <= 0) {
      this.decide = 0.3;
      // skills are for gods; on minions only now and then, with mana to spare
      const chance = target.kind === 'god' ? this.options.aggression : target.kind === 'minion' && c.mana > c.stats.maxMana * 0.5 ? this.options.aggression * 0.3 : 0;
      if (sim.rng() < chance) this.tryCast(dist, target);
    }
  }

  private pickTarget(): Unit | null {
    const { u, sim, options } = this;
    let best: Unit | null = null;
    let bestD = options.aggro;
    for (const t of sim.enemiesOf(u)) {
      if (t.kind === 'dummy' || t.stealth > 0) continue;
      if (Math.hypot(t.x - options.anchor.x, t.z - options.anchor.z) > options.leash) continue;
      const d = Math.hypot(t.x - u.x, t.z - u.z);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  private tryCast(dist: number, target: Unit): void {
    const { u, sim } = this;
    const c = u.combatant;
    const slots = [0, 1, 2, 3, ULTIMATE_SLOT].filter((s) => c.canCast(s) === null && reachOf(u, s) + target.radius >= dist);
    if (!slots.length) return;
    const targetHp = target.combatant.health / target.combatant.stats.maxHealth;
    const ult = slots.includes(ULTIMATE_SLOT) && targetHp < 0.6 ? ULTIMATE_SLOT : undefined;
    const regular = slots.filter((s) => s !== ULTIMATE_SLOT);
    const slot = ult ?? regular[Math.floor(sim.rng() * regular.length)] ?? slots[0]!;
    sim.cast(u, slot);
  }

  private moveToward(goal: Point, stopAt: number): void {
    if (Math.hypot(goal.x - this.u.x, goal.z - this.u.z) <= stopAt) return;
    const p = this.options.route ? this.options.route(goal) : goal;
    const dx = p.x - this.u.x;
    const dz = p.z - this.u.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    this.u.move = { x: dx / d, z: dz / d };
    this.u.body.yaw = Math.atan2(-dx, -dz);
  }
}

/** How far a skill can reach from the caster, arena meters. */
export function reachOf(u: Unit, slot: number): number {
  const cast = u.combatant.resolve(slot);
  const t = cast.targeting;
  const r = WORLD_SCALE * cast.rangeScale;
  switch (t.type) {
    case 'projectile':
    case 'line':
    case 'cone':
      return t.range * r;
    case 'ground':
    case 'leap':
      return t.range * r + (t.radius * WORLD_SCALE * cast.radiusScale) / 2;
    case 'self':
      return t.radius === undefined ? 12 : t.radius * WORLD_SCALE * cast.radiusScale;
    case 'dash':
      return t.distance * r + 1;
    case 'ally':
      return 12;
  }
}

/** Einherjar and other mobile summons walk to the nearest enemy near where they were called. */
export class SummonBrain implements Brain {
  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
  ) {}

  update(): void {
    const { u, sim } = this;
    u.move = null;
    let best: Unit | null = null;
    let bestD = 10;
    for (const t of sim.enemiesOf(u)) {
      const d = Math.hypot(t.x - u.home.x, t.z - u.home.z);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    if (!best) return;
    const dx = best.x - u.x;
    const dz = best.z - u.z;
    const d = Math.hypot(dx, dz);
    u.body.yaw = Math.atan2(-dx, -dz);
    if (d > u.radius + best.radius + 0.5) u.move = { x: dx / d, z: dz / d };
  }
}
