import type { Side as Team } from '../game/combatant';
import { alongPolyline, baseOf, nearestOnPolyline, type LaneId, type Vec2 } from '../map/ConquestLayout';
import { GodBot } from './Bot';
import { buffMark, isBoss, isBuff, MonsterBrain, type CampState } from './Jungle';
import { LANES, marchPath, type Match } from './Match';
import { BOSS_CALL, pitRadius } from './Objectives';
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
  /** The jungle camp a jungler is clearing or walking to. */
  private camp: CampState | null = null;
  /** The jungler's current walking route through the jungle, and what it leads to. */
  private trail: { goal: Point; points: Point[]; at: number } | null = null;

  constructor(
    private readonly sim: Sim,
    private readonly match: Match,
    private readonly u: Unit,
    readonly role: BotRole,
    aggression = 0.45,
  ) {
    this.lane = role === 'roam' ? 'mid' : role;
    this.path = marchPath(u.side, this.lane);
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
      const call = this.match.objectives.call(this.u.side);
      if (call) this.camp = call;
      else if (this.role === 'roam') {
        this.camp = this.pickCamp();
        if (!this.camp) this.roam(dt + 0.3);
      } else this.camp = null;
      if (this.camp) this.campAnchor(this.camp);
      else this.placeAnchor();
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
    this.path = marchPath(this.u.side, this.lane);
  }

  /**
   * The jungler clears its own side's camps while any stand, buffs first,
   * nearest next. It drops the jungle while hurt so it heals up first.
   */
  private pickCamp(): CampState | null {
    const { u } = this;
    const c = u.combatant;
    // keep clearing the camp we're on until it is done (the bot still retreats when very low)
    if (this.camp && !isBoss(this.camp.camp.kind) && this.match.jungle.alive(this.camp)) return this.camp;
    // start a new camp only healthy
    if (c.health < c.stats.maxHealth * 0.5) return null;
    let best: CampState | null = null;
    let bestScore = Infinity;
    for (const k of this.match.jungle.camps) {
      if (k.camp.team !== u.team || !this.match.jungle.alive(k)) continue;
      const d = Math.hypot(k.camp.at[0] - u.x, k.camp.at[1] - u.z);
      // skip a buff the jungler already holds
      if (isBuff(k.camp.kind) && u.marks.has(buffMark(k.camp.kind))) continue;
      const score = d - (isBuff(k.camp.kind) ? 35 : 0);
      if (score < bestScore) {
        best = k;
        bestScore = score;
      }
    }
    return best;
  }

  private campAnchor(c: CampState): void {
    const [cx, cz] = c.camp.at;
    if (isBoss(c.camp.kind) && !this.bossOn(c)) {
      // gather at the pit's mouth on our side until the team is there
      const home = this.u.home;
      const dx = home.x - cx;
      const dz = home.z - cz;
      const d = Math.hypot(dx, dz) || 1;
      const r = pitRadius(c) + 5;
      this.anchor.x = cx + (dx / d) * r;
      this.anchor.z = cz + (dz / d) * r;
    } else {
      this.anchor.x = cx;
      this.anchor.z = cz;
    }
    this.bot.options.anchor = this.anchor;
  }

  /** Whether the team is ready to hit a boss: it is already fighting us, or enough of us are at the pit. */
  private bossOn(c: CampState): boolean {
    const kind = c.camp.kind;
    if (!isBoss(kind)) return true;
    if (c.foe && c.foe.team === this.u.team) return true;
    const alive = this.match.gods.filter((g) => g.team === this.u.team && g.alive).length;
    return this.match.objectives.atPit(this.u.side, c) >= Math.min(BOSS_CALL[kind].gods, alive);
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
      const own = this.match.frontStructure(u.side, this.lane);
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
    if (this.camp) return this.chooseInJungle(this.camp);
    return this.chooseInLane();
  }

  /** In the jungle: fight an enemy god that comes close, otherwise the camp's monsters. */
  private chooseInJungle(camp: CampState): Unit | null {
    const { sim, u } = this;
    let god: Unit | null = null;
    let gd = AGGRO * 0.8;
    for (const t of sim.enemiesOf(u)) {
      if (t.kind !== 'god' || t.stealth > 0) continue;
      const d = Math.hypot(t.x - u.x, t.z - u.z);
      if (d < gd) {
        god = t;
        gd = d;
      }
    }
    if (god) return god;
    const [cx, cz] = camp.camp.at;
    if (Math.hypot(u.x - cx, u.z - cz) > pitRadius(camp) + 6 || !this.bossOn(camp)) return null;
    let best: Unit | null = null;
    let bd = Infinity;
    for (const m of camp.members) {
      if (!m.targetable) continue;
      // finish the one already fighting us, then the nearest
      const d = Math.hypot(m.x - u.x, m.z - u.z) - (m.brain instanceof MonsterBrain && m.brain.target === u ? 2 : 0);
      if (d < bd) {
        best = m;
        bd = d;
      }
    }
    return best;
  }

  /** The next waypoint along a path through the jungle's corridors, re-planned now and then. */
  private jungleRoute(goal: Point): Point {
    const { u, sim } = this;
    const t = this.trail;
    const stale = !t || Math.hypot(t.goal.x - goal.x, t.goal.z - goal.z) > 3 || sim.time - t.at > REPLAN;
    if (stale) this.trail = { goal: { ...goal }, points: this.match.nav.path({ x: u.x, z: u.z }, goal), at: sim.time };
    const pts = this.trail!.points;
    // drop the waypoints we've reached
    while (pts.length > 1 && Math.hypot(pts[0]!.x - u.x, pts[0]!.z - u.z) < 1.5) pts.shift();
    return pts[0] ?? goal;
  }

  private chooseInLane(): Unit | null {
    const { sim, u } = this;
    const c = u.combatant;
    const hp = c.health / c.stats.maxHealth;
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (const t of sim.enemiesOf(u)) {
      if (t.kind === 'dummy' || t.stealth > 0) continue;
      // leave the jungle alone unless a monster is already fighting us
      if (t.kind === 'monster' && !(t.brain instanceof MonsterBrain && t.brain.target === u)) continue;
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

  /** Walk along the lane instead of cutting through the jungle walls; junglers path through the jungle. */
  private route(goal: Point): Point {
    const { u } = this;
    if (this.role === 'roam' || this.camp) return this.jungleRoute(goal);
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

/** Re-plan a jungle route at least this often, seconds. */
const REPLAN = 2;

export const isLaneBot = (b: Brain | null): b is LaneBot => b instanceof LaneBot;

/** Where each god in a team stands at the fountain, spread so they don't overlap. */
export function spawnPoint(team: Team, index: number): { x: number; z: number; yaw: number } {
  const b = baseOf(team);
  const side = (index - 2) * 2.2;
  return { x: b.spawn.x + side, z: b.spawn.z, yaw: b.spawn.yaw };
}

/** The lane each slot of a five-god team plays: solo, mid, two in duo, and a roamer. */
export const ROLES: readonly BotRole[] = ['solo', 'mid', 'duo', 'duo', 'roam'];
