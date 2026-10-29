import type { Team } from '../game/combatant';
import type { GodDef } from '../game/types';
import { baseOf, ConquestLayout as L, laneFrom, type LaneId, type Vec2 } from '../map/ConquestLayout';
import { minionUnit, structureUnit, type MinionType } from './factory';
import { MinionBrain, StructureBrain } from './Lanes';
import type { BaseZone, Sim } from './Sim';
import type { SimEvent, Unit } from './Unit';

export const LANES: readonly LaneId[] = ['solo', 'mid', 'duo'];
export const TEAMS: readonly Team[] = ['order', 'chaos'];
export const WAVE_INTERVAL = 30;
/** The first wave leaves this many seconds after the match starts. */
export const FIRST_WAVE = 12;
/** A destroyed Phoenix rises again after this long, at part health. */
export const PHOENIX_RESPAWN = 180;
/** Seconds between minions leaving the Phoenix in one wave. */
const SPAWN_GAP = 0.7;

export interface GodStats {
  kills: number;
  deaths: number;
  assists: number;
  minions: number;
  structures: number;
  damage: number;
}

/** A lane from a team's Phoenix on through the enemy Phoenix to the enemy Titan. */
export function marchPath(team: Team, lane: LaneId): Vec2[] {
  const enemy = baseOf(team === 'order' ? 'chaos' : 'order');
  return [...laneFrom(team, lane), enemy.titan];
}

/** The fountains as the simulation's base zones. */
export function conquestBases(): Record<Team, BaseZone> {
  const zone = (t: Team): BaseZone => {
    const b = baseOf(t);
    return { x: b.fountain[0], z: b.fountain[1], radius: L.radii.fountain };
  };
  return { order: zone('order'), chaos: zone('chaos') };
}

/**
 * A Conquest match on top of the simulation: structures, minion waves, the
 * Phoenix and Titan rules, the scoreboard and the win condition. Gods (the
 * player and bots) are added by the caller with `addGod`.
 */
export class Match {
  readonly structures = new Map<string, Unit>();
  readonly titans = {} as Record<Team, Unit>;
  readonly brains = new Map<Unit, StructureBrain>();
  readonly gods: Unit[] = [];
  readonly stats = new Map<Unit, GodStats>();
  /** Lanes where a team's minions spawn empowered because the enemy Phoenix there is down. */
  readonly empowered: Record<Team, Set<LaneId>> = { order: new Set(), chaos: new Set() };
  time = 0;
  wave = 0;
  winner: Team | null = null;
  private nextWave = FIRST_WAVE;
  private queue: { at: number; team: Team; lane: LaneId; type: MinionType; slot: number }[] = [];
  private phoenixDown = new Map<Unit, number>();

  constructor(
    readonly sim: Sim,
    /** Any god definition; structures and minions borrow its shape. */
    private readonly base: GodDef,
  ) {
    this.buildStructures();
    sim.listeners.push((e) => this.onEvent(e));
  }

  addGod(u: Unit): void {
    this.gods.push(u);
    this.stats.set(u, { kills: 0, deaths: 0, assists: 0, minions: 0, structures: 0, damage: 0 });
    if (!this.sim.units.includes(u)) this.sim.add(u);
  }

  get over(): boolean {
    return this.winner !== null;
  }

  /** Seconds until the next wave leaves the Phoenixes. */
  get untilWave(): number {
    return Math.max(0, this.nextWave - this.time);
  }

  step(dt: number): void {
    if (this.winner) return;
    this.time += dt;
    if (this.time >= this.nextWave) {
      this.queueWave();
      this.nextWave += WAVE_INTERVAL;
    }
    while (this.queue.length && this.queue[0]!.at <= this.time) this.spawn(this.queue.shift()!);
    for (const [p, at] of this.phoenixDown) {
      if (this.time - at < PHOENIX_RESPAWN) continue;
      this.phoenixDown.delete(p);
      p.combatant.respawn();
      p.combatant.health = p.combatant.stats.maxHealth * 0.4;
      this.empowered[p.team === 'order' ? 'chaos' : 'order'].delete(p.tag as LaneId);
    }
  }

  /** The structure a team must break next in a lane, or its Titan when the lane is open. */
  frontStructure(enemy: Team, lane: LaneId): Unit {
    for (const id of [`${enemy}-${lane}-outer`, `${enemy}-${lane}-inner`, `${enemy}-${lane}-phoenix`]) {
      const s = this.structures.get(id)!;
      if (s.alive) return s;
    }
    return this.titans[enemy];
  }

  // -------------------------------------------------------------------------

  private buildStructures(): void {
    const r = L.radii;
    const add = (id: string, u: Unit) => {
      u.tag = id;
      this.structures.set(id, u);
      const brain = new StructureBrain(this.sim, u);
      u.brain = brain;
      this.brains.set(u, brain);
      this.sim.add(u);
    };
    for (const t of L.towers) {
      add(t.id, structureUnit(this.base, t.team, 'tower', { x: t.at[0], z: t.at[1], yaw: 0 }, r.tower, r.towerRange));
    }
    for (const p of L.phoenixes) {
      const u = structureUnit(this.base, p.team, 'phoenix', { x: p.at[0], z: p.at[1], yaw: 0 }, r.phoenix, r.phoenixRange);
      add(p.id, u);
      u.tag = p.lane;
    }
    for (const b of L.bases) {
      const u = structureUnit(this.base, b.team, 'titan', { x: b.titan[0], z: b.titan[1], yaw: b.spawn.yaw }, r.titan, r.titanRange);
      add(`${b.team}-titan`, u);
      this.titans[b.team] = u;
    }
    // each structure is shielded while the one in front of it stands
    for (const team of TEAMS) {
      const phoenixes: Unit[] = [];
      for (const lane of LANES) {
        const outer = this.structures.get(`${team}-${lane}-outer`)!;
        const inner = this.structures.get(`${team}-${lane}-inner`)!;
        const phoenix = this.structures.get(`${team}-${lane}-phoenix`)!;
        inner.shielded = () => outer.alive;
        phoenix.shielded = () => inner.alive;
        phoenixes.push(phoenix);
      }
      // the Titan opens up once any Phoenix falls
      this.titans[team].shielded = () => phoenixes.every((p) => p.alive);
    }
  }

  private queueWave(): void {
    this.wave++;
    const types: MinionType[] = ['melee', 'melee', 'melee', 'archer', 'archer', 'archer'];
    if (this.wave % 3 === 0) types.unshift('brute');
    for (const team of TEAMS) {
      for (const lane of LANES) {
        types.forEach((type, slot) => this.queue.push({ at: this.time + slot * SPAWN_GAP, team, lane, type, slot }));
      }
    }
    this.queue.sort((a, b) => a.at - b.at);
  }

  private spawn(q: { team: Team; lane: LaneId; type: MinionType; slot: number }): void {
    const path = marchPath(q.team, q.lane);
    const start = path[0]!;
    const lateral = [-1.6, 0, 1.6][q.slot % 3]!;
    const yaw = Math.atan2(-(path[1]![0] - start[0]), -(path[1]![1] - start[1]));
    const m = minionUnit(this.base, q.team, q.type, { x: start[0], z: start[1], yaw }, { wave: this.wave, empowered: this.empowered[q.team].has(q.lane) });
    m.tag = `${q.lane}:${q.type}`;
    m.brain = new MinionBrain(this.sim, m, path, lateral);
    this.sim.add(m);
  }

  private onEvent(e: SimEvent): void {
    if (e.type === 'damage') {
      const src = e.source && (e.source.owner ?? e.source);
      const s = src && this.stats.get(src);
      if (s && e.target.team !== src.team) s.damage += e.amount;
      return;
    }
    if (e.type !== 'death') return;
    const victim = e.unit;
    const killer = e.killer;
    const ks = killer ? this.stats.get(killer) : undefined;
    if (victim.kind === 'god') {
      const vs = this.stats.get(victim);
      if (vs) vs.deaths++;
      if (ks) ks.kills++;
      for (const a of e.assists) {
        const as = this.stats.get(a);
        if (as) as.assists++;
      }
    } else if (victim.kind === 'minion') {
      if (ks) ks.minions++;
    } else if (victim.kind === 'tower' || victim.kind === 'phoenix') {
      if (ks) ks.structures++;
      if (victim.kind === 'phoenix') {
        this.phoenixDown.set(victim, this.time);
        this.empowered[victim.team === 'order' ? 'chaos' : 'order'].add(victim.tag as LaneId);
      }
    } else if (victim.kind === 'titan') {
      this.winner = victim.team === 'order' ? 'chaos' : 'order';
    }
  }
}
