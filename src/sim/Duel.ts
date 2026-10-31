import type { Side } from '../game/combatant';
import type { StatKey } from '../game/types';
import { XP_TABLE } from '../game/progression';
import { hypot } from '../core/math';
import { BOONS, type Boon } from './Siege';
import type { Sim } from './Sim';
import type { SimEvent, Unit } from './Unit';

/**
 * Temple Duel: one god against one, in rounds on the temple plaza. A round
 * ends when a god falls; the first to three rounds wins. Both gods grow two
 * levels every round, and after a short while a ring of sacred fire closes in,
 * burning whoever stands outside it, so no round can be waited out.
 */
export const DUEL = {
  rounds: 3,
  startLevel: 9,
  levelsPerRound: 2,
  startFavor: 800,
  /** Seconds before a round starts (gods are placed, healed, cooled down). */
  countdown: 3,
  /** Seconds after a god falls before the next round. */
  pause: 3,
  /** A longer break when the round's loser has a boon to choose. */
  boonPause: 7,
  ringStart: 24,
  ringEnd: 5,
  /** The ring holds still this long, then closes over ringClose seconds. */
  ringHold: 20,
  ringClose: 30,
  /** Outside the ring: this fraction of max health a second. */
  burn: 0.08,
  spawns: {
    order: { x: 0, z: 13, yaw: 0 },
    chaos: { x: 0, z: -13, yaw: Math.PI },
  },
  bases: {
    order: { x: 0, z: 62, radius: 9 },
    chaos: { x: 0, z: -62, radius: 9 },
  },
} as const;

/** The boons a duelist can be offered: Siege's stat boons (not its plaza rules). */
export const DUEL_BOONS: readonly Boon[] = BOONS.filter((b) => b.stats && !b.corruptScale && !b.cleanse);

export type DuelPhase = 'countdown' | 'fight' | 'pause' | 'over';

export class Duel {
  readonly wins: Record<Side, number> = { order: 0, chaos: 0 };
  round = 0;
  phase: DuelPhase = 'countdown';
  /** Seconds left in the countdown or pause; seconds into the round while fighting. */
  timer = 0;
  winner: Side | null = null;
  /** Who took the last round (null for a draw), for the announcement. */
  lastRound: Side | null = null;
  private readonly gods: Unit[] = [];
  /**
   * The underdog's boon: whoever loses a round (and is still in the duel)
   * picks one of three lasting boons before the next. The human side chooses
   * with `choose`; any other side picks at once.
   */
  offer: { team: Side; boons: Boon[] } | null = null;
  readonly boons: Record<Side, Boon[]> = { order: [], chaos: [] };
  /** The side a person plays, who picks their own boon; null lets every side pick by itself. */
  human: Side | null = null;

  constructor(private readonly sim: Sim) {
    sim.listeners.push((e) => this.on(e));
  }

  /** The two duelists. Call once both are in the sim; the first round's countdown starts. */
  begin(a: Unit, b: Unit): void {
    this.gods.push(a, b);
    this.startRound();
  }

  /** The ring's radius right now. */
  get ring(): number {
    if (this.phase !== 'fight') return DUEL.ringStart;
    const k = Math.min(1, Math.max(0, (this.timer - DUEL.ringHold) / DUEL.ringClose));
    return DUEL.ringStart + (DUEL.ringEnd - DUEL.ringStart) * k;
  }

  /** Seconds until the ring starts to close, 0 once it is closing. */
  get ringIn(): number {
    return this.phase === 'fight' ? Math.max(0, DUEL.ringHold - this.timer) : DUEL.ringHold;
  }

  private on(e: SimEvent): void {
    if (e.type !== 'death' || !this.gods.includes(e.unit)) return;
    // fallen duelists wait for the next round
    e.unit.combatant.respawnTimer = Infinity;
  }

  step(dt: number): void {
    if (this.phase === 'over') return;
    if (this.phase === 'countdown') {
      this.timer -= dt;
      this.hold();
      if (this.timer <= 0) {
        this.phase = 'fight';
        this.timer = 0;
      }
      return;
    }
    if (this.phase === 'pause') {
      this.timer -= dt;
      if (this.timer <= 0) this.startRound();
      return;
    }
    this.timer += dt;
    const r = this.ring;
    for (const g of this.gods) {
      if (g.alive && hypot(g.x, g.z) > r) g.combatant.takeDamage(g.combatant.stats.maxHealth * DUEL.burn * dt);
    }
    const down = this.gods.filter((g) => !g.alive);
    if (!down.length) return;
    // both falling on the same step is a draw: the round is fought again
    const taker = down.length === 1 ? (this.gods.find((g) => g.alive)!.team as Side) : null;
    this.lastRound = taker;
    if (taker) this.wins[taker]++;
    if (taker && this.wins[taker] >= DUEL.rounds) {
      this.winner = taker;
      this.phase = 'over';
      return;
    }
    this.phase = 'pause';
    this.timer = DUEL.pause;
    if (taker) this.offerBoons(taker === 'order' ? 'chaos' : 'order');
  }

  private offerBoons(team: Side): void {
    const pool = [...DUEL_BOONS];
    const boons: Boon[] = [];
    while (boons.length < 3 && pool.length) boons.push(pool.splice(Math.floor(this.sim.rng() * pool.length), 1)[0]!);
    this.offer = { team, boons };
    if (team === this.human) this.timer = DUEL.boonPause;
    else this.choose(Math.floor(this.sim.rng() * boons.length));
  }

  /** Take one of the offered boons for the side it was offered to. */
  choose(i: number): Boon | null {
    const b = this.offer?.boons[i];
    if (!b || !this.offer) return null;
    const team = this.offer.team;
    this.offer = null;
    this.boons[team].push(b);
    // once the player has chosen, the break needn't drag on
    if (team === this.human && this.phase === 'pause') this.timer = Math.min(this.timer, 2);
    for (const g of this.gods) {
      if (g.team !== team) continue;
      for (const [k, v] of Object.entries(b.stats ?? {}) as [StatKey, number][]) g.combatant.addPerk(k, v);
    }
    return b;
  }

  /** During the countdown the gods stand at their marks. */
  private hold(): void {
    for (const g of this.gods) {
      const at = DUEL.spawns[g.team as Side];
      if (g.alive) this.sim.teleport(g, at.x, at.z, at.yaw);
    }
  }

  private startRound(): void {
    // an offer left unanswered is not lost: the first boon is taken
    if (this.offer) this.choose(0);
    this.round++;
    this.phase = 'countdown';
    this.timer = DUEL.countdown;
    const level = Math.min(XP_TABLE.length, DUEL.startLevel + (this.round - 1) * DUEL.levelsPerRound);
    for (const g of this.gods) {
      const c = g.combatant;
      const at = DUEL.spawns[g.team as Side];
      g.home.x = at.x;
      g.home.z = at.z;
      g.home.yaw = at.yaw;
      const need = XP_TABLE[level - 1]! - c.xp;
      if (need > 0) c.gainXp(need);
      if (this.round === 1) c.gainFavor(DUEL.startFavor);
      c.resetCooldowns();
      if (c.alive) c.respawn();
      else c.respawnTimer = 0;
      if (c.alive) this.sim.teleport(g, at.x, at.z, at.yaw);
    }
  }
}
