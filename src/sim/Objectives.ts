import type { Side as Team } from '../game/combatant';
import { ConquestLayout as L } from '../map/ConquestLayout';
import { isBoss, type BossKind, type CampState, type Jungle } from './Jungle';
import type { Unit } from './Unit';

/** What a team needs before it starts a boss on its own: healthy gods, and their summed levels. */
export const BOSS_CALL: Record<BossKind, { gods: number; levels: number }> = {
  treasureWyrm: { gods: 3, levels: 18 },
  moltenColossus: { gods: 4, levels: 36 },
};
/** A god counts toward a call above this share of health. */
const HEALTHY = 0.6;
/** Gods this close to a pit count as there. */
const NEAR_PIT = 30;
/** Re-judge the calls this often, seconds. */
const THINK = 1;

/**
 * Each team's bot shot-calling for the jungle bosses. A team calls a boss
 * when enough healthy gods of a high enough level are up, and contests one
 * the enemy has started whenever it has a couple of healthy gods. A call
 * holds until the boss falls, the team is too thin to go on, or the enemy
 * shows up at the pit in clearly bigger numbers.
 */
export class Objectives {
  private readonly calls: Record<Team, CampState | null> = { order: null, chaos: null };
  private think = 0;

  constructor(
    private readonly jungle: Jungle,
    private readonly gods: readonly Unit[],
  ) {}

  /** The boss a team is going for right now, if any. */
  call(team: Team): CampState | null {
    return this.calls[team];
  }

  step(dt: number): void {
    this.think -= dt;
    if (this.think > 0) return;
    this.think = THINK;
    for (const team of ['order', 'chaos'] as const) this.calls[team] = this.judge(team);
  }

  /** How many of a team's gods are at a pit right now. */
  atPit(team: Team, c: CampState): number {
    const [x, z] = c.camp.at;
    return this.gods.filter((g) => g.team === team && g.alive && Math.hypot(g.x - x, g.z - z) < NEAR_PIT).length;
  }

  private judge(team: Team): CampState | null {
    const enemy: Team = team === 'order' ? 'chaos' : 'order';
    const healthy = this.gods.filter((g) => g.team === team && g.alive && g.combatant.health > g.combatant.stats.maxHealth * HEALTHY);
    const alive = this.gods.filter((g) => g.team === team && g.alive).length;
    const current = this.calls[team];
    if (current && this.jungle.alive(current)) {
      const theirs = this.atPit(enemy, current);
      const ours = this.atPit(team, current);
      if (alive >= 2 && theirs <= ours + 1) return current;
    }
    for (const c of this.jungle.camps) {
      const kind = c.camp.kind;
      if (!isBoss(kind) || !this.jungle.alive(c)) continue;
      // the enemy is on it: go take it from them
      if (c.foe && c.foe.team === enemy && healthy.length >= 2) return c;
    }
    let best: CampState | null = null;
    for (const c of this.jungle.camps) {
      const kind = c.camp.kind;
      if (!isBoss(kind) || !this.jungle.alive(c)) continue;
      const need = BOSS_CALL[kind];
      const levels = healthy.reduce((s, g) => s + g.combatant.level, 0);
      if (healthy.length < need.gods || levels < need.levels) continue;
      // don't walk into an enemy team already standing in the pit
      if (this.atPit(enemy, c) > healthy.length - 1) continue;
      // the Colossus first: its Fury is worth more than the Wyrm's gold
      if (!best || kind === 'moltenColossus') best = c;
    }
    return best;
  }
}

/** A boss pit's walkable radius. */
export const pitRadius = (c: CampState): number => (c.camp.team === null ? L.radii.boss : L.radii.camp);
