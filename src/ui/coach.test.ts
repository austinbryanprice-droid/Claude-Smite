import { describe, expect, it } from 'vitest';
import { pickTip, type CoachView } from './Coach';

const base: CoachView = { alive: true, healthPct: 1, unspentPoints: 0, ultReady: false, inBase: false, respawned: false, menuOpen: false };

describe('coach tips', () => {
  it('shows nothing when nothing matters yet', () => {
    expect(pickTip(base, new Set())).toBeNull();
  });

  it('points to the skill trees when there are points to spend, once', () => {
    const v = { ...base, unspentPoints: 1 };
    expect(pickTip(v, new Set())?.id).toBe('points');
    expect(pickTip(v, new Set(['points']))).toBeNull();
    expect(pickTip({ ...v, menuOpen: true }, new Set())).toBeNull();
  });

  it('death comes first, then the ultimate, then low health', () => {
    expect(pickTip({ ...base, alive: false, unspentPoints: 2 }, new Set())?.id).toBe('death');
    expect(pickTip({ ...base, ultReady: true, healthPct: 0.1 }, new Set())?.id).toBe('ult');
    expect(pickTip({ ...base, healthPct: 0.1 }, new Set())?.id).toBe('lowhp');
    expect(pickTip({ ...base, healthPct: 0.1, inBase: true }, new Set())).toBeNull();
  });

  it('offers the skill swap only back at the fountain after a respawn', () => {
    expect(pickTip({ ...base, inBase: true }, new Set())).toBeNull();
    expect(pickTip({ ...base, inBase: true, respawned: true }, new Set())?.id).toBe('swap');
  });
});
