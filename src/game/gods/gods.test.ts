import { describe, expect, it } from 'vitest';
import { validateLoadout } from '../loadout';
import { TIER_REQUIREMENT } from '../trees';
import { GODS } from './index';

describe.each(GODS.map((g) => [g.name, g] as const))('%s data', (_, god) => {
  it('has 8 regular skills and 3 ultimates with unique, prefixed ids', () => {
    expect(god.skills.filter((s) => s.kind === 'regular')).toHaveLength(8);
    expect(god.skills.filter((s) => s.kind === 'ultimate')).toHaveLength(3);
    const ids = god.skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(`${god.id}.`)).toBe(true);
  });

  it('has a valid default loadout', () => {
    expect(validateLoadout(god, god.defaultLoadout)).toBeNull();
  });

  it('has three trees of ten nodes with one keystone each', () => {
    expect(god.trees).toHaveLength(3);
    for (const tree of god.trees) {
      expect(tree.nodes).toHaveLength(10);
      const keystones = tree.nodes.filter((n) => n.effects.some((e) => e.type === 'keystone'));
      expect(keystones).toHaveLength(1);
      expect(keystones[0]!.tier).toBe(4);
    }
  });

  it('can reach every tier, and each keystone needs a real commitment', () => {
    for (const tree of god.trees) {
      for (const tier of [2, 3, 4] as const) {
        const below = tree.nodes.filter((n) => n.tier < tier).reduce((a, n) => a + n.maxRank, 0);
        expect(below).toBeGreaterThanOrEqual(TIER_REQUIREMENT[tier]);
      }
    }
  });

  it('only modifies skills that exist', () => {
    const ids = new Set(god.skills.map((s) => s.id));
    for (const tree of god.trees)
      for (const node of tree.nodes)
        for (const e of node.effects) if (e.type === 'skill') expect(ids.has(e.skill), `${node.id} -> ${e.skill}`).toBe(true);
  });

  it('has unique node ids across its trees', () => {
    const ids = god.trees.flatMap((t) => t.nodes.map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
