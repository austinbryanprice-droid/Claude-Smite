import { beforeEach, describe, expect, it } from 'vitest';
import { awardLine, awardXp, gameXp, getXp, rankBadge, rankNeed, rankOf, RANKS } from './ascension';
import { addResult } from './records';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});

describe('Ascension', () => {
  it('climbs ranks, each a little longer than the last', () => {
    expect(rankOf(0)).toEqual({ level: 1, title: 'Mortal', into: 0, need: rankNeed(1) });
    expect(rankOf(rankNeed(1)).level).toBe(2);
    expect(rankOf(rankNeed(1) + rankNeed(2) - 1)).toMatchObject({ level: 2, into: rankNeed(2) - 1 });
    expect(rankNeed(5)).toBeGreaterThan(rankNeed(4));
    expect(rankOf(1e7).title).toBe(RANKS[RANKS.length - 1]);
  });

  it('pays for playing, double for winning, and per wave in Siege', () => {
    expect(gameXp('clash', { won: true })).toBe(2 * gameXp('clash', { won: false }));
    expect(gameXp('siege', { best: 10 })).toBe(10 * gameXp('siege', { best: 1 }));
    expect(gameXp('conquest', {})).toBeGreaterThan(gameXp('duel', {}));
  });

  it('every finished game adds to it, and the end screen says when a rank is gained', () => {
    expect(rankBadge()).toBe('');
    const { award } = addResult('conquest', { won: true });
    expect(getXp()).toBe(400);
    expect(award.after.level).toBe(2);
    expect(awardLine(award)).toContain('Rank up: Initiate');
    expect(awardLine(awardXp(10))).not.toContain('Rank up');
    expect(rankBadge()).toContain('Initiate');
  });
});
