import type { StatKey } from './types';

export type Difficulty = 'easy' | 'normal' | 'hard';

export const DIFFICULTIES: { id: Difficulty; name: string; text: string }[] = [
  { id: 'easy', name: 'Easy', text: 'Enemy gods hit softer; your Siege team is sturdier.' },
  { id: 'normal', name: 'Normal', text: 'The game as tuned.' },
  { id: 'hard', name: 'Hard', text: 'Enemy gods hit harder and take less; Siege monsters hurt more.' },
];

type Perks = Partial<Record<StatKey, number>>;

/**
 * Lasting stat changes a difficulty puts on gods: on the player's foes and on
 * the player's own team. In Temple Siege, where the foes are monsters, only the
 * team changes. (Damage reduction can't go below zero, so making things harder
 * for the player is done by raising the foes, not lowering the team.)
 */
export function difficultyPerks(d: Difficulty, siege = false): { foe: Perks; team: Perks } {
  if (d === 'normal') return { foe: {}, team: {} };
  if (siege) return { foe: {}, team: d === 'easy' ? { damageBonus: 0.2, damageReduction: 0.15 } : { damageBonus: -0.15 } };
  return d === 'easy' ? { foe: { damageBonus: -0.25 }, team: { damageReduction: 0.1 } } : { foe: { damageBonus: 0.2, damageReduction: 0.1 }, team: {} };
}

export function parseDifficulty(v: unknown): Difficulty {
  return v === 'easy' || v === 'hard' ? v : 'normal';
}
