import type { Ranked, SkillKind } from './types';

export const MAX_LEVEL = 20;
export const MAX_TREE_POINTS = 35;
/** Points from levels 2..20. */
export const LEVEL_POINTS = MAX_LEVEL - 1;
export const FAVOR_POINTS = MAX_TREE_POINTS - LEVEL_POINTS;

/** Total XP needed to reach each level (index = level - 1). */
export const XP_TABLE: readonly number[] = Array.from({ length: MAX_LEVEL }, (_, i) =>
  i === 0 ? 0 : Math.round(150 * i + 22 * i * i),
);

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= XP_TABLE[level]!) level++;
  return level;
}

/**
 * Favor needed for each of the 16 Favor points. Front-loaded so early farming
 * matters, with later points coming from objectives and fights.
 */
export const FAVOR_THRESHOLDS: readonly number[] = Array.from({ length: FAVOR_POINTS }, (_, i) =>
  Math.round(120 * (i + 1) + 18 * i * i),
);

export function favorPoints(favor: number): number {
  let n = 0;
  while (n < FAVOR_THRESHOLDS.length && favor >= FAVOR_THRESHOLDS[n]!) n++;
  return n;
}

/** Favor rewards. Kept here so tuning lives in one place. */
export const FAVOR_REWARDS = {
  minion: 8,
  brute: 20,
  jungleCamp: 25,
  buffCamp: 40,
  godKill: 120,
  assist: 60,
  tower: 150,
  phoenix: 200,
  treasureWyrm: 250,
  moltenColossus: 300,
} as const;

export function treePointsEarned(level: number, favor: number): number {
  return Math.min(MAX_TREE_POINTS, clampLevel(level) - 1 + favorPoints(favor));
}

const REGULAR_RANK_LEVELS = [1, 4, 8, 12, 16] as const;
const ULTIMATE_RANK_LEVELS = [5, 9, 13, 17, 20] as const;

/** Skill rank (0 = locked, 1..5) from god level. Ranks are automatic, never spent. */
export function skillRank(kind: SkillKind, level: number): number {
  const table = kind === 'ultimate' ? ULTIMATE_RANK_LEVELS : REGULAR_RANK_LEVELS;
  return table.filter((l) => level >= l).length;
}

export function ranked(value: Ranked, rank: number): number {
  if (typeof value === 'number') return value;
  return value[Math.max(1, Math.min(5, rank)) - 1]!;
}

function clampLevel(level: number): number {
  return Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
}
