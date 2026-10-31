import type { Side } from '../game/combatant';
import { hypot } from '../core/math';
import type { Sim } from './Sim';
import type { SimEvent, Unit } from './Unit';

/**
 * Temple Clash: a short 3v3 fight over the temple plaza. A team scores while
 * it stands on the plaza alone, and for every god it takes down; the first
 * team to the target wins. Everyone starts mid-game and levels fast, so tree
 * keystones come into play within a few minutes.
 */
export const CLASH = {
  target: 115,
  /** Points a second while a team holds the plaza alone. */
  holdRate: 1,
  killPoints: 5,
  /** The plaza counts out to this radius from the temple's center. */
  plazaRadius: 17,
  respawn: 6,
  startLevel: 8,
  /** Passive XP and Favor a second for every god, so a match reaches level 20. */
  xpRate: 24,
  favorRate: 14,
  startFavor: 700,
  /** Every so often the temple's blessing descends: points count double for a while. */
  blessingEvery: 70,
  blessingLength: 20,
  bases: {
    order: { x: 0, z: 62, radius: 9 },
    chaos: { x: 0, z: -62, radius: 9 },
  },
} as const;

/** Where each team's gods start: around their base, facing the temple. */
export const CLASH_SPAWNS = {
  order: [-4, 0, 4].map((x) => ({ x, z: 58, yaw: 0 })),
  chaos: [-4, 0, 4].map((x) => ({ x, z: -58, yaw: Math.PI })),
} as const;

export type PlazaState = 'neutral' | 'contested' | Side;

export class Clash {
  readonly score: Record<Side, number> = { order: 0, chaos: 0 };
  plaza: PlazaState = 'neutral';
  winner: Side | null = null;
  /** Takedowns per team, for the scoreboard. */
  readonly kills: Record<Side, number> = { order: 0, chaos: 0 };
  private time = 0;

  /** Seconds left on the blessing (points count double), 0 when none. */
  get blessing(): number {
    const t = this.time % CLASH.blessingEvery;
    const start = CLASH.blessingEvery - CLASH.blessingLength;
    return this.time >= start && t >= start ? CLASH.blessingEvery - t : 0;
  }

  /** Seconds until the next blessing begins. */
  get blessingIn(): number {
    const start = CLASH.blessingEvery - CLASH.blessingLength;
    const t = this.time % CLASH.blessingEvery;
    return t < start ? start - t : start + CLASH.blessingEvery - t;
  }

  private get mult(): number {
    return this.blessing > 0 ? 2 : 1;
  }

  constructor(private readonly sim: Sim) {
    sim.listeners.push((e) => this.on(e));
  }

  private on(e: SimEvent): void {
    if (e.type !== 'death' || e.unit.kind !== 'god') return;
    // short respawns keep everyone fighting
    e.unit.combatant.respawnTimer = Math.min(e.unit.combatant.respawnTimer, CLASH.respawn);
    const killer = e.killer ? (e.killer.owner ?? e.killer) : null;
    if (!killer || killer.team === e.unit.team || killer.team === 'neutral' || this.winner) return;
    this.kills[killer.team]++;
    this.add(killer.team, CLASH.killPoints * this.mult);
  }

  private add(team: Side, points: number): void {
    if (this.winner) return;
    this.score[team] = Math.min(CLASH.target, this.score[team] + points);
    if (this.score[team] >= CLASH.target) this.winner = team;
  }

  /** Gods of each team standing on the plaza. */
  onPlaza(units: readonly Unit[]): Record<Side, number> {
    const n = { order: 0, chaos: 0 };
    for (const u of units) {
      if (u.kind !== 'god' || !u.alive || u.team === 'neutral') continue;
      if (hypot(u.x, u.z) <= CLASH.plazaRadius) n[u.team]++;
    }
    return n;
  }

  step(dt: number): void {
    if (this.winner) return;
    this.time += dt;
    const n = this.onPlaza(this.sim.units);
    this.plaza = n.order && n.chaos ? 'contested' : n.order ? 'order' : n.chaos ? 'chaos' : 'neutral';
    if (this.plaza === 'order' || this.plaza === 'chaos') this.add(this.plaza, CLASH.holdRate * this.mult * dt);
    for (const u of this.sim.units) {
      if (u.kind !== 'god' || !u.alive) continue;
      this.sim.grant(u, CLASH.xpRate * dt, CLASH.favorRate * dt);
    }
  }
}
