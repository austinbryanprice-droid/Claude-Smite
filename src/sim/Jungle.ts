import { FAVOR_REWARDS } from '../game/progression';
import type { GodDef, StatKey } from '../game/types';
import { ConquestLayout as L, type Camp, type CampKind } from '../map/ConquestLayout';
import { monsterUnit, type MonsterType } from './factory';
import { attackReach } from './Lanes';
import type { Sim } from './Sim';
import type { Brain, SimEvent, Unit } from './Unit';

/** Jungle camps first appear this long into a match. */
export const CAMP_FIRST_SPAWN = 30;
/** A cleared camp grows back after this long. */
export const CAMP_RESPAWN = { small: 70, buff: 100 } as const;
/** Monsters give up a chase this far beyond their clearing's edge. */
export const LEASH = 7;
/** Share of max health a resetting monster regains per second. */
const RESET_HEAL = 0.35;
/** The Warden raises its fists this long before the slam lands. */
export const WARDEN_WINDUP = 0.45;

export type BossKind = Extract<CampKind, 'treasureWyrm' | 'moltenColossus'>;
/** When each boss first appears, and how long after it falls it returns. */
export const BOSS_FIRST_SPAWN: Record<BossKind, number> = { treasureWyrm: 120, moltenColossus: 300 };
export const BOSS_RESPAWN = 300;
/** Bosses give up a chase this far beyond their pit's edge. */
export const BOSS_LEASH = 5;
/** A boss's heavy attacks wind up for this long, so gods can see them coming. */
export const BOSS_WINDUP = 0.6;
/**
 * Each boss's area attack: the Wyrm sweeps its tail around itself, the
 * Colossus stomps and the ground erupts. Telegraphed, then everything within
 * `radius` takes `scale` times the boss's attack power.
 */
export const BOSS_SPECIAL: Record<BossKind, { every: number; windup: number; radius: number; scale: number }> = {
  treasureWyrm: { every: 9, windup: 1.0, radius: 7, scale: 1.4 },
  moltenColossus: { every: 11, windup: 1.3, radius: 9, scale: 1.8 },
};
/** Treasure Wyrm: XP and favor for every god on the team that slays it. */
export const WYRM_TEAM_XP = 300;

export type CampBuff = Extract<CampKind, 'might' | 'wisdom' | 'swiftness' | 'insight'>;
/** Buffs from buff camps, plus the Molten Colossus's team-wide Fury. */
export type BuffKind = CampBuff | 'fury';
export const BUFF_KINDS: readonly BuffKind[] = ['might', 'wisdom', 'swiftness', 'insight', 'fury'];
/** How long a buff lasts on the god who took it. Lost on death. */
export const BUFF_DURATION = 120;
/** Wisdom: share of extra XP from every reward. */
export const WISDOM_XP = 0.2;

/** What each buff gives, as timed stat mods. */
export const BUFFS: Record<BuffKind, { name: string; text: string; mods: { stat: StatKey; amount: number }[] }> = {
  might: { name: 'Might', text: '+10% damage', mods: [{ stat: 'damageBonus', amount: 0.1 }] },
  wisdom: { name: 'Wisdom', text: '+20% XP, +6 mana per second', mods: [{ stat: 'manaRegen', amount: 6 }] },
  swiftness: { name: 'Swiftness', text: '+18% movement speed', mods: [{ stat: 'bonusMoveSpeed', amount: 0.18 }] },
  insight: { name: 'Insight', text: '+15% cooldown reduction', mods: [{ stat: 'cooldownReduction', amount: 0.15 }] },
  fury: {
    name: "Colossus's Fury",
    text: '+15% damage, +8 health per second, +10% movement speed',
    mods: [
      { stat: 'damageBonus', amount: 0.15 },
      { stat: 'healthRegen', amount: 8 },
      { stat: 'bonusMoveSpeed', amount: 0.1 },
    ],
  },
};
/** Fury lasts longer than a camp buff and goes to the whole team. */
export const FURY_DURATION = 180;

export const buffMark = (b: BuffKind): string => `buff:${b}`;

export function isBuff(kind: CampKind): kind is CampBuff {
  return kind === 'might' || kind === 'wisdom' || kind === 'swiftness' || kind === 'insight';
}

export function isBoss(kind: CampKind): kind is BossKind {
  return kind === 'treasureWyrm' || kind === 'moltenColossus';
}

/** Who stands where in each camp, relative to its center (+Z points at the clearing's open side). */
const ROSTER: Partial<Record<CampKind, { type: MonsterType; at: [number, number] }[]>> = {
  small: [
    { type: 'thornbackAlpha', at: [0, 0] },
    { type: 'thornback', at: [-2.2, -1.2] },
    { type: 'thornback', at: [2.2, -1.2] },
  ],
};
// the buff altar fills the middle, so the Warden guards it from the front
const WARDEN: { type: MonsterType; at: [number, number] }[] = [{ type: 'warden', at: [0, 3.4] }];
const BOSS: Record<BossKind, { type: MonsterType; at: [number, number] }[]> = {
  treasureWyrm: [{ type: 'treasureWyrm', at: [0, 0] }],
  moltenColossus: [{ type: 'moltenColossus', at: [0, 0] }],
};

export interface CampState {
  readonly camp: Camp;
  readonly members: Unit[];
  /** Match time when the camp grows back; null while it stands. */
  respawnAt: number | null;
  /** What the whole camp is fighting. */
  foe: Unit | null;
}

/**
 * Jungle camps: neutral monsters that sit in their clearing, fight back as a
 * pack when one of them is hit, give up and heal if dragged too far, and grow
 * back a while after the camp is cleared. A buff camp's Warden grants its buff
 * to the god who lands the killing blow. Bosses come later.
 */
export class Jungle {
  readonly camps: CampState[] = [];
  private time = 0;

  constructor(
    private readonly sim: Sim,
    private readonly base: GodDef,
  ) {
    for (const camp of L.camps) {
      const first = isBoss(camp.kind) ? BOSS_FIRST_SPAWN[camp.kind] : CAMP_FIRST_SPAWN;
      this.camps.push({ camp, members: [], respawnAt: first, foe: null });
    }
    sim.listeners.push((e) => this.onEvent(e));
  }

  step(dt: number): void {
    this.time += dt;
    for (const c of this.camps) {
      if (c.respawnAt !== null && this.time >= c.respawnAt) this.spawn(c);
    }
  }

  /** Whether a camp stands right now (for the minimap). */
  alive(c: CampState): boolean {
    return c.members.some((m) => m.alive);
  }

  private spawn(c: CampState): void {
    c.respawnAt = null;
    c.foe = null;
    c.members.length = 0;
    const [cx, cz] = c.camp.at;
    // face the clearing's open side: toward the map's center line
    const yaw = Math.atan2(cx, cz);
    const kind = c.camp.kind;
    const roster = isBuff(kind) ? WARDEN : isBoss(kind) ? BOSS[kind] : ROSTER[kind] ?? [];
    const minutes = this.time / 60;
    for (const r of roster) {
      // rotate the offset by the camp's facing (forward is (-sin, -cos))
      const s = Math.sin(yaw);
      const k = Math.cos(yaw);
      const x = cx + r.at[0] * k - r.at[1] * s;
      const z = cz - r.at[0] * s - r.at[1] * k;
      const u = monsterUnit(this.base, r.type, { x, z, yaw }, minutes);
      u.tag = `${c.camp.id}:${r.type}`;
      u.brain = new MonsterBrain(this.sim, u, c);
      c.members.push(u);
      this.sim.add(u);
    }
  }

  private onEvent(e: SimEvent): void {
    if (e.type === 'damage' && e.target.kind === 'monster' && e.source) {
      const c = this.campOf(e.target);
      const src = e.source;
      // a camp keeps fighting what it fights until that leaves or dies
      if (c && (!c.foe || !engageable(c, c.foe))) c.foe = src;
      return;
    }
    if (e.type !== 'death' || e.unit.kind !== 'monster') return;
    const c = this.campOf(e.unit);
    if (!c) return;
    const kind = c.camp.kind;
    if (isBuff(kind) && e.killer?.kind === 'god') grantBuff(e.killer, kind);
    if (isBoss(kind) && e.killer && e.killer.team !== 'neutral') this.bossReward(kind, e.killer);
    if (!this.alive(c)) {
      c.respawnAt = this.time + (isBoss(kind) ? BOSS_RESPAWN : isBuff(kind) ? CAMP_RESPAWN.buff : CAMP_RESPAWN.small);
      c.foe = null;
    }
  }

  /** Bosses reward the whole team: the Wyrm with XP and favor, the Colossus with Fury. */
  private bossReward(kind: BossKind, killer: Unit): void {
    const team = this.sim.units.filter((g) => g.kind === 'god' && g.team === killer.team);
    for (const g of team) {
      if (kind === 'treasureWyrm') this.sim.reward(g, WYRM_TEAM_XP, FAVOR_REWARDS.treasureWyrm);
      else {
        this.sim.reward(g, 0, FAVOR_REWARDS.moltenColossus);
        if (g.alive) grantBuff(g, 'fury', FURY_DURATION);
      }
    }
  }

  private campOf(u: Unit): CampState | undefined {
    return this.camps.find((c) => c.members.includes(u));
  }
}

/** Give a god a buff (replacing the same buff if it already has it). */
export function grantBuff(god: Unit, kind: BuffKind, duration = BUFF_DURATION): void {
  const b = BUFFS[kind];
  god.marks.set(buffMark(kind), { stacks: 1, remaining: duration });
  for (const m of b.mods) god.combatant.refreshTimedMod(m.stat, m.amount, duration);
}

function engageable(c: CampState, t: Unit): boolean {
  if (!t.targetable || t.stealth > 0) return false;
  const [cx, cz] = c.camp.at;
  const reach = isBoss(c.camp.kind) ? L.radii.boss + BOSS_LEASH : L.radii.camp + LEASH;
  return Math.hypot(t.x - cx, t.z - cz) <= reach;
}

/**
 * A jungle monster: waits at its spot, fights its camp's foe, and when the
 * foe dies, vanishes or leaves the leash it walks home healing fast.
 */
export class MonsterBrain implements Brain {
  private resetting = false;
  /** Seconds until a boss's next area attack. */
  private specialIn = 4;
  /** Seconds left on a boss's area attack windup, 0 when not winding up. */
  special = 0;

  constructor(
    private readonly sim: Sim,
    private readonly u: Unit,
    readonly camp: CampState,
  ) {}

  /** The unit this monster is fighting, if any. */
  get target(): Unit | null {
    return this.resetting ? null : this.camp.foe;
  }

  update(dt: number): void {
    const { u, sim, camp } = this;
    u.move = null;
    if (!u.alive) return;
    const boss = isBoss(camp.camp.kind) ? camp.camp.kind : null;
    if (boss && this.special > 0) {
      this.special -= dt;
      if (this.special <= 0) this.unleash(boss);
      return;
    }
    if (u.windup > 0) {
      u.windup -= dt;
      if (u.windup <= 0) {
        u.windup = 0;
        sim.basic(u);
      }
      return;
    }
    const foe = camp.foe;
    if (foe && !engageable(camp, foe)) {
      camp.foe = null;
      this.resetting = true;
    }
    if (!camp.foe) {
      const dx = u.home.x - u.x;
      const dz = u.home.z - u.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) {
        u.move = { x: dx / d, z: dz / d };
        u.body.yaw = Math.atan2(-dx, -dz);
      } else u.body.yaw = u.home.yaw;
      if (this.resetting) {
        const c = u.combatant;
        c.heal(c.stats.maxHealth * RESET_HEAL * dt);
        if (d <= 0.4 && c.health >= c.stats.maxHealth) this.resetting = false;
      }
      return;
    }
    this.resetting = false;
    if (boss) {
      this.specialIn -= dt;
      if (this.specialIn <= 0) {
        const s = BOSS_SPECIAL[boss];
        this.specialIn = s.every;
        this.special = s.windup;
        return;
      }
    }
    const t = camp.foe;
    const dx = t.x - u.x;
    const dz = t.z - u.z;
    const d = Math.hypot(dx, dz);
    u.body.yaw = Math.atan2(-dx, -dz);
    u.aim.x = t.x;
    u.aim.z = t.z;
    const reach = attackReach(u, t);
    if (d > reach * 0.85) u.move = { x: dx / d, z: dz / d };
    if (d > reach || !u.combatant.basicReady) return;
    if (boss) u.windup = BOSS_WINDUP;
    else if (u.tag.endsWith('warden')) u.windup = WARDEN_WINDUP;
    else sim.basic(u);
  }

  /** The boss's area attack lands: everything around it is hit, with a shockwave on the ground. */
  private unleash(boss: BossKind): void {
    const { u, sim } = this;
    const s = BOSS_SPECIAL[boss];
    this.special = 0;
    u.sinceAction = 0;
    sim.flashAt(u, { type: 'circle', x: u.x, z: u.z, radius: s.radius });
    const raw = u.combatant.stats.attackPower * s.scale;
    for (const t of sim.enemiesOf(u)) {
      if (Math.hypot(t.x - u.x, t.z - u.z) > s.radius + t.radius) continue;
      sim.strike(u, t, raw, 'magical');
    }
  }

  /** Share of a boss's area attack windup done, 0 when not winding up (for the view). */
  get specialProgress(): number {
    const kind = this.camp.camp.kind;
    if (!isBoss(kind) || this.special <= 0) return 0;
    return 1 - this.special / BOSS_SPECIAL[kind].windup;
  }
}
