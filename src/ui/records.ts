import { awardXp, gameXp, type Award } from './ascension';

/** Personal records per mode, kept in this browser: games played, won, and the best Siege run. */
export interface ModeRecord {
  played: number;
  won: number;
  /** Temple Siege: the most waves held. */
  best: number;
}

export type RecordMode = 'conquest' | 'clash' | 'siege' | 'duel';

const KEY = 'ascendant.records';
/** Where the Siege best lived before records existed. */
const OLD_SIEGE_BEST = 'ascendant.siegeBest';

function loadAll(): Partial<Record<RecordMode, ModeRecord>> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<RecordMode, ModeRecord>>;
    const old = Number(localStorage.getItem(OLD_SIEGE_BEST)) || 0;
    if (old && !all.siege) all.siege = { played: 0, won: 0, best: old };
    return all;
  } catch {
    return {};
  }
}

export function getRecord(mode: RecordMode): ModeRecord {
  return { played: 0, won: 0, best: 0, ...loadAll()[mode] };
}

/**
 * Count a finished game and award its Ascension XP. Returns the record as it
 * was before (so a screen can say "new best") and the award.
 */
export function addResult(mode: RecordMode, result: { won?: boolean; best?: number }): ModeRecord & { award: Award } {
  const all = loadAll();
  const before = { played: 0, won: 0, best: 0, ...all[mode] };
  all[mode] = { played: before.played + 1, won: before.won + (result.won ? 1 : 0), best: Math.max(before.best, result.best ?? 0) };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
  return { ...before, award: awardXp(gameXp(mode, result)) };
}

/** One line for the mode's card on the start screen, or '' before the first game. */
export function recordLine(mode: string): string {
  if (mode !== 'conquest' && mode !== 'clash' && mode !== 'siege' && mode !== 'duel') return '';
  const r = getRecord(mode);
  if (mode === 'siege') return r.best ? `Best: ${r.best} ${r.best === 1 ? 'wave' : 'waves'}` : '';
  return r.played ? `${r.won} ${r.won === 1 ? 'win' : 'wins'} in ${r.played} ${r.played === 1 ? 'game' : 'games'}` : '';
}
