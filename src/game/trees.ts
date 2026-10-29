import type { GodDef, Keystone, SkillModField, SkillTree, StatKey, TreeNode } from './types';

/** Points that must already be spent in a tree before a node of this tier opens. */
export const TIER_REQUIREMENT: Record<TreeNode['tier'], number> = { 1: 0, 2: 5, 3: 10, 4: 15 };

/** Ranks per node id, across all three of a god's trees. */
export type Allocation = Readonly<Record<string, number>>;

export type AllocationError =
  | 'unknownNode'
  | 'maxRank'
  | 'noPoints'
  | 'tierLocked'
  | 'needsPrereq'
  | 'notAllocated'
  | 'wouldBreakTier';

export interface TreeIndex {
  node: Map<string, { node: TreeNode; tree: SkillTree }>;
}

export function indexTrees(god: GodDef): TreeIndex {
  const node = new Map<string, { node: TreeNode; tree: SkillTree }>();
  for (const tree of god.trees) for (const n of tree.nodes) node.set(n.id, { node: n, tree });
  return { node };
}

export function pointsSpent(alloc: Allocation): number {
  let total = 0;
  for (const r of Object.values(alloc)) total += r;
  return total;
}

export function pointsInTree(index: TreeIndex, alloc: Allocation, treeId: string, belowTier = 5): number {
  let total = 0;
  for (const [id, r] of Object.entries(alloc)) {
    const entry = index.node.get(id);
    if (entry && entry.tree.id === treeId && entry.node.tier < belowTier) total += r;
  }
  return total;
}

/** True when the node has no prerequisite, or that prerequisite is maxed. */
export function prereqMet(index: TreeIndex, alloc: Allocation, node: TreeNode): boolean {
  if (!node.requires) return true;
  const req = index.node.get(node.requires);
  return !!req && (alloc[node.requires] ?? 0) >= req.node.maxRank;
}

/** Every allocated node's tier requirement and prerequisite are met. */
export function isValidAllocation(index: TreeIndex, alloc: Allocation, budget: number): boolean {
  if (pointsSpent(alloc) > budget) return false;
  for (const [id, r] of Object.entries(alloc)) {
    if (r === 0) continue;
    const entry = index.node.get(id);
    if (!entry || r < 0 || r > entry.node.maxRank) return false;
    const need = TIER_REQUIREMENT[entry.node.tier];
    if (pointsInTree(index, alloc, entry.tree.id, entry.node.tier) < need) return false;
    if (!prereqMet(index, alloc, entry.node)) return false;
  }
  return true;
}

export function addPoint(
  index: TreeIndex,
  alloc: Allocation,
  nodeId: string,
  budget: number,
): { ok: true; alloc: Allocation } | { ok: false; error: AllocationError } {
  const entry = index.node.get(nodeId);
  if (!entry) return { ok: false, error: 'unknownNode' };
  const rank = alloc[nodeId] ?? 0;
  if (rank >= entry.node.maxRank) return { ok: false, error: 'maxRank' };
  if (pointsSpent(alloc) >= budget) return { ok: false, error: 'noPoints' };
  if (pointsInTree(index, alloc, entry.tree.id, entry.node.tier) < TIER_REQUIREMENT[entry.node.tier]) {
    return { ok: false, error: 'tierLocked' };
  }
  if (!prereqMet(index, alloc, entry.node)) return { ok: false, error: 'needsPrereq' };
  return { ok: true, alloc: { ...alloc, [nodeId]: rank + 1 } };
}

export function removePoint(
  index: TreeIndex,
  alloc: Allocation,
  nodeId: string,
  budget: number,
): { ok: true; alloc: Allocation } | { ok: false; error: AllocationError } {
  if (!index.node.has(nodeId)) return { ok: false, error: 'unknownNode' };
  const rank = alloc[nodeId] ?? 0;
  if (rank === 0) return { ok: false, error: 'notAllocated' };
  const next: Record<string, number> = { ...alloc, [nodeId]: rank - 1 };
  if (next[nodeId] === 0) delete next[nodeId];
  if (!isValidAllocation(index, next, budget)) return { ok: false, error: 'wouldBreakTier' };
  return { ok: true, alloc: next };
}

export interface SkillMods {
  damagePct: number;
  cooldownPct: number;
  costPct: number;
  radiusPct: number;
  rangePct: number;
  ccDurationPct: number;
  extraHits: number;
  extraBounces: number;
}

export function emptySkillMods(): SkillMods {
  return {
    damagePct: 0,
    cooldownPct: 0,
    costPct: 0,
    radiusPct: 0,
    rangePct: 0,
    ccDurationPct: 0,
    extraHits: 0,
    extraBounces: 0,
  };
}

/** Everything an allocation grants, flattened for fast lookups during combat. */
export interface TreeBonuses {
  stats: Partial<Record<StatKey, number>>;
  skills: Record<string, SkillMods>;
  keystones: Keystone[];
}

export function treeBonuses(index: TreeIndex, alloc: Allocation): TreeBonuses {
  const out: TreeBonuses = { stats: {}, skills: {}, keystones: [] };
  for (const [id, rank] of Object.entries(alloc)) {
    const entry = index.node.get(id);
    if (!entry || rank <= 0) continue;
    for (const e of entry.node.effects) {
      if (e.type === 'stat') {
        out.stats[e.stat] = (out.stats[e.stat] ?? 0) + e.perRank * rank;
      } else if (e.type === 'skill') {
        const mods = (out.skills[e.skill] ??= emptySkillMods());
        mods[e.field satisfies SkillModField] += e.perRank * rank;
      } else {
        out.keystones.push(e.keystone);
      }
    }
  }
  return out;
}
