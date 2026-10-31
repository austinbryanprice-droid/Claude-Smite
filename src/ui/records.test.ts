import { beforeEach, describe, expect, it } from 'vitest';
import { addResult, getRecord, recordLine } from './records';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});

describe('mode records', () => {
  it('says nothing before the first game, then counts wins', () => {
    expect(recordLine('clash')).toBe('');
    addResult('clash', { won: true });
    addResult('clash', { won: false });
    expect(getRecord('clash')).toEqual({ played: 2, won: 1, best: 0 });
    expect(recordLine('clash')).toBe('1 win in 2 games');
    expect(recordLine('arena')).toBe('');
  });

  it('keeps the best Siege run and returns the record from before', () => {
    expect(addResult('siege', { best: 7 }).best).toBe(0);
    expect(addResult('siege', { best: 4 }).best).toBe(7);
    expect(recordLine('siege')).toBe('Best: 7 waves');
  });

  it('carries over the Siege best saved before records existed', () => {
    store.set('ascendant.siegeBest', '12');
    expect(getRecord('siege').best).toBe(12);
  });
});
