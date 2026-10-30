import type { CombatantNet, ResolvedSkill, Team } from '../game/combatant';
import { godById, GODS } from '../game/gods';
import { skillById } from '../game/loadout';
import { dummyUnit, godUnit, minionUnit, monsterUnit, summonUnit, type MinionType, type MonsterType } from '../sim/factory';
import type { Match } from '../sim/Match';
import type { Sim } from '../sim/Sim';
import { Unit, type Flash, type FlashShape, type Projectile, type SimEvent, type SpawnOrigin, type Zone } from '../sim/Unit';
import type { Msg } from './Session';

/*
 * The host's match, copied to guests. The host sends a snapshot 20 times a
 * second: unit positions and timers (only what changed since the last one),
 * the rules-engine state of units whose state changed, new and removed
 * units, projectiles, areas, the events since the last snapshot, and the
 * match clock and scoreboard. Guests draw everything a little in the past
 * (DELAY), interpolating positions between snapshots, so movement stays
 * smooth through network jitter.
 *
 * Timers travel as the match time they end (or started) at, so a unit that
 * is only counting down does not need resending.
 */

/** Snapshots per second is 60 / SNAPSHOT_EVERY. */
export const SNAPSHOT_EVERY = 3;
/** Rules-engine state goes out every this many snapshots. */
const DETAIL_EVERY = 2;
/** How far in the past guests draw the match, in seconds. */
const DELAY = 0.12;

/**
 * A unit's fast-changing state:
 * id, x, y, z, yaw, vx, vz, health, mana, alive, last action time, stealth end,
 * untargetable end, recall end, windup end, death time, leap arc + 1 (0 when
 * not forced), authority sequence (see HostSync.seq). Trailing zeros are left
 * off, so most units send only the first eleven.
 */
type Fast = number[];
export const F = { x: 1, y: 2, z: 3, yaw: 4, vx: 5, vz: 6, hp: 7, mana: 8, alive: 9, action: 10, stealth: 11, untargetable: 12, recall: 13, windup: 14, dead: 15, arc: 16, seq: 17 } as const;
const FAST_LENGTH = 18;
/** Decimals each field keeps on the wire. */
const DECIMALS = [0, 2, 2, 2, 2, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 0];

interface Detail {
  c: CombatantNet;
  /** Marks as [key, stacks, end time]. */
  m: [string, number, number][];
  /** Summon expiry time, when it has one. */
  l?: number;
}

interface Spawn {
  id: number;
  o: SpawnOrigin;
  team: Team;
  tag: string;
  x: number;
  z: number;
  yaw: number;
  owner: number;
}

type EncCast = Omit<ResolvedSkill, 'skill'> & { skill: string };

/** The units both ends build the same way at the start, by role: god slots in roster order, structures by id. */
export interface Roster {
  slots: Unit[];
  structures: Map<string, Unit>;
}

export interface Snapshot extends Msg {
  t: 'snap';
  time: number;
  /** First snapshot to a guest: host ids of the roster's units. */
  ids?: { slots: number[]; structures: [string, number][] };
  n: Spawn[];
  u: Fast[];
  d: [number, Detail][];
  r: number[];
  e: unknown[];
  p: unknown[][];
  z: unknown[][];
  f: unknown[][];
  m: ReturnType<Match['netState']>;
  s?: [number, number[]][];
  /** What each firing structure is shooting at, for the targeting beams. */
  b: [number, number][];
}

const end = (time: number, left: number) => (left > 0 ? time + left : 0);

function encCast(c: ResolvedSkill | null): EncCast | null {
  return c && { ...c, skill: c.skill.id };
}

function decCast(owner: Unit, c: EncCast | null): ResolvedSkill | null {
  if (!c) return null;
  const skill = skillById(owner.combatant.god, c.skill);
  return skill ? { ...c, skill } : null;
}

const UNIT_KEYS = ['target', 'source', 'unit', 'owner', 'killer'] as const;

// ---------------------------------------------------------------------------
// Host

interface GuestState {
  fresh: boolean;
  known: Set<number>;
  fast: Map<number, string>;
  detail: Map<number, string>;
  stats: Map<number, string>;
}

/** Builds the snapshots a host sends, remembering what each guest already has. */
export class HostSync {
  private readonly guests = new Map<string, GuestState>();
  private events: SimEvent[] = [];
  private frame = 0;
  /** Units that exist from the start on every end (see Roster). */
  private readonly initial: Set<number>;

  constructor(
    private readonly sim: Sim,
    private readonly match: Match,
    private readonly roster: Roster,
    /** A player's authority sequence: bumped when the host moves their god itself. */
    private readonly seq: (u: Unit) => number,
  ) {
    sim.listeners.push((e) => this.events.push(e));
    this.initial = new Set([...roster.slots, ...roster.structures.values()].map((u) => u.id));
  }

  addGuest(id: string): void {
    this.guests.set(id, { fresh: true, known: new Set(this.initial), fast: new Map(), detail: new Map(), stats: new Map() });
  }

  removeGuest(id: string): void {
    this.guests.delete(id);
  }

  /** One snapshot per guest, or nothing for guests that are up to date. */
  snapshots(): [string, Snapshot][] {
    const sim = this.sim;
    const time = sim.time;
    const detailFrame = this.frame++ % DETAIL_EVERY === 0;
    const units = sim.units;
    const fast = new Map<number, { f: Fast; key: string }>();
    for (const u of units) fast.set(u.id, this.fast(u, time));
    const detail = new Map<number, { d: Detail; key: string }>();
    if (detailFrame) {
      for (const u of units) {
        const d = this.detail(u, time);
        detail.set(u.id, { d, key: JSON.stringify(d, tenth) });
      }
    }
    const events = this.events.map(encEvent).filter((e) => e !== null);
    this.events = [];
    const p = sim.projectiles.filter((x) => x.alive).map(encProjectile);
    const z = sim.zones.map((x) => [x.id, x.owner.id, encCast(x.cast), x.x, x.z, x.radius, x.ticks, x.interval, x.timer, x.follow, x.range, x.age, x.duration]);
    const f = sim.flashes.map((x) => [x.id, x.owner.id, x.shape, x.age, x.life]);
    const m = this.match.netState();
    const b: [number, number][] = [];
    for (const [s, brain] of this.match.brains) if (brain.current) b.push([s.id, brain.current.id]);
    const statRows = this.match.gods.map((g) => {
      const s = this.match.stats.get(g)!;
      return [g.id, [s.kills, s.deaths, s.assists, s.minions, s.structures, Math.round(s.damage)]] as [number, number[]];
    });

    const out: [string, Snapshot][] = [];
    for (const [id, g] of this.guests) {
      const snap: Snapshot = { t: 'snap', time, n: [], u: [], d: [], r: [], e: events, p, z, f, m, b };
      if (g.fresh) {
        g.fresh = false;
        snap.ids = { slots: this.roster.slots.map((u) => u.id), structures: [...this.roster.structures].map(([k, u]) => [k, u.id]) };
      }
      const alive = new Set<number>();
      for (const u of units) {
        alive.add(u.id);
        if (!g.known.has(u.id)) {
          g.known.add(u.id);
          snap.n.push(spawnOf(u));
        }
        const fu = fast.get(u.id)!;
        if (g.fast.get(u.id) !== fu.key) {
          g.fast.set(u.id, fu.key);
          snap.u.push(fu.f);
        }
        const du = detail.get(u.id);
        if (du && g.detail.get(u.id) !== du.key) {
          g.detail.set(u.id, du.key);
          snap.d.push([u.id, du.d]);
        }
      }
      for (const known of g.known) {
        if (alive.has(known)) continue;
        g.known.delete(known);
        g.fast.delete(known);
        g.detail.delete(known);
        snap.r.push(known);
      }
      if (detailFrame) {
        const rows = statRows.filter(([uid, row]) => {
          const key = row.join(',');
          if (g.stats.get(uid) === key) return false;
          g.stats.set(uid, key);
          return true;
        });
        if (rows.length) snap.s = rows;
      }
      out.push([id, snap]);
    }
    return out;
  }

  private fast(u: Unit, time: number): { f: Fast; key: string } {
    const c = u.combatant;
    const f: Fast = [
      u.id,
      u.x,
      u.body.y,
      u.z,
      u.body.yaw,
      u.vx,
      u.vz,
      // a living unit never shows an empty bar
      c.alive ? Math.max(1, c.health) : 0,
      c.mana,
      c.alive ? 1 : 0,
      time - u.sinceAction,
      end(time, u.stealth),
      end(time, u.untargetable),
      end(time, u.recall),
      end(time, u.windup),
      c.alive ? 0 : time - u.deadFor,
      u.forced ? u.forced.arc + 1 : 0,
      this.seq(u),
    ].map((v, i) => {
      const k = 10 ** DECIMALS[i]!;
      return Math.round(v * k) / k;
    });
    while (f[f.length - 1] === 0) f.pop();
    // counting-down timers keep the same end time, so only real changes resend a unit
    return { f, key: f.join(',') };
  }

  private detail(u: Unit, time: number): Detail {
    const c = u.combatant.netState();
    // only gods use their attack timer on a guest's screen
    if (u.kind !== 'god') c.basicCooldown = 0;
    const d: Detail = { c, m: [...u.marks].map(([k, m]) => [k, m.stacks, time + m.remaining]) };
    if (u.lifetime !== Infinity) d.l = time + u.lifetime;
    return d;
  }
}

/** Timers in change detection count to a tenth of a second. */
function tenth(_key: string, v: unknown): unknown {
  return typeof v === 'number' ? Math.round(v * 10) : v;
}

function spawnOf(u: Unit): Spawn {
  return { id: u.id, o: u.origin ?? { f: 'structure' }, team: u.team, tag: u.tag, x: u.x, z: u.z, yaw: u.body.yaw, owner: u.owner?.id ?? 0 };
}

function encProjectile(p: Projectile): unknown[] {
  return [p.id, p.owner.id, encCast(p.cast), p.shot ? [p.shot.raw, p.shot.crit ? 1 : 0] : null, p.x, p.z, p.dx, p.dz, p.speed, p.traveled, p.range, p.radius, p.pierce ? 1 : 0, p.bounces, p.homing?.id ?? 0];
}

function encEvent(e: SimEvent): unknown {
  const out: Record<string, unknown> = { ...e };
  for (const k of UNIT_KEYS) {
    const v = (e as Record<string, unknown>)[k];
    if (v instanceof Unit) out[k] = v.id;
    else if (v === null) out[k] = 0;
  }
  if (e.type === 'death') out.assists = e.assists.map((a) => a.id);
  if (e.type === 'cast') out.cast = encCast(e.cast);
  return out;
}

// ---------------------------------------------------------------------------
// Guest

interface Sample {
  t: number;
  f: Fast;
}

/** The forced-movement stand-in a guest keeps on a unit mid-dash, so canMove and leap poses work. */
function forcedStub(arc: number): NonNullable<Unit['forced']> {
  return { vx: 0, vz: 0, remaining: 1, total: 1, arc, collide: false };
}

/**
 * A guest's copy of the host's match. Never steps the simulation: it applies
 * snapshots on a slight delay and interpolates between them.
 */
export class GuestSync {
  private readonly byId = new Map<number, Unit>();
  private readonly samples = new Map<number, Sample[]>();
  private readonly queue: Snapshot[] = [];
  private readonly projectiles = new Map<number, Projectile>();
  private readonly zones = new Map<number, Zone>();
  private readonly flashes = new Map<number, Flash>();
  /** What each structure is shooting at (for the targeting beams). */
  readonly targets = new Map<Unit, Unit>();
  private renderTime = -1;
  private newest = -1;
  private previous = -1;
  /** The latest state of this player's own god, without the delay. */
  latestSelf: Fast | null = null;
  /** Where this player's god is in the delayed picture (followed while the host moves it). */
  selfPlace: { x: number; y: number; z: number } | null = null;
  private selfId = 0;
  /** Whether the first snapshot (with the roster's ids) has arrived. */
  get live(): boolean {
    return this.selfId !== 0;
  }

  constructor(
    private readonly sim: Sim,
    private readonly match: Match,
    private readonly roster: Roster,
    private readonly self: Unit,
    /** Structures and minions borrow this god's shape. */
    private readonly base = godById('zeus') ?? GODS[0]!,
  ) {}

  receive(s: Snapshot): void {
    if (s.ids) this.mapRoster(s.ids);
    if (!this.live) return;
    this.previous = this.newest;
    this.newest = s.time;
    for (const f of s.u) {
      while (f.length < FAST_LENGTH) f.push(0);
      const id = f[0]!;
      let list = this.samples.get(id);
      if (!list) this.samples.set(id, (list = []));
      // a unit left out of snapshots stood still: hold its last state up to the previous one
      const last = list[list.length - 1];
      if (last && this.previous > last.t) list.push({ t: this.previous, f: last.f });
      list.push({ t: s.time, f });
      if (id === this.selfId) this.latestSelf = f;
    }
    this.queue.push(s);
  }

  /** Advance the delayed clock, apply due snapshots and place every unit. */
  step(dt: number): void {
    if (this.newest < 0) return;
    const target = this.newest - DELAY;
    if (this.renderTime < 0 || Math.abs(target - this.renderTime) > 0.5) this.renderTime = target;
    else this.renderTime += dt + (target - this.renderTime) * 0.05;
    const rt = this.renderTime;
    while (this.queue.length && this.queue[0]!.time <= rt) this.apply(this.queue.shift()!);
    this.sim.time = rt;

    for (const [id, list] of this.samples) {
      const u = this.byId.get(id);
      if (!u) continue;
      while (list.length > 1 && list[1]!.t <= rt) list.shift();
      const a = list[0]!;
      const b = list[1];
      this.place(u, a, b, rt);
    }
    // projectiles fly straight between snapshots
    for (const p of this.sim.projectiles) {
      p.x += p.dx * p.speed * dt;
      p.z += p.dz * p.speed * dt;
    }
    for (const z of this.sim.zones) z.age += dt;
    for (const f of this.sim.flashes) f.age += dt;
    for (const u of this.sim.units) {
      for (const [k, m] of u.marks) {
        m.remaining -= dt;
        if (m.remaining <= 0) u.marks.delete(k);
      }
    }
  }

  private mapRoster(ids: NonNullable<Snapshot['ids']>): void {
    ids.slots.forEach((id, i) => {
      const u = this.roster.slots[i];
      if (u) this.byId.set(id, u);
    });
    for (const [key, id] of ids.structures) {
      const u = this.roster.structures.get(key);
      if (u) this.byId.set(id, u);
    }
    for (const [id, u] of this.byId) if (u === this.self) this.selfId = id;
  }

  private place(u: Unit, a: Sample, b: Sample | undefined, rt: number): void {
    let f = a.f;
    if (b && rt > a.t) {
      const k = Math.min(1, (rt - a.t) / (b.t - a.t));
      f = a.f.slice();
      for (const i of [F.x, F.y, F.z, F.vx, F.vz, F.hp, F.mana]) f[i] = a.f[i]! + (b.f[i]! - a.f[i]!) * k;
      let dy = b.f[F.yaw]! - a.f[F.yaw]!;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      f[F.yaw] = a.f[F.yaw]! + dy * k;
    }
    const c = u.combatant;
    if (u !== this.self) {
      u.body.x = f[F.x]!;
      u.body.y = f[F.y]!;
      u.body.z = f[F.z]!;
      u.body.yaw = f[F.yaw]!;
      u.vx = f[F.vx]!;
      u.vz = f[F.vz]!;
    } else this.selfPlace = { x: f[F.x]!, y: f[F.y]!, z: f[F.z]! };
    c.health = f[F.hp]!;
    c.mana = f[F.mana]!;
    c.alive = f[F.alive] === 1;
    u.stealth = Math.max(0, f[F.stealth]! - rt);
    u.untargetable = Math.max(0, f[F.untargetable]! - rt);
    u.recall = Math.max(0, f[F.recall]! - rt);
    u.windup = Math.max(0, f[F.windup]! - rt);
    u.sinceAction = Math.max(0, rt - f[F.action]!);
    u.deadFor = c.alive ? 0 : Math.max(0, rt - f[F.dead]!);
    u.forced = f[F.arc]! > 0 ? forcedStub(f[F.arc]! - 1) : null;
  }

  private apply(s: Snapshot): void {
    const sim = this.sim;
    for (const n of s.n) this.spawn(n);
    for (const [id, d] of s.d) {
      const u = this.byId.get(id);
      if (!u) continue;
      u.combatant.applyNet(d.c, u !== this.self);
      u.marks.clear();
      for (const [k, stacks, until] of d.m) u.marks.set(k, { stacks, remaining: until - s.time });
      if (d.l !== undefined) u.lifetime = d.l - s.time;
    }
    for (const raw of s.e) {
      const e = this.decEvent(raw as Record<string, unknown>);
      if (e) sim.inject(e);
    }
    this.syncProjectiles(s);
    this.syncZones(s);
    this.syncFlashes(s);
    this.match.applyNet(s.m);
    this.targets.clear();
    for (const [sid, tid] of s.b) {
      const st = this.byId.get(sid);
      const t = this.byId.get(tid);
      if (st && t) this.targets.set(st, t);
    }
    for (const [id, row] of s.s ?? []) {
      const u = this.byId.get(id);
      const st = u && this.match.stats.get(u);
      if (!st) continue;
      [st.kills, st.deaths, st.assists, st.minions, st.structures, st.damage] = row as [number, number, number, number, number, number];
    }
    for (const id of s.r) {
      const u = this.byId.get(id);
      if (u) sim.remove(u);
      this.byId.delete(id);
      this.samples.delete(id);
    }
  }

  private spawn(n: Spawn): void {
    if (this.byId.has(n.id)) return;
    const at = { x: n.x, z: n.z, yaw: n.yaw };
    const o = n.o;
    let u: Unit | null = null;
    switch (o.f) {
      case 'minion':
        u = minionUnit(this.base, n.team, o.type as MinionType, at, { wave: o.wave, empowered: o.empowered });
        break;
      case 'monster':
        u = monsterUnit(this.base, o.type as MonsterType, at, o.minutes);
        break;
      case 'summon': {
        const owner = this.byId.get(n.owner);
        if (!owner) return;
        u = summonUnit(owner, o.kind, at, o.index);
        u.owner = owner;
        break;
      }
      case 'dummy':
        u = dummyUnit(this.base, n.team, at);
        break;
      case 'god': {
        const def = godById(o.god);
        if (def) u = godUnit(def, n.team, at);
        break;
      }
      default:
        return;
    }
    if (!u) return;
    u.tag = n.tag;
    u.body.x = n.x;
    u.body.z = n.z;
    u.body.yaw = n.yaw;
    this.byId.set(n.id, u);
    this.sim.add(u);
    if (u.kind === 'monster') this.joinCamp(u);
  }

  /** Monster tags start with their camp's id; the minimap reads camps from their members. */
  private joinCamp(u: Unit): void {
    const id = u.tag.slice(0, u.tag.lastIndexOf(':'));
    const camp = this.match.jungle.camps.find((c) => c.camp.id === id);
    if (!camp) return;
    if (!camp.members.some((m) => m.alive && this.sim.units.includes(m))) camp.members.length = 0;
    camp.members.push(u);
  }

  private unit(id: unknown): Unit | null {
    return (typeof id === 'number' && this.byId.get(id)) || null;
  }

  private decEvent(raw: Record<string, unknown>): SimEvent | null {
    const e: Record<string, unknown> = { ...raw };
    for (const k of UNIT_KEYS) {
      if (!(k in raw)) continue;
      const u = this.unit(raw[k]);
      // an event about a unit this guest never saw is dropped; a missing source or killer is fine
      if (!u && (k === 'target' || k === 'unit' || k === 'owner')) return null;
      e[k] = u;
    }
    if (raw.type === 'death') e.assists = (raw.assists as number[]).map((id) => this.unit(id)).filter((u) => u !== null);
    if (raw.type === 'cast') {
      e.cast = decCast(e.unit as Unit, raw.cast as EncCast);
      if (!e.cast) return null;
    }
    return e as unknown as SimEvent;
  }

  private syncProjectiles(s: Snapshot): void {
    const seen = new Set<number>();
    const lag = this.renderTime - s.time;
    for (const r of s.p) {
      const [id, ownerId, cast, shot, x, z, dx, dz, speed, traveled, range, radius, pierce, bounces, homing] = r as [number, number, EncCast | null, [number, number] | null, number, number, number, number, number, number, number, number, number, number, number];
      const owner = this.byId.get(ownerId);
      if (!owner) continue;
      seen.add(id);
      let p = this.projectiles.get(id);
      if (!p) {
        p = { id, owner, cast: decCast(owner, cast), shot: shot && { raw: shot[0], crit: shot[1] === 1 }, x, z, dx, dz, speed, traveled, range, radius, pierce: pierce === 1, bounces, homing: this.unit(homing), hit: new Set(), alive: true };
        this.projectiles.set(id, p);
        this.sim.projectiles.push(p);
      }
      p.x = x + dx * speed * lag;
      p.z = z + dz * speed * lag;
      p.dx = dx;
      p.dz = dz;
      p.speed = speed;
      p.traveled = traveled;
    }
    this.prune(this.projectiles, this.sim.projectiles, seen, (p) => (p.alive = false));
  }

  private syncZones(s: Snapshot): void {
    const seen = new Set<number>();
    for (const r of s.z) {
      const [id, ownerId, cast, x, z, radius, ticks, interval, timer, follow, range, age, duration] = r as [number, number, EncCast, number, number, number, number, number, number, Zone['follow'], number, number, number];
      const owner = this.byId.get(ownerId);
      const resolved = owner && decCast(owner, cast);
      if (!owner || !resolved) continue;
      seen.add(id);
      let zone = this.zones.get(id);
      if (!zone) {
        zone = { id, owner, cast: resolved, x, z, radius, ticks, interval, timer, follow, range, age, duration };
        this.zones.set(id, zone);
        this.sim.zones.push(zone);
      }
      Object.assign(zone, { x, z, radius, ticks, timer, age });
    }
    this.prune(this.zones, this.sim.zones, seen);
  }

  private syncFlashes(s: Snapshot): void {
    const seen = new Set<number>();
    for (const r of s.f) {
      const [id, ownerId, shape, age, life] = r as [number, number, FlashShape, number, number];
      const owner = this.byId.get(ownerId);
      if (!owner) continue;
      seen.add(id);
      if (this.flashes.has(id)) continue;
      const f: Flash = { id, shape, owner, age, life };
      this.flashes.set(id, f);
      this.sim.flashes.push(f);
    }
    this.prune(this.flashes, this.sim.flashes, seen);
  }

  private prune<T extends { id: number }>(map: Map<number, T>, list: T[], seen: Set<number>, onRemove?: (x: T) => void): void {
    for (const [id, x] of map) {
      if (seen.has(id)) continue;
      map.delete(id);
      const i = list.indexOf(x);
      if (i >= 0) list.splice(i, 1);
      onRemove?.(x);
    }
  }
}
