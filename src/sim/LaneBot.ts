import type { Team } from '../game/combatant';
import { alongPolyline, baseOf, nearestOnPolyline, type LaneId, type Vec2 } from '../map/ConquestLayout';
import { GodBot } from './Bot';
import { LANES, marchPath, type Match } from './Match';
import type { Sim } from './Sim';
import { isStructure, WORLD_SCALE, type Brain, type Point, type Unit } from './Unit';

export type BotRole = LaneId | 'roam';

/** How far a laning bot looks for a fight. */
const AGGRO = 16;
/** How far from the lane it will chase. */
const LEASH = 26;
/** A unit farther than this from the lane centerline is off the lane. */
const OFF_LANE = 11;

/**
 * A god bot that plays Conquest: it walks to its lane, stands behind its
 * minion wave, last-hits and trades with enemy gods, stays out of enemy tower
 * range unless its minions are tanking, hits structures with its wave, and
 * recalls when low. A roamer drifts between lanes.
 */
export class LaneBot implements Brain {
  readonly bot: GodBot;
  private lane: LaneId;
  private path: readonly Vec2[];
  private anchor: Point;
  private think = 0;
  private roamTimer = 0;

  constructor(
    private readonly sim: Sim,
    private readonly match: Match,
    private readonly u: Unit,
    readonly role: BotRole,
    aggression = 0.45,
  ) {
    this.lane = role === 'roam' ? 'mid' : role;
    this.path = marchPath(u.team, this.lane);
    this.anchor = { x: this.path[0]![0], z: this.path[0]![1] };
    this.bot = new GodBot(sim, u, {
      anchor: this.anchor,
      leash: LEASH,
      aggro: AGGRO,
      aggression,
      recall: true,
      choose: () => this.choose(),
      route: (goal) => this.route(goal),
    });
  }

  get currentLane(): LaneId {
    return this.lane;
  }

  update(dt: number): void {
    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.3;
      if (this.role === 'roam') this.roam(dt + 0.3);
      this.placeAnchor();
    }
    this.bot.update(dt);
  }

  private get enemy(): Team {
    return this.u.team === 'order' ? 'chaos' : 'order';
  }

  private roam(elapsed: number): void {
    this.roamTimer -= elapsed;
    if (this.roamTimer > 0) return;
    this.roamTimer = 50 + this.sim.rng() * 30;
    this.lane = LANES[Math.floor(this.sim.rng() * LANES.length)]!;
    this.path = marchPath(this.u.team, this.lane);
  }

  private along(x: number, z: number): number {
    return nearestOnPolyline(this.path, x, z).along;
  }

  /** Stand a few meters behind the wave, never inside an enemy structure's range without minions there. */
  private placeAnchor(): void {
    const { sim, u } = this;
    let front = -Infinity;
    for (const m of sim.units) {
      if (m.kind !== 'minion' || !m.alive || m.team !== u.team) continue;
      const n = nearestOnPolyline(this.path, m.x, m.z);
      if (n.distance < OFF_LANE) front = Math.max(front, n.along);
    }
    const structure = this.match.frontStructure(this.enemy, this.lane);
    const sAlong = this.along(structure.x, structure.z);
    const safe = this.covered(structure) ? sAlong - 3 : sAlong - this.rangeOf(structure) - 3;
    let goal: number;
    if (front > -Infinity) goal = Math.min(front - 4, safe);
    else {
      // no wave: hold just in front of our own first standing structure
      const own = this.match.frontStructure(u.team, this.lane);
      goal = Math.min(this.along(own.x, own.z) + 8, safe);
    }
    const p = alongPolyline(this.path, Math.max(0, goal));
    this.anchor.x = p[0];
    this.anchor.z = p[1];
    this.bot.options.anchor = this.anchor;
  }

  private rangeOf(s: Unit): number {
    return s.combatant.god.basicAttack.range * WORLD_SCALE + s.radius;
  }

  /** Allied minions are inside the structure's range, so it will shoot them first. */
  private covered(s: Unit): boolean {
    const reach = this.rangeOf(s);
    return this.sim.units.some((m) => m.kind === 'minion' && m.alive && m.team === this.u.team && Math.hypot(m.x - s.x, m.z - s.z) <= reach);
  }

  /** Inside a standing enemy structure's range with nothing of ours there to draw its fire. */
  private underTower(x: number, z: number): boolean {
    for (const s of this.match.structures.values()) {
      if (s.team === this.u.team || !s.alive) continue;
      if (Math.hypot(x - s.x, z - s.z) > this.rangeOf(s) + 1) continue;
      if (!this.covered(s)) return true;
    }
    return false;
  }

  private choose(): Unit | null {
    const { sim, u } = this;
    const c = u.combatant;
    const hp = c.health / c.stats.maxHealth;
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (const t of sim.enemiesOf(u)) {
      if (t.kind === 'dummy' || t.stealth > 0) continue;
      const d = Math.hypot(t.x - u.x, t.z - u.z) - t.radius;
      if (d > AGGRO) continue;
      if (Math.hypot(t.x - this.anchor.x, t.z - this.anchor.z) > LEASH) continue;
      const tc = t.combatant;
      const thp = tc.health / tc.stats.maxHealth;
      // don't follow anything under a tower unless it is about to die and we are healthy
      if (!isStructure(t) && this.underTower(t.x, t.z) && !(t.kind === 'god' && thp < 0.25 && hp > 0.6)) continue;
      let score: number;
      if (t.kind === 'god') {
        if (hp < 0.4 && thp > hp) continue;
        score = d - (1 - thp) * 12;
      } else if (t.kind === 'minion' || t.kind === 'summon') {
        // farm: prefer low minions (last hits)
        score = 20 + d + thp * 6;
      } else {
        if (t.shielded() || !this.covered(t)) continue;
        score = 30 + d;
      }
      if (score < bestScore) {
        best = t;
        bestScore = score;
      }
    }
    return best;
  }

  /** Walk along the lane instead of cutting through the jungle walls. */
  private route(goal: Point): Point {
    const { u } = this;
    const me = nearestOnPolyline(this.path, u.x, u.z);
    const there = nearestOnPolyline(this.path, goal.x, goal.z);
    if (me.distance > OFF_LANE) {
      // get onto the lane at its closest point, unless the goal is nearer
      if (Math.hypot(goal.x - u.x, goal.z - u.z) < me.distance) return goal;
      const p = alongPolyline(this.path, me.along);
      return { x: p[0], z: p[1] };
    }
    const target = there.distance > OFF_LANE ? 0 : there.along;
    // close enough along the lane (or at its start, heading home): go straight there
    if (Math.abs(target - me.along) < 6) return goal;
    const step = Math.sign(target - me.along) * 8;
    const p = alongPolyline(this.path, me.along + step);
    return { x: p[0], z: p[1] };
  }
}

export const isLaneBot = (b: Brain | null): b is LaneBot => b instanceof LaneBot;

/** Where each god in a team stands at the fountain, spread so they don't overlap. */
export function spawnPoint(team: Team, index: number): { x: number; z: number; yaw: number } {
  const b = baseOf(team);
  const side = (index - 2) * 2.2;
  return { x: b.spawn.x + side, z: b.spawn.z, yaw: b.spawn.yaw };
}

/** The lane each slot of a five-god team plays: solo, mid, two in duo, and a roamer. */
export const ROLES: readonly BotRole[] = ['solo', 'mid', 'duo', 'duo', 'roam'];
