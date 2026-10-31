import type { Side } from '../game/combatant';
import { hypot } from '../core/math';
import { GodBot } from './Bot';
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
  /** The Sun Relic: a prize beside the plaza that pulls fights off the center. */
  relic: {
    first: 25,
    /** Seconds after a claim before the next relic rises. */
    every: 35,
    /** It alternates between the plaza's two flanks. */
    spots: [{ x: 24, z: 0 }, { x: -24, z: 0 }],
    radius: 3.5,
    /** Seconds a god must stand on it, with no enemy god beside, to claim it. */
    claim: 2,
    points: 8,
    damage: 0.15,
    heal: 0.2,
    time: 20,
  },
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

export interface Relic {
  x: number;
  z: number;
  /** 0 to 1: how far the current claimer has got. */
  progress: number;
  /** The team claiming it right now, if any. */
  claimer: Side | null;
}

export type PlazaState = 'neutral' | 'contested' | Side;

export class Clash {
  readonly score: Record<Side, number> = { order: 0, chaos: 0 };
  plaza: PlazaState = 'neutral';
  winner: Side | null = null;
  /** Takedowns per team, for the scoreboard. */
  readonly kills: Record<Side, number> = { order: 0, chaos: 0 };
  private time = 0;
  /** The relic on the field, or null while the next one waits to rise. */
  relic: Relic | null = null;
  /** Seconds until the next relic rises (while none is on the field). */
  relicIn: number = CLASH.relic.first;
  private relicCount = 0;
  /** Seconds left on each team's relic blessing. */
  readonly relicBuff: Record<Side, number> = { order: 0, chaos: 0 };
  /** The last team to claim a relic, for the herald and the HUD. */
  lastClaim: Side | null = null;
  /** Bots sent after the relic, with the anchor to return them to. */
  private readonly runners = new Map<Unit, { x: number; z: number }>();

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
    for (const t of ['order', 'chaos'] as const) this.relicBuff[t] = Math.max(0, this.relicBuff[t] - dt);
    this.stepRelic(dt);
  }

  private stepRelic(dt: number): void {
    const R = CLASH.relic;
    if (!this.relic) {
      this.relicIn -= dt;
      if (this.relicIn > 0) return;
      const at = R.spots[this.relicCount++ % R.spots.length]!;
      this.relic = { x: at.x, z: at.z, progress: 0, claimer: null };
    }
    const relic = this.relic;
    this.sendRunners(relic);
    const near = { order: 0, chaos: 0 };
    for (const u of this.sim.units) {
      if (u.kind !== 'god' || !u.alive || u.team === 'neutral') continue;
      if (hypot(u.x - relic.x, u.z - relic.z) <= R.radius) near[u.team]++;
    }
    const team: Side | null = near.order && !near.chaos ? 'order' : near.chaos && !near.order ? 'chaos' : null;
    if (near.order && near.chaos) return; // contested: progress holds
    if (!team) {
      relic.progress = Math.max(0, relic.progress - dt / R.claim);
      if (relic.progress === 0) relic.claimer = null;
      return;
    }
    // a new team stepping on it starts from nothing
    if (relic.claimer !== team) relic.progress = 0;
    relic.claimer = team;
    relic.progress = Math.min(1, relic.progress + dt / R.claim);
    if (relic.progress >= 1) this.claimRelic(team);
  }

  private claimRelic(team: Side): void {
    const R = CLASH.relic;
    this.relic = null;
    this.relicIn = R.every;
    this.lastClaim = team;
    this.relicBuff[team] = R.time;
    this.add(team, R.points * this.mult);
    for (const u of this.sim.units) {
      if (u.kind !== 'god' || u.team !== team || !u.alive) continue;
      u.combatant.refreshTimedMod('damageBonus', R.damage, R.time);
      u.combatant.heal(u.combatant.stats.maxHealth * R.heal);
    }
    this.recallRunners();
  }

  /** Each team sends its nearest bot after the relic; the rest keep the plaza. */
  private sendRunners(relic: Relic): void {
    for (const team of ['order', 'chaos'] as const) {
      let mine: Unit | null = null;
      for (const [u] of this.runners) if (u.team === team) mine = u;
      if (mine?.alive) continue;
      if (mine) this.release(mine);
      let best: Unit | null = null;
      let bestD = Infinity;
      for (const u of this.sim.units) {
        if (u.kind !== 'god' || u.team !== team || !u.alive || !(u.brain instanceof GodBot)) continue;
        const d = hypot(u.x - relic.x, u.z - relic.z);
        if (d < bestD) [best, bestD] = [u, d];
      }
      if (!best) continue;
      const anchor = (best.brain as GodBot).options.anchor;
      this.runners.set(best, { x: anchor.x, z: anchor.z });
      anchor.x = relic.x;
      anchor.z = relic.z;
    }
  }

  private release(u: Unit): void {
    const home = this.runners.get(u);
    if (home && u.brain instanceof GodBot) Object.assign(u.brain.options.anchor, home);
    this.runners.delete(u);
  }

  private recallRunners(): void {
    for (const u of [...this.runners.keys()]) this.release(u);
  }
}
