import { Combatant, type Team } from '../game/combatant';
import type { GodDef } from '../game/types';
import { Unit, type Body, type Point } from './Unit';

export const GOD_RADIUS = 0.6;

/** A plain body for units the simulation moves itself. */
export function body(x: number, z: number, yaw = 0): Body {
  return { x, y: 0, z, yaw };
}

export function godUnit(god: GodDef, team: Team, home: { x: number; z: number; yaw: number }, b: Body = body(home.x, home.z, home.yaw)): Unit {
  return new Unit('god', god.name, new Combatant(god, team), b, GOD_RADIUS, home);
}

/**
 * Non-god units borrow a god's definition (the rules engine needs a full
 * GodDef) with their own stats. They never cast, so the loadout is unused.
 */
function variant(base: GodDef, id: string, name: string, stats: Partial<GodDef['base']>): GodDef {
  return {
    ...base,
    id,
    name,
    base: { ...base.base, healthRegen: 0, manaRegen: 0, moveSpeed: 0, ...stats },
    growth: {},
  };
}

/** A training post: sturdy, does not move or fight back, and stands again 8 s after it breaks. */
export function dummyUnit(base: GodDef, team: Team, at: { x: number; z: number; yaw: number }): Unit {
  const def = variant(base, 'training-dummy', 'Training Dummy', {
    maxHealth: 1400,
    physicalProtection: 20,
    magicalProtection: 20,
  });
  return new Unit('dummy', def.name, new Combatant(def, team), body(at.x, at.z, at.yaw), 0.55, at);
}

const SUMMONS: Record<string, { name: string; health: number; speed: number }> = {
  decoy: { name: 'Decoy', health: 200, speed: 0 },
  'mirror-copy': { name: 'Mirror Copy', health: 250, speed: 0 },
  einherjar: { name: 'Einherjar', health: 400, speed: 340 },
};

export function summonUnit(owner: Unit, kind: string, at: Point, index: number): Unit {
  const info = SUMMONS[kind] ?? { name: kind, health: 200, speed: 0 };
  const def = variant(owner.combatant.god, `summon:${kind}`, info.name, { maxHealth: info.health, moveSpeed: info.speed });
  // spread copies around the spot so they don't stack
  const angle = owner.body.yaw + Math.PI / 2 + index * Math.PI;
  const spread = kind === 'decoy' ? 0 : 1.6;
  const x = at.x + Math.sin(angle) * spread;
  const z = at.z + Math.cos(angle) * spread;
  return new Unit('summon', info.name, new Combatant(def, owner.team), body(x, z, owner.body.yaw), 0.55, { x, z, yaw: owner.body.yaw });
}
