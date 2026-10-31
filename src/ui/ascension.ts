import './ascension.css';

/**
 * Ascension: a rank that grows with every finished game, in any mode, kept in
 * this browser. It gives each game a reward to carry into the next one.
 */
const KEY = 'ascendant.ascension';

export const RANKS = ['Mortal', 'Initiate', 'Acolyte', 'Zealot', 'Champion', 'Hero', 'Demigod', 'Exalted', 'Divine', 'Ascendant'] as const;

/** XP from one rank to the next: each step a little longer than the last. */
export const rankNeed = (level: number): number => 300 + 150 * (level - 1);

export interface Rank {
  level: number;
  title: string;
  /** XP into this rank, and what the next one needs. */
  into: number;
  need: number;
}

export function rankOf(xp: number): Rank {
  let level = 1;
  let left = Math.max(0, Math.floor(xp));
  while (left >= rankNeed(level)) left -= rankNeed(level++);
  return { level, title: RANKS[Math.min(level, RANKS.length) - 1]!, into: left, need: rankNeed(level) };
}

export type XpMode = 'conquest' | 'clash' | 'siege' | 'duel';

/** What a finished game is worth: a share for playing, as much again for winning; Siege pays per wave held. */
export function gameXp(mode: XpMode, result: { won?: boolean; best?: number }): number {
  if (mode === 'siege') return 25 * Math.max(0, result.best ?? 0);
  const base = { conquest: 200, clash: 80, duel: 60 }[mode];
  return base * (result.won ? 2 : 1);
}

export function getXp(): number {
  try {
    return Number(JSON.parse(localStorage.getItem(KEY) ?? '{}').xp) || 0;
  } catch {
    return 0;
  }
}

export interface Award {
  gained: number;
  before: Rank;
  after: Rank;
}

export function awardXp(gained: number): Award {
  const xp = getXp();
  try {
    localStorage.setItem(KEY, JSON.stringify({ xp: xp + gained }));
  } catch {
    /* storage unavailable */
  }
  return { gained, before: rankOf(xp), after: rankOf(xp + gained) };
}

const bar = (r: Rank) => `<span class="asc-bar"><i style="width:${Math.round((r.into / r.need) * 100)}%"></i></span>`;

/** The start screen's rank badge, or '' before the first game. */
export function rankBadge(xp = getXp()): string {
  if (xp <= 0) return '';
  const r = rankOf(xp);
  return `<div class="asc-badge" title="${r.into} / ${r.need} to the next rank"><b>${r.level}</b><span>${r.title}</span>${bar(r)}</div>`;
}

/** The end screen's line: what the game earned, and a rank up if there was one. */
export function awardLine(a: Award): string {
  const up = a.after.level > a.before.level;
  return `<div class="asc-gain${up ? ' up' : ''}">+${a.gained} Ascension${up ? ` · <b>Rank up: ${a.after.title}</b>` : ''} <span class="asc-rank">Rank ${a.after.level} ${a.after.title}</span>${bar(a.after)}</div>`;
}
