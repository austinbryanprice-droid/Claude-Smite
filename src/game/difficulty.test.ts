import { describe, expect, it } from 'vitest';
import { difficultyPerks, parseDifficulty } from './difficulty';

describe('difficulty', () => {
  it('normal changes nothing; easy softens foes, hard toughens them', () => {
    expect(difficultyPerks('normal')).toEqual({ foe: {}, team: {} });
    expect(difficultyPerks('easy').foe.damageBonus).toBeLessThan(0);
    expect(difficultyPerks('hard').foe.damageBonus).toBeGreaterThan(0);
  });

  it('in Siege only the team changes, and never with negative damage reduction (it is clamped at zero)', () => {
    for (const d of ['easy', 'hard'] as const) {
      const p = difficultyPerks(d, true);
      expect(p.foe).toEqual({});
      expect(p.team.damageReduction ?? 0).toBeGreaterThanOrEqual(0);
    }
    expect(difficultyPerks('easy', true).team.damageBonus).toBeGreaterThan(0);
    expect(difficultyPerks('hard', true).team.damageBonus).toBeLessThan(0);
  });

  it('anything unknown reads as normal', () => {
    expect(parseDifficulty('hard')).toBe('hard');
    expect(parseDifficulty(null)).toBe('normal');
    expect(parseDifficulty('nightmare')).toBe('normal');
  });
});
