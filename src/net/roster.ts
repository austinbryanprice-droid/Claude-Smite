import type { Side } from '../game/combatant';
import { GODS } from '../game/gods';
import { ROLES, type BotRole } from '../sim/LaneBot';

/** Co-op puts every human on Order against bots; versus splits the humans across both teams. */
export type NetMode = 'coop' | 'versus';

export interface NetPlayer {
  /** The player's peer id. */
  id: string;
  name: string;
  god: string;
  team: Side;
}

/** One of a match's ten god slots, played by a human (their player id) or a bot. */
export interface Slot {
  team: Side;
  /** Place in the fountain line-up (see spawnPoint), which also picks a bot's lane. */
  spot: number;
  god: string;
  role: BotRole;
  player: string | null;
}

export const TEAM_SIZE = 5;
/** Humans take spots in this order: mid, solo, roam, then the two duo spots. */
const HUMAN_SPOTS = [1, 0, 4, 2, 3];

/**
 * Who plays which slot. Both ends of a networked match build their gods
 * from this, in this order, so the same slot is the same god everywhere.
 * Bots play gods no human on their team picked.
 */
export function roster(players: readonly NetPlayer[]): Slot[] {
  const slots: Slot[] = [];
  for (const team of ['order', 'chaos'] as const) {
    const humans = players.filter((p) => p.team === team).slice(0, TEAM_SIZE);
    const bySpot = new Map(humans.map((p, i) => [HUMAN_SPOTS[i]!, p]));
    const used = new Set(humans.map((p) => p.god));
    const free = GODS.map((g) => g.id).filter((id) => !used.has(id));
    let next = 0;
    for (let spot = 0; spot < TEAM_SIZE; spot++) {
      const p = bySpot.get(spot);
      const god = p ? p.god : free.length ? free[next++ % free.length]! : GODS[spot]!.id;
      slots.push({ team, spot, god, role: ROLES[spot]!, player: p?.id ?? null });
    }
  }
  return slots;
}

/** The team a player joining a lobby starts on. */
export function teamFor(mode: NetMode, players: readonly NetPlayer[]): Side {
  if (mode === 'coop') return 'order';
  const order = players.filter((p) => p.team === 'order').length;
  const chaos = players.length - order;
  return chaos < order ? 'chaos' : 'order';
}
