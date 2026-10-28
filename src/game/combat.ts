import type { CCKind, DamageType, HardCC, SoftCC, Stats, TrueHardCC } from './types';

// ---------------------------------------------------------------------------
// Damage

/** Protection after penetration. Percent pen applies before flat pen. */
export function effectiveProtection(target: Stats, attacker: Stats, type: DamageType): number {
  if (type === 'true') return 0;
  const prot = type === 'physical' ? target.physicalProtection : target.magicalProtection;
  const pct = type === 'physical' ? attacker.physicalPenPct : attacker.magicalPenPct;
  const flat = type === 'physical' ? attacker.physicalPenFlat : attacker.magicalPenFlat;
  return Math.max(0, prot * (1 - pct) - flat);
}

/** Smite's mitigation curve: each point of protection is ~1% more effective health. */
export function mitigation(protection: number): number {
  return 100 / (100 + Math.max(0, protection));
}

export interface DamageResult {
  raw: number;
  dealt: number;
  crit: boolean;
}

/** Final damage from a pre-mitigation amount. */
export function computeDamage(
  raw: number,
  type: DamageType,
  attacker: Stats,
  target: Stats,
  crit = false,
): DamageResult {
  const boosted = raw * (1 + attacker.damageBonus) * (crit ? CRIT_MULTIPLIER : 1);
  const dealt =
    boosted * mitigation(effectiveProtection(target, attacker, type)) * (1 - target.damageReduction);
  return { raw: boosted, dealt: Math.max(0, dealt), crit };
}

export const CRIT_MULTIPLIER = 1.75;
export const BASIC_STRENGTH_RATIO = 1;
export const BASIC_INTELLIGENCE_RATIO = 0.2;

/** Basic attacks scale with 100% Strength and 20% Intelligence for every god. */
export function basicAttackRaw(s: Stats): number {
  return s.attackPower + s.strength * BASIC_STRENGTH_RATIO + s.intelligence * BASIC_INTELLIGENCE_RATIO;
}

// ---------------------------------------------------------------------------
// Crowd control

const SOFT: ReadonlySet<CCKind> = new Set<SoftCC>(['slow', 'cripple', 'blind', 'intoxicate']);
const TRUE_HARD: ReadonlySet<CCKind> = new Set<TrueHardCC>([
  'knockup',
  'knockback',
  'pull',
  'grab',
  'banish',
  'polymorph',
]);

export type CCClass = 'soft' | 'hard' | 'trueHard';

export function ccClass(kind: CCKind): CCClass {
  if (SOFT.has(kind)) return 'soft';
  if (TRUE_HARD.has(kind)) return 'trueHard';
  return 'hard';
}

export const DR_PER_STACK = 0.2;
export const DR_MAX_STACKS = 4;
export const DR_DURATION = 15;

export interface ActiveCC {
  kind: CCKind;
  remaining: number;
  /** Who applied it, so repeated ticks of one effect refresh instead of stacking. */
  source?: string;
  magnitude: number;
}

/** What a unit is currently prevented from doing. */
export interface CCLocks {
  move: boolean;
  attack: boolean;
  cast: boolean;
  movementAbilities: boolean;
  forcedMovement: boolean;
}

const LOCKS: Record<HardCC | TrueHardCC, Partial<CCLocks>> = {
  stun: { move: true, attack: true, cast: true },
  root: { move: true },
  silence: { cast: true },
  disarm: { attack: true },
  fear: { attack: true, cast: true, forcedMovement: true },
  taunt: { cast: true, forcedMovement: true },
  mesmerize: { move: true, attack: true, cast: true },
  disorient: { move: true, attack: true, cast: true },
  knockup: { move: true, attack: true, cast: true },
  knockback: { move: true, attack: true, cast: true, forcedMovement: true },
  pull: { move: true, attack: true, cast: true, forcedMovement: true },
  grab: { move: true, attack: true, cast: true, forcedMovement: true },
  banish: { move: true, attack: true, cast: true },
  polymorph: { attack: true, cast: true },
};

/**
 * Tracks crowd control and diminishing returns on one unit.
 * Hard CC: duration reduced by CCR + DR, then adds 1 DR stack.
 * True hard CC: ignores CCR and DR, adds 2 DR stacks.
 * Soft CC: reduced by CCR only, no DR.
 */
export class CCState {
  active: ActiveCC[] = [];
  private drStacks: number[] = []; // remaining time per stack

  get drCount(): number {
    return this.drStacks.length;
  }

  /** Returns the duration actually applied (0 if fully resisted). */
  apply(kind: CCKind, duration: number, magnitude = 0, ccReduction = 0, immune = false, source?: string): number {
    if (immune) return 0;
    const cls = ccClass(kind);
    let applied = duration;
    if (cls === 'hard') applied *= 1 - Math.min(0.95, ccReduction + this.drCount * DR_PER_STACK);
    else if (cls === 'soft') applied *= 1 - ccReduction;
    if (applied <= 0.01) return 0;

    // A new copy of the same CC refreshes rather than stacks. Slows from
    // different sources stack (combined by effectiveSlow()); a repeat from the
    // same source, such as another tick of one zone, refreshes.
    const existing =
      kind === 'slow'
        ? source === undefined
          ? undefined
          : this.active.find((c) => c.kind === 'slow' && c.source === source)
        : this.active.find((c) => c.kind === kind);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, applied);
      existing.magnitude = Math.max(existing.magnitude, magnitude);
    } else {
      this.active.push({ kind, remaining: applied, magnitude, source });
    }

    const stacks = cls === 'trueHard' ? 2 : cls === 'hard' ? 1 : 0;
    for (let i = 0; i < stacks; i++) {
      if (this.drStacks.length < DR_MAX_STACKS) this.drStacks.push(DR_DURATION);
      else this.drStacks[this.drStacks.indexOf(Math.min(...this.drStacks))] = DR_DURATION;
    }
    return applied;
  }

  update(dt: number): void {
    for (const c of this.active) c.remaining -= dt;
    this.active = this.active.filter((c) => c.remaining > 0);
    this.drStacks = this.drStacks.map((t) => t - dt).filter((t) => t > 0);
  }

  has(kind: CCKind): boolean {
    return this.active.some((c) => c.kind === kind);
  }

  totalSlow(): number {
    return this.active.filter((c) => c.kind === 'slow').reduce((sum, c) => sum + c.magnitude, 0);
  }

  locks(): CCLocks {
    const out: CCLocks = { move: false, attack: false, cast: false, movementAbilities: false, forcedMovement: false };
    for (const c of this.active) {
      if (c.kind === 'cripple') out.movementAbilities = true;
      const l = (LOCKS as Partial<Record<CCKind, Partial<CCLocks>>>)[c.kind];
      if (!l) continue;
      for (const k of Object.keys(l) as (keyof CCLocks)[]) out[k] ||= l[k]!;
    }
    // Rooted units can still dash; anything that blocks casting blocks dashes too.
    out.movementAbilities ||= out.cast;
    return out;
  }

  /** Mesmerize breaks on damage. */
  onDamaged(): void {
    this.active = this.active.filter((c) => c.kind !== 'mesmerize');
  }

  cleanse(): void {
    this.active = [];
  }

  /** Clear everything, diminishing returns included (on death). */
  reset(): void {
    this.active = [];
    this.drStacks = [];
  }
}
