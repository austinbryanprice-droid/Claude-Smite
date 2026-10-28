// Small helpers that keep god files short and readable.
import type {
  CCKind,
  DamageType,
  Effect,
  EffectTarget,
  Keystone,
  NodeEffect,
  Ranked,
  ScalingStat,
  SkillModField,
  SkillTree,
  StatKey,
  TreeNode,
} from '../types';

export const dmg = (
  amount: Ranked,
  scaling: ScalingStat,
  ratio: number,
  damageType: DamageType,
  hits?: number,
  interval?: number,
): Effect => ({ kind: 'damage', amount, scaling, ratio, damageType, hits, interval });

export const cc = (kind: CCKind, duration: Ranked, magnitude?: Ranked): Effect => ({
  kind: 'cc',
  cc: kind,
  duration,
  magnitude,
});

export const slow = (magnitude: Ranked, duration: Ranked): Effect => cc('slow', duration, magnitude);

export const buff = (stat: StatKey, amount: Ranked, duration: number, target: EffectTarget = 'self'): Effect => ({
  kind: 'buff',
  stat,
  amount,
  duration,
  target,
});

export const debuff = (stat: StatKey, amount: Ranked, duration: number): Effect => ({
  kind: 'debuff',
  stat,
  amount,
  duration,
});

export const heal = (amount: Ranked, scaling: ScalingStat, ratio: number, target: EffectTarget = 'self'): Effect => ({
  kind: 'heal',
  amount,
  scaling,
  ratio,
  target,
});

export const shield = (
  amount: Ranked,
  scaling: ScalingStat,
  ratio: number,
  duration: number,
  target: EffectTarget = 'self',
): Effect => ({ kind: 'shield', amount, scaling, ratio, duration, target });

export const move = (style: 'dash' | 'leap' | 'blink', distance: number): Effect => ({
  kind: 'movement',
  style,
  distance,
});

export const stealth = (duration: number): Effect => ({ kind: 'stealth', duration });
export const summon = (unit: string, duration: number): Effect => ({ kind: 'summon', unit, duration });
export const mark = (name: string, duration: number, stacks?: number): Effect => ({
  kind: 'mark',
  mark: name,
  duration,
  stacks,
});

// ---------------------------------------------------------------------------
// Trees

export const stat = (s: StatKey, perRank: number): NodeEffect => ({ type: 'stat', stat: s, perRank });
export const mod = (skill: string, field: SkillModField, perRank: number): NodeEffect => ({
  type: 'skill',
  skill,
  field,
  perRank,
});
export const keystone = (k: Keystone): NodeEffect => ({ type: 'keystone', keystone: k });

export function node(
  id: string,
  name: string,
  tier: TreeNode['tier'],
  maxRank: number,
  description: string,
  ...effects: NodeEffect[]
): TreeNode {
  return { id, name, tier, maxRank, description, effects };
}

/** Prefixes node ids with the tree id so ids are unique per god. */
export function tree(id: string, name: string, theme: string, nodes: TreeNode[]): SkillTree {
  return { id, name, theme, nodes: nodes.map((n) => ({ ...n, id: `${id}.${n.id}` })) };
}
