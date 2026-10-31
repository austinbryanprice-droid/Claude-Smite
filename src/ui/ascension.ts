import './ascension.css';
import type { Difficulty } from '../game/difficulty';

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

/** Harder bots pay more, easier ones less. */
export const DIFFICULTY_XP: Record<Difficulty, number> = { easy: 0.75, normal: 1, hard: 1.5 };
/** The first win of each day pays this much on top. */
export const FIRST_WIN_BONUS = 150;

let difficulty: Difficulty = 'normal';
/** The current game's bot difficulty, set when the game applies it. */
export function setXpDifficulty(d: Difficulty): void {
  difficulty = d;
}

interface Saved {
  xp?: number;
  /** The local day (YYYY-MM-DD) of the last first-win bonus. */
  winDay?: string;
}

function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

export function getXp(): number {
  return Number(load().xp) || 0;
}

const today = (now = new Date()): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export interface Award {
  gained: number;
  /** The first win of the day's bonus, included in `gained` (0 when none). */
  bonus: number;
  difficulty: Difficulty;
  before: Rank;
  after: Rank;
}

/** Award a game's XP: scaled by the bot difficulty, plus the first win of the day. */
export function awardXp(base: number, won = false, now = new Date()): Award {
  const saved = load();
  const xp = Number(saved.xp) || 0;
  const day = today(now);
  const bonus = won && saved.winDay !== day ? FIRST_WIN_BONUS : 0;
  const gained = Math.round(base * DIFFICULTY_XP[difficulty]) + bonus;
  try {
    localStorage.setItem(KEY, JSON.stringify({ xp: xp + gained, winDay: bonus ? day : saved.winDay }));
  } catch {
    /* storage unavailable */
  }
  return { gained, bonus, difficulty, before: rankOf(xp), after: rankOf(xp + gained) };
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
  const extra = [a.difficulty !== 'normal' ? `${a.difficulty === 'hard' ? 'Hard' : 'Easy'} bots ×${DIFFICULTY_XP[a.difficulty]}` : '', a.bonus ? `first win today +${a.bonus}` : ''].filter(Boolean).join(' · ');
  return `<div class="asc-gain${up ? ' up' : ''}">+${a.gained} Ascension${extra ? ` <small>(${extra})</small>` : ''}${up ? ` · <b>Rank up: ${a.after.title}</b>` : ''} <span class="asc-rank">Rank ${a.after.level} ${a.after.title}</span>${bar(a.after)}</div>`;
}
