import type { GodDef, StatKey, Stats } from './types';

export const COOLDOWN_REDUCTION_CAP = 0.4;
export const CC_REDUCTION_CAP = 0.4;
export const ATTACK_SPEED_CAP = 2.5;

export function zeroStats(): Stats {
  return {
    maxHealth: 0,
    healthRegen: 0,
    maxMana: 0,
    manaRegen: 0,
    physicalProtection: 0,
    magicalProtection: 0,
    attackSpeed: 0,
    attackPower: 0,
    moveSpeed: 0,
    strength: 0,
    intelligence: 0,
    physicalPenFlat: 0,
    physicalPenPct: 0,
    magicalPenFlat: 0,
    magicalPenPct: 0,
    cooldownReduction: 0,
    critChance: 0,
    lifesteal: 0,
    ccReduction: 0,
    damageBonus: 0,
    damageReduction: 0,
    bonusAttackSpeed: 0,
    bonusMoveSpeed: 0,
  };
}

/** Base stats at a level, before trees and buffs. */
export function statsAtLevel(god: GodDef, level: number): Stats {
  const s = zeroStats();
  const n = Math.max(0, level - 1);
  const b = god.base;
  const g = god.growth;
  s.maxHealth = b.maxHealth + (g.maxHealth ?? 0) * n;
  s.healthRegen = b.healthRegen + (g.healthRegen ?? 0) * n;
  s.maxMana = b.maxMana + (g.maxMana ?? 0) * n;
  s.manaRegen = b.manaRegen + (g.manaRegen ?? 0) * n;
  s.physicalProtection = b.physicalProtection + (g.physicalProtection ?? 0) * n;
  s.magicalProtection = b.magicalProtection + (g.magicalProtection ?? 0) * n;
  s.attackSpeed = b.attackSpeed * (1 + (g.attackSpeed ?? 0) * n);
  s.attackPower = b.attackPower + (g.attackPower ?? 0) * n;
  s.moveSpeed = b.moveSpeed + (g.moveSpeed ?? 0) * n;
  return s;
}

export function addStats(target: Stats, bonus: Partial<Record<StatKey, number>>): Stats {
  for (const [k, v] of Object.entries(bonus) as [StatKey, number][]) target[k] += v;
  return target;
}

/** Apply caps. Call once after every source has been added. */
export function finalizeStats(s: Stats): Stats {
  s.cooldownReduction = clamp(s.cooldownReduction, 0, COOLDOWN_REDUCTION_CAP);
  s.ccReduction = clamp(s.ccReduction, 0, CC_REDUCTION_CAP);
  s.physicalPenPct = clamp(s.physicalPenPct, 0, 0.4);
  s.magicalPenPct = clamp(s.magicalPenPct, 0, 0.4);
  s.critChance = clamp(s.critChance, 0, 1);
  s.damageReduction = clamp(s.damageReduction, 0, 0.8);
  return s;
}

export function effectiveAttackSpeed(s: Stats): number {
  return Math.min(ATTACK_SPEED_CAP, s.attackSpeed * (1 + s.bonusAttackSpeed));
}

/**
 * Combine slow strengths (fractions). Up to 40% stacks linearly; past that it
 * follows Smite's diminishing curve, s * 100 / (s + 60) in percent terms.
 */
export function effectiveSlow(totalSlow: number): number {
  const pct = Math.max(0, totalSlow) * 100;
  const eff = pct <= 40 ? pct : (pct * 100) / (pct + 60);
  return Math.min(eff, 90) / 100;
}

export function effectiveMoveSpeed(s: Stats, totalSlow: number): number {
  return s.moveSpeed * (1 + s.bonusMoveSpeed) * (1 - effectiveSlow(totalSlow));
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
