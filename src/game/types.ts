// Core data types for gods, skills and skill trees. Everything here is plain
// data so it can be authored in src/game/gods/ and consumed by both the
// simulation and the UI. Distances are meters, times are seconds.

export type DamageType = 'physical' | 'magical' | 'true';
export type ScalingStat = 'strength' | 'intelligence';
export type Role = 'solo' | 'jungle' | 'mid' | 'carry' | 'support';
export type AttackRange = 'melee' | 'ranged';

/** A value per skill rank (index 0 = rank 1). A single number applies to every rank. */
export type Ranked = number | readonly [number, number, number, number, number];

/** Stats every combatant has. Percent-style stats are fractions (0.1 = 10%). */
export interface Stats {
  maxHealth: number;
  healthRegen: number; // per second
  maxMana: number;
  manaRegen: number; // per second
  physicalProtection: number;
  magicalProtection: number;
  attackSpeed: number; // attacks per second
  attackPower: number; // flat basic attack damage
  moveSpeed: number; // Smite-style units; 100 units = 1 m/s
  strength: number;
  intelligence: number;
  physicalPenFlat: number;
  physicalPenPct: number;
  magicalPenFlat: number;
  magicalPenPct: number;
  cooldownReduction: number; // capped, see stats.ts
  critChance: number;
  lifesteal: number; // fraction of damage dealt returned as health
  ccReduction: number; // capped, see stats.ts
  damageBonus: number; // multiplies all outgoing damage
  damageReduction: number; // multiplies all incoming damage
  bonusAttackSpeed: number; // fraction added on top of attackSpeed
  bonusMoveSpeed: number; // fraction added on top of moveSpeed
}

export type StatKey = keyof Stats;

export type BaseStats = Pick<
  Stats,
  | 'maxHealth'
  | 'healthRegen'
  | 'maxMana'
  | 'manaRegen'
  | 'physicalProtection'
  | 'magicalProtection'
  | 'attackSpeed'
  | 'attackPower'
  | 'moveSpeed'
>;

/** Per-level growth. attackSpeed growth is a fraction of base per level. */
export type StatGrowth = Partial<BaseStats>;

// ---------------------------------------------------------------------------
// Crowd control

export type SoftCC = 'slow' | 'cripple' | 'blind' | 'intoxicate';
export type HardCC = 'stun' | 'root' | 'silence' | 'disarm' | 'fear' | 'taunt' | 'mesmerize' | 'disorient';
export type TrueHardCC = 'knockup' | 'knockback' | 'pull' | 'grab' | 'banish' | 'polymorph';
export type CCKind = SoftCC | HardCC | TrueHardCC;

// ---------------------------------------------------------------------------
// Skills

export type Targeting =
  | { type: 'projectile'; range: number; radius: number; speed: number; pierce?: boolean; bounces?: Ranked }
  | { type: 'line'; range: number; width: number }
  | { type: 'cone'; range: number; angle: number }
  | { type: 'ground'; range: number; radius: number }
  | { type: 'self'; radius?: number }
  | { type: 'dash'; distance: number; width: number }
  | { type: 'leap'; range: number; radius: number }
  | { type: 'ally'; range: number };

export type EffectTarget = 'enemies' | 'self' | 'allies' | 'alliesAndSelf';

export type Effect =
  | {
      kind: 'damage';
      amount: Ranked;
      scaling: ScalingStat;
      ratio: number;
      damageType: DamageType;
      /** Number of hits; damage values are per hit. */
      hits?: number;
      interval?: number;
    }
  | { kind: 'heal'; amount: Ranked; scaling: ScalingStat; ratio: number; target: EffectTarget }
  | { kind: 'shield'; amount: Ranked; scaling: ScalingStat; ratio: number; duration: number; target: EffectTarget }
  | { kind: 'cc'; cc: CCKind; duration: Ranked; /** slow strength as a fraction */ magnitude?: Ranked }
  | { kind: 'buff'; stat: StatKey; amount: Ranked; duration: number; target: EffectTarget }
  | { kind: 'debuff'; stat: StatKey; amount: Ranked; duration: number }
  | { kind: 'movement'; style: 'dash' | 'leap' | 'blink'; distance: number }
  | { kind: 'stealth'; duration: number }
  | { kind: 'summon'; unit: string; duration: number }
  | { kind: 'mark'; mark: string; duration: number; stacks?: number };

export type SkillKind = 'regular' | 'ultimate';

export type SkillTag = 'damage' | 'cc' | 'mobility' | 'sustain' | 'protection' | 'utility' | 'zone' | 'buff';

export interface SkillDef {
  id: string;
  name: string;
  kind: SkillKind;
  description: string;
  tags: readonly SkillTag[];
  targeting: Targeting;
  cooldown: Ranked;
  cost: Ranked;
  effects: readonly Effect[];
  /**
   * Only enemies carrying this mark are affected: damage is multiplied by its
   * stacks, crowd control lands only at full stacks, and the mark is consumed.
   */
  detonates?: string;
  /**
   * The skill's effects wait on each enemy god it reaches, under a mark of
   * this name, and land on the caster's next hit on that god. Marked gods
   * can't hide in stealth while it lasts.
   */
  primes?: { mark: string; duration: number };
}

export interface BasicAttackDef {
  range: number;
  damageType: DamageType;
  /** Melee swings hit everything in a small cone; ranged attacks fire projectiles. */
  projectileSpeed?: number;
}

export interface PassiveDef {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Skill trees

/** Fields of a skill a tree node can modify. *Pct fields are fractions; damagePct also scales heals and shields. */
export type SkillModField =
  | 'damagePct'
  | 'cooldownPct'
  | 'costPct'
  | 'radiusPct'
  | 'rangePct'
  | 'ccDurationPct'
  | 'extraHits'
  | 'extraBounces';

export type Keystone =
  | { type: 'ultimateRefundOnTakedown'; pct: number }
  | { type: 'abilityLifesteal'; pct: number }
  | { type: 'executeBelow'; healthPct: number }
  | { type: 'shieldOnHardCC'; maxHealthPct: number; cooldown: number }
  | { type: 'empoweredBasicAfterSkill'; damagePct: number }
  | { type: 'stackingDamage'; perStackPct: number; maxStacks: number; duration: number }
  | { type: 'auraProtection'; amount: number; radius: number }
  | { type: 'speedOnTakedown'; pct: number; duration: number };

export type NodeEffect =
  | { type: 'stat'; stat: StatKey; perRank: number }
  | { type: 'skill'; skill: string; field: SkillModField; perRank: number }
  | { type: 'keystone'; keystone: Keystone };

export interface TreeNode {
  id: string;
  name: string;
  tier: 1 | 2 | 3 | 4;
  maxRank: number;
  description: string;
  effects: readonly NodeEffect[];
  /** A node in the same tree that must be maxed before this one takes points. */
  requires?: string;
}

export interface SkillTree {
  id: string;
  name: string;
  theme: string;
  nodes: readonly TreeNode[];
}

// ---------------------------------------------------------------------------
// Gods

export interface GodDef {
  id: string;
  name: string;
  title: string;
  pantheon: string;
  role: Role;
  attackRange: AttackRange;
  base: BaseStats;
  growth: StatGrowth;
  basicAttack: BasicAttackDef;
  passive: PassiveDef;
  /** The full pool: regular skills and ultimates. */
  skills: readonly SkillDef[];
  trees: readonly [SkillTree, SkillTree, SkillTree];
  /** Four regular skill ids then the ultimate-slot skill id. */
  defaultLoadout: readonly [string, string, string, string, string];
}
