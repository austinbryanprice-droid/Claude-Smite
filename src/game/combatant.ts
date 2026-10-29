import { basicAttackRaw, CCState, ccClass, computeDamage, type DamageResult } from './combat';
import { skillById, swapSkill, ULTIMATE_SLOT, type Loadout, type LoadoutError } from './loadout';
import { levelForXp, ranked, skillRank, treePointsEarned, XP_TABLE, MAX_LEVEL } from './progression';
import { addStats, effectiveAttackSpeed, effectiveMoveSpeed, finalizeStats, statsAtLevel } from './stats';
import {
  addPoint,
  emptySkillMods,
  indexTrees,
  removePoint,
  treeBonuses,
  type Allocation,
  type AllocationError,
  type TreeBonuses,
  type TreeIndex,
} from './trees';
import type { CCKind, DamageType, Effect, GodDef, Keystone, SkillDef, StatKey, Stats, Targeting } from './types';

/** The two sides of a match. */
export type Side = 'order' | 'chaos';
/** Jungle monsters are neutral: hostile to both sides. */
export type Team = Side | 'neutral';

interface TimedMod {
  stat: StatKey;
  amount: number;
  remaining: number;
}

interface Shield {
  amount: number;
  remaining: number;
}

/** A skill cast with every number resolved for the caster's rank, stats and tree. */
export interface ResolvedSkill {
  skill: SkillDef;
  slot: number;
  rank: number;
  targeting: Targeting;
  radiusScale: number;
  rangeScale: number;
  extraBounces: number;
  hits: ResolvedEffect[];
}

export type ResolvedEffect =
  | { kind: 'damage'; amount: number; damageType: DamageType; hits: number; interval: number }
  | { kind: 'heal'; amount: number; target: Extract<Effect, { kind: 'heal' }>['target'] }
  | { kind: 'shield'; amount: number; duration: number; target: Extract<Effect, { kind: 'shield' }>['target'] }
  | { kind: 'cc'; cc: CCKind; duration: number; magnitude: number }
  | { kind: 'buff'; stat: StatKey; amount: number; duration: number; target: Extract<Effect, { kind: 'buff' }>['target'] }
  | { kind: 'debuff'; stat: StatKey; amount: number; duration: number }
  | Extract<Effect, { kind: 'movement' | 'stealth' | 'summon' | 'mark' }>;

let nextUid = 1;

/** A basic attack in flight: damage is fixed when the attack starts. */
export interface BasicShot {
  raw: number;
  crit: boolean;
}

export type CastError = 'dead' | 'locked' | 'cc' | 'cooldown' | 'mana' | 'emptySlot';

export class Combatant {
  readonly god: GodDef;
  readonly team: Team;
  readonly trees: TreeIndex;
  /** Unique per instance; tags the CC this unit applies. */
  readonly uid = nextUid++;

  xp = 0;
  favor = 0;
  health: number;
  mana: number;
  alive = true;
  inBase = true;
  respawnTimer = 0;
  loadout: Loadout;
  allocation: Allocation = {};
  /**
   * Remaining cooldown per skill id. Keyed by skill, not slot, so swapping a
   * skill out and back in at the fountain never resets its cooldown.
   */
  private cooldowns = new Map<string, number>();
  basicCooldown = 0;
  readonly cc = new CCState();

  private mods: TimedMod[] = [];
  private shields: Shield[] = [];
  private bonuses: TreeBonuses = { stats: {}, skills: {}, keystones: [] };
  private cached: Stats | null = null;
  private stacks = { count: 0, remaining: 0 };
  private hardCCShieldCooldown = 0;
  private empoweredBasic = false;

  constructor(god: GodDef, team: Team, loadout: Loadout = god.defaultLoadout) {
    this.god = god;
    this.team = team;
    this.trees = indexTrees(god);
    this.loadout = loadout;
    const s = this.stats;
    this.health = s.maxHealth;
    this.mana = s.maxMana;
  }

  // -------------------------------------------------------------------------
  // Progression

  get level(): number {
    return levelForXp(this.xp);
  }

  get treeBudget(): number {
    return treePointsEarned(this.level, this.favor);
  }

  get unspentPoints(): number {
    return this.treeBudget - Object.values(this.allocation).reduce((a, b) => a + b, 0);
  }

  /** XP into the current level, and the size of that level, for the HUD bar. */
  get levelProgress(): { into: number; needed: number } {
    const lvl = this.level;
    if (lvl >= MAX_LEVEL) return { into: 1, needed: 1 };
    return { into: this.xp - XP_TABLE[lvl - 1]!, needed: XP_TABLE[lvl]! - XP_TABLE[lvl - 1]! };
  }

  gainXp(amount: number): void {
    const before = this.stats;
    this.xp += amount;
    this.growResources(before);
  }

  gainFavor(amount: number): void {
    this.favor += amount;
  }

  skillRankInSlot(slot: number): number {
    const skill = this.skillInSlot(slot);
    return skill ? skillRank(skill.kind, this.level) : 0;
  }

  skillInSlot(slot: number): SkillDef | undefined {
    const id = this.loadout[slot];
    return id === undefined ? undefined : skillById(this.god, id);
  }

  /** New points can be spent anywhere; taking points back is a respec and needs base. */
  allocate(nodeId: string): AllocationError | null {
    const r = addPoint(this.trees, this.allocation, nodeId, this.treeBudget);
    if (!r.ok) return r.error;
    this.setAllocation(r.alloc);
    return null;
  }

  deallocate(nodeId: string): AllocationError | 'notInBase' | null {
    if (!this.inBase) return 'notInBase';
    const r = removePoint(this.trees, this.allocation, nodeId, this.treeBudget);
    if (!r.ok) return r.error;
    this.setAllocation(r.alloc);
    return null;
  }

  swap(slot: number, skillId: string): LoadoutError | null {
    const r = swapSkill(this.god, this.loadout, slot, skillId, this.inBase);
    if (!r.ok) return r.error;
    this.loadout = r.loadout;
    return null;
  }

  private setAllocation(alloc: Allocation): void {
    const before = this.stats;
    this.allocation = alloc;
    this.bonuses = treeBonuses(this.trees, alloc);
    this.growResources(before);
  }

  hasKeystone<T extends Keystone['type']>(type: T): Extract<Keystone, { type: T }> | undefined {
    return this.bonuses.keystones.find((k) => k.type === type) as Extract<Keystone, { type: T }> | undefined;
  }

  // -------------------------------------------------------------------------
  // Stats

  get stats(): Stats {
    if (!this.cached) {
      const s = statsAtLevel(this.god, this.level);
      addStats(s, this.bonuses.stats);
      for (const m of this.mods) s[m.stat] += m.amount;
      if (this.stacks.count > 0) {
        const k = this.hasKeystone('stackingDamage');
        if (k) s.damageBonus += k.perStackPct * this.stacks.count;
      }
      this.cached = finalizeStats(s);
    }
    return this.cached;
  }

  private invalidate(): void {
    this.cached = null;
  }

  /**
   * When max health or mana changes, keep the missing amount the same. Growth
   * adds to current values, and taking a point back removes exactly what it
   * gave, so allocate/respec cycles can never refill resources.
   */
  private growResources(before: Stats): void {
    this.invalidate();
    if (!this.alive) return;
    const after = this.stats;
    const missingHealth = before.maxHealth - this.health;
    const missingMana = before.maxMana - this.mana;
    this.health = Math.max(1, Math.min(after.maxHealth, after.maxHealth - missingHealth));
    this.mana = Math.max(0, Math.min(after.maxMana, after.maxMana - missingMana));
  }

  get moveSpeed(): number {
    return effectiveMoveSpeed(this.stats, this.cc.totalSlow());
  }

  get attackSpeed(): number {
    return effectiveAttackSpeed(this.stats);
  }

  get shieldTotal(): number {
    return this.shields.reduce((a, s) => a + s.amount, 0);
  }

  addTimedMod(stat: StatKey, amount: number, duration: number): void {
    if (!this.alive) return;
    this.mods.push({ stat, amount, remaining: duration });
    this.invalidate();
  }

  /** Restart the timed mod with this stat and amount (a refreshed buff), or add it. */
  refreshTimedMod(stat: StatKey, amount: number, duration: number): void {
    const m = this.mods.find((x) => x.stat === stat && x.amount === amount);
    if (m) m.remaining = duration;
    else this.addTimedMod(stat, amount, duration);
  }

  addShield(amount: number, duration: number): void {
    if (!this.alive) return;
    this.shields.push({ amount, remaining: duration });
  }

  // -------------------------------------------------------------------------
  // Skills

  canCast(slot: number): CastError | null {
    if (!this.alive) return 'dead';
    const skill = this.skillInSlot(slot);
    if (!skill) return 'emptySlot';
    if (this.skillRankInSlot(slot) === 0) return 'locked';
    const locks = this.cc.locks();
    if (locks.cast) return 'cc';
    if (locks.movementAbilities && skill.effects.some((e) => e.kind === 'movement')) return 'cc';
    if (this.cooldownOf(slot) > 0) return 'cooldown';
    if (this.mana < this.resolveCost(slot)) return 'mana';
    return null;
  }

  /** Seconds until the skill in a slot is ready. */
  cooldownOf(slot: number): number {
    const id = this.loadout[slot];
    return id === undefined ? 0 : (this.cooldowns.get(id) ?? 0);
  }

  resolveCost(slot: number): number {
    const skill = this.skillInSlot(slot);
    if (!skill) return 0;
    const mods = this.bonuses.skills[skill.id] ?? emptySkillMods();
    return ranked(skill.cost, this.skillRankInSlot(slot)) * Math.max(0, 1 - mods.costPct);
  }

  resolveCooldown(slot: number): number {
    const skill = this.skillInSlot(slot);
    if (!skill) return 0;
    const mods = this.bonuses.skills[skill.id] ?? emptySkillMods();
    const base = ranked(skill.cooldown, this.skillRankInSlot(slot));
    return base * (1 - this.stats.cooldownReduction) * Math.max(0.2, 1 - mods.cooldownPct);
  }

  /** Spend mana, start the cooldown, and return the resolved numbers for the simulation. */
  cast(slot: number): { ok: true; cast: ResolvedSkill } | { ok: false; error: CastError } {
    const error = this.canCast(slot);
    if (error) return { ok: false, error };
    this.mana -= this.resolveCost(slot);
    this.cooldowns.set(this.loadout[slot]!, this.resolveCooldown(slot));
    if (this.hasKeystone('empoweredBasicAfterSkill')) this.empoweredBasic = true;
    return { ok: true, cast: this.resolve(slot) };
  }

  /** Resolve a slot's skill without casting it (for tooltips and previews). */
  resolve(slot: number): ResolvedSkill {
    const skill = this.skillInSlot(slot)!;
    const rank = Math.max(1, this.skillRankInSlot(slot));
    const mods = this.bonuses.skills[skill.id] ?? emptySkillMods();
    const s = this.stats;
    const hits: ResolvedEffect[] = skill.effects.map((e): ResolvedEffect => {
      switch (e.kind) {
        case 'damage':
          return {
            kind: 'damage',
            amount: (ranked(e.amount, rank) + s[e.scaling] * e.ratio) * (1 + mods.damagePct),
            damageType: e.damageType,
            hits: (e.hits ?? 1) + mods.extraHits,
            interval: e.interval ?? 0,
          };
        case 'heal':
          return {
            kind: 'heal',
            amount: (ranked(e.amount, rank) + s[e.scaling] * e.ratio) * (1 + mods.damagePct),
            target: e.target,
          };
        case 'shield':
          return {
            kind: 'shield',
            amount: (ranked(e.amount, rank) + s[e.scaling] * e.ratio) * (1 + mods.damagePct),
            duration: e.duration,
            target: e.target,
          };
        case 'cc':
          return {
            kind: 'cc',
            cc: e.cc,
            duration: ranked(e.duration, rank) * (1 + mods.ccDurationPct),
            magnitude: e.magnitude === undefined ? 0 : ranked(e.magnitude, rank),
          };
        case 'buff':
          return { kind: 'buff', stat: e.stat, amount: ranked(e.amount, rank), duration: e.duration, target: e.target };
        case 'debuff':
          return { kind: 'debuff', stat: e.stat, amount: ranked(e.amount, rank), duration: e.duration };
        default:
          return e;
      }
    });
    return {
      skill,
      slot,
      rank,
      targeting: skill.targeting,
      radiusScale: 1 + mods.radiusPct,
      rangeScale: 1 + mods.rangePct,
      extraBounces: mods.extraBounces,
      hits,
    };
  }

  /**
   * Apply a resolved skill's effects to one unit the simulation decided was hit.
   * Damage effects deal one hit; the simulation calls again for each tick.
   */
  applySkillTo(cast: ResolvedSkill, target: Combatant): void {
    const enemy = target.team !== this.team;
    for (const e of cast.hits) {
      if (!target.alive) return; // a lethal hit carries nothing into the next life
      switch (e.kind) {
        case 'damage':
          if (enemy) this.dealDamage(target, e.amount, e.damageType, true);
          break;
        case 'cc':
          if (enemy) target.receiveCC(e.cc, e.duration, e.magnitude, `${this.uid}:${cast.skill.id}`);
          break;
        case 'debuff':
          if (enemy) target.addTimedMod(e.stat, -e.amount, e.duration);
          break;
        case 'heal':
          if (affects(e.target, this, target)) target.heal(e.amount);
          break;
        case 'shield':
          if (affects(e.target, this, target)) target.addShield(e.amount, e.duration);
          break;
        case 'buff':
          if (affects(e.target, this, target)) target.addTimedMod(e.stat, e.amount, e.duration);
          break;
        default:
          break; // movement, stealth, summons and marks are handled by the simulation
      }
    }
  }

  // -------------------------------------------------------------------------
  // Basic attacks and damage

  get basicReady(): boolean {
    return this.alive && this.basicCooldown <= 0 && !this.cc.locks().attack;
  }

  /** Swing and hit in one step (melee, or tests). */
  basicAttack(target: Combatant, rng: () => number = Math.random): DamageResult | null {
    if (target.team === this.team) return null;
    const shot = this.startBasic(rng);
    return shot && this.landBasic(target, shot);
  }

  /**
   * Start a basic attack: spends the attack timer and any empowered charge and
   * rolls the crit. Ranged attacks call this when the projectile leaves and
   * `landBasic` when it connects; a melee swing lands on every unit in its arc.
   */
  startBasic(rng: () => number = Math.random): BasicShot | null {
    if (!this.basicReady) return null;
    this.basicCooldown = 1 / this.attackSpeed;
    let raw = basicAttackRaw(this.stats);
    if (this.empoweredBasic) {
      raw *= 1 + (this.hasKeystone('empoweredBasicAfterSkill')?.damagePct ?? 0);
      this.empoweredBasic = false;
    }
    return { raw, crit: rng() < this.stats.critChance };
  }

  /** Outgoing damage multiplier against a target, for passives that depend on the world (facing, distance, marks). */
  damageAmp: ((target: Combatant, fromAbility: boolean) => number) | null = null;

  landBasic(target: Combatant, shot: BasicShot): DamageResult | null {
    if (target.team === this.team || !target.alive) return null;
    return this.dealDamage(target, shot.raw, this.god.basicAttack.damageType, false, shot.crit);
  }

  dealDamage(target: Combatant, raw: number, type: DamageType, fromAbility: boolean, crit = false): DamageResult {
    if (!target.alive) return { raw: 0, dealt: 0, crit: false };
    const execute = this.hasKeystone('executeBelow');
    // god passives (set by the simulation, which knows positions and marks)
    if (this.damageAmp) raw *= this.damageAmp(target, fromAbility);
    const result = computeDamage(raw, type, this.stats, target.stats, crit);
    // Lifesteal only counts damage the target could actually take (no overkill).
    const sustained = Math.min(result.dealt, target.health + target.shieldTotal);
    const killed = target.takeDamage(result.dealt, this);
    if (!killed && execute && target.alive && target.health / target.stats.maxHealth < execute.healthPct) {
      target.takeDamage(target.health + target.shieldTotal, this);
    }
    const steal = this.stats.lifesteal + (fromAbility ? (this.hasKeystone('abilityLifesteal')?.pct ?? 0) : 0);
    if (steal > 0) this.heal(sustained * steal);
    const stacking = this.hasKeystone('stackingDamage');
    if (stacking && fromAbility) {
      this.stacks.count = Math.min(stacking.maxStacks, this.stacks.count + 1);
      this.stacks.remaining = stacking.duration;
      this.invalidate();
    }
    return result;
  }

  /** Returns true if this hit killed the unit. */
  takeDamage(amount: number, source?: Combatant): boolean {
    if (!this.alive || amount <= 0) return false;
    let rest = amount;
    for (const s of this.shields) {
      const absorbed = Math.min(s.amount, rest);
      s.amount -= absorbed;
      rest -= absorbed;
    }
    this.shields = this.shields.filter((s) => s.amount > 0);
    this.health -= rest;
    this.cc.onDamaged();
    if (this.health <= 0) {
      this.die();
      source?.onTakedown();
      return true;
    }
    return false;
  }

  heal(amount: number): void {
    if (!this.alive) return;
    this.health = Math.min(this.stats.maxHealth, this.health + amount);
  }

  receiveCC(kind: CCKind, duration: number, magnitude = 0, source?: string): number {
    if (!this.alive) return 0;
    const applied = this.cc.apply(kind, duration, magnitude, this.stats.ccReduction, false, source);
    const k = this.hasKeystone('shieldOnHardCC');
    if (applied > 0 && k && ccClass(kind) !== 'soft' && this.hardCCShieldCooldown <= 0) {
      this.addShield(this.stats.maxHealth * k.maxHealthPct, 4);
      this.hardCCShieldCooldown = k.cooldown;
    }
    return applied;
  }

  /** Called on the killer (and by the simulation for assists). */
  onTakedown(): void {
    const refund = this.hasKeystone('ultimateRefundOnTakedown');
    const ult = this.skillInSlot(ULTIMATE_SLOT);
    if (refund && ult?.kind === 'ultimate') {
      this.cooldowns.set(ult.id, (this.cooldowns.get(ult.id) ?? 0) * (1 - refund.pct));
    }
    const speed = this.hasKeystone('speedOnTakedown');
    if (speed) this.addTimedMod('bonusMoveSpeed', speed.pct, speed.duration);
  }

  private die(): void {
    this.alive = false;
    this.health = 0;
    this.shields = [];
    this.mods = [];
    this.cc.reset();
    this.respawnTimer = respawnTime(this.level);
    this.invalidate();
  }

  respawn(): void {
    this.alive = true;
    this.mods = [];
    this.shields = [];
    this.inBase = true;
    this.invalidate();
    this.health = this.stats.maxHealth;
    this.mana = this.stats.maxMana;
  }

  // -------------------------------------------------------------------------
  // Tick

  update(dt: number): void {
    // Cooldowns keep running while dead so a respawn doesn't extend them.
    for (const [id, c] of this.cooldowns) {
      if (c <= dt) this.cooldowns.delete(id);
      else this.cooldowns.set(id, c - dt);
    }
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }
    const before = this.mods.length;
    for (const m of this.mods) m.remaining -= dt;
    this.mods = this.mods.filter((m) => m.remaining > 0);
    if (this.mods.length !== before) this.invalidate();

    for (const s of this.shields) s.remaining -= dt;
    this.shields = this.shields.filter((s) => s.remaining > 0 && s.amount > 0);

    if (this.stacks.count > 0) {
      this.stacks.remaining -= dt;
      if (this.stacks.remaining <= 0) {
        this.stacks.count = 0;
        this.invalidate();
      }
    }

    this.cc.update(dt);
    this.basicCooldown = Math.max(0, this.basicCooldown - dt);
    this.hardCCShieldCooldown = Math.max(0, this.hardCCShieldCooldown - dt);

    const s = this.stats;
    const regenScale = this.inBase ? 8 : 1; // fountain
    this.health = Math.min(s.maxHealth, this.health + s.healthRegen * regenScale * dt);
    this.mana = Math.min(s.maxMana, this.mana + s.manaRegen * regenScale * dt);
  }
}

/** Respawn grows with level: 8 s at level 1 to about 60 s at level 20. */
export function respawnTime(level: number): number {
  return 8 + (52 * (level - 1) * (level - 1)) / ((MAX_LEVEL - 1) * (MAX_LEVEL - 1));
}

function affects(target: 'enemies' | 'self' | 'allies' | 'alliesAndSelf', caster: Combatant, unit: Combatant): boolean {
  if (target === 'self') return unit === caster;
  if (target === 'allies') return unit !== caster && unit.team === caster.team;
  if (target === 'alliesAndSelf') return unit.team === caster.team;
  return unit.team !== caster.team;
}
