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

export type BuffKind = Extract<CampKind, 'might' | 'wisdom' | 'swiftness' | 'insight'>;
export const BUFF_KINDS: readonly BuffKind[] = ['might', 'wisdom', 'swiftness', 'insight'];
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
};

export const buffMark = (b: BuffKind): string => `buff:${b}`;

export function isBuff(kind: CampKind): kind is BuffKind {
  return (BUFF_KINDS as readonly string[]).includes(kind);
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
      if (camp.team === null) continue;
      this.camps.push({ camp, members: [], respawnAt: CAMP_FIRST_SPAWN, foe: null });
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
    const roster = isBuff(c.camp.kind) ? WARDEN : ROSTER[c.camp.kind] ?? [];
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
    if (isBuff(c.camp.kind) && e.killer?.kind === 'god') grantBuff(e.killer, c.camp.kind);
    if (!this.alive(c)) {
      c.respawnAt = this.time + (isBuff(c.camp.kind) ? CAMP_RESPAWN.buff : CAMP_RESPAWN.small);
      c.foe = null;
    }
  }

  private campOf(u: Unit): CampState | undefined {
    return this.camps.find((c) => c.members.includes(u));
  }
}

/** Give a god a buff (replacing the same buff if it already has it). */
export function grantBuff(god: Unit, kind: BuffKind): void {
  const b = BUFFS[kind];
  god.marks.set(buffMark(kind), { stacks: 1, remaining: BUFF_DURATION });
  for (const m of b.mods) god.combatant.refreshTimedMod(m.stat, m.amount, BUFF_DURATION);
}

function engageable(c: CampState, t: Unit): boolean {
  if (!t.targetable || t.stealth > 0) return false;
  const [cx, cz] = c.camp.at;
  return Math.hypot(t.x - cx, t.z - cz) <= L.radii.camp + LEASH;
}

/**
 * A jungle monster: waits at its spot, fights its camp's foe, and when the
 * foe dies, vanishes or leaves the leash it walks home healing fast.
 */
export class MonsterBrain implements Brain {
  private resetting = false;

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
    if (u.tag.endsWith('warden')) u.windup = WARDEN_WINDUP;
    else sim.basic(u);
  }
}
