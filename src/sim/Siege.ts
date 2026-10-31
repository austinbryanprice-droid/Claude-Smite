import { hypot } from '../core/math';
import type { GodDef, StatKey } from '../game/types';
import type { CampKind } from '../map/ConquestLayout';
import { monsterUnit, type MonsterType } from './factory';
import { MonsterBrain, type CampState } from './Jungle';
import type { Sim } from './Sim';
import type { SimEvent, Unit } from './Unit';

/**
 * Temple Siege: waves of monsters march on the temple plaza from both gates.
 * Every monster standing on the plaza corrupts it; when corruption fills, the
 * temple falls. Clear a wave to cleanse the plaza a little and earn a short
 * break. Every fifth wave brings a boss. It never ends: the score is how many
 * waves the team held.
 */
export const SIEGE = {
  plazaRadius: 17,
  /** Corruption a second for each monster on the plaza (bosses count more). */
  corruptRate: 1.5,
  bossCorrupt: 4,
  /** The plaza heals this fast while no monster stands on it. */
  cleanseRate: 1,
  /** Corruption lifted when a wave is cleared. */
  waveCleanse: 15,
  max: 100,
  firstWave: 8,
  breakTime: 10,
  respawn: 8,
  startLevel: 5,
  startFavor: 400,
  /** Monsters pick fights with gods this close; otherwise they march on the plaza. */
  aggro: 11,
  gates: [
    { x: 0, z: -56 },
    { x: 0, z: 56 },
  ],
  bases: {
    order: { x: 0, z: 62, radius: 9 },
    chaos: { x: 0, z: -62, radius: 9 },
  },
} as const;

/** The gods start around the fountain, facing north. */
export const SIEGE_SPAWNS = [-4, 0, 4].map((x) => ({ x, z: 8, yaw: 0 }));

const BOSSES: MonsterType[] = ['treasureWyrm', 'moltenColossus'];

/** Which monsters a wave brings: more, tougher, and a boss every fifth wave. */
export function waveRoster(n: number): MonsterType[] {
  const out: MonsterType[] = [];
  for (let i = 0; i < Math.min(12, 2 + n); i++) out.push('thornback');
  for (let i = 0; i < Math.min(5, Math.floor(n / 2)); i++) out.push('thornbackAlpha');
  for (let i = 0; i < Math.min(3, Math.floor((n - 1) / 3)); i++) out.push('warden');
  if (n % 5 === 0) out.push(BOSSES[(n / 5 - 1) % 2]!);
  return out;
}

/** How grown a wave's monsters are, as jungle minutes (camps get tougher with time). */
export const waveMinutes = (n: number): number => (n - 1) * 1.8;

/** Beyond the jungle's growth, later waves get tougher still: health and damage both. */
export const waveScale = (n: number): number => 1 + Math.max(0, n - 6) * 0.22;
/** The first boss arrives before the team has its keystones, so it comes in lighter. */
const FIRST_BOSS_HEALTH = 0.7;

const isBossType = (t: string): boolean => t === 'treasureWyrm' || t === 'moltenColossus';

/**
 * A siege monster: fights the nearest god that comes close, otherwise marches
 * to its spot on the plaza. It reuses the jungle monster's fighting (windups,
 * boss slams, the boss bar) with a camp that travels with it.
 */
export class SiegeBrain extends MonsterBrain {
  private readonly at: [number, number];

  constructor(
    private readonly s: Sim,
    private readonly self: Unit,
    camp: CampState,
  ) {
    super(s, self, camp);
    this.at = camp.camp.at as unknown as [number, number];
  }

  override update(dt: number): void {
    const u = this.self;
    this.at[0] = u.x;
    this.at[1] = u.z;
    const camp = this.camp;
    const keep = camp.foe && camp.foe.alive && camp.foe.targetable && camp.foe.stealth <= 0 && hypot(camp.foe.x - u.x, camp.foe.z - u.z) < SIEGE.aggro + 4;
    if (!keep) {
      let best: Unit | null = null;
      let bd: number = SIEGE.aggro;
      for (const t of this.s.enemiesOf(u)) {
        if ((t.kind !== 'god' && t.kind !== 'summon') || t.stealth > 0 || !t.targetable) continue;
        const d = hypot(t.x - u.x, t.z - u.z);
        if (d < bd) {
          best = t;
          bd = d;
        }
      }
      camp.foe = best;
    }
    super.update(dt);
  }
}

/**
 * Boons: after each cleared wave the team picks one of three. Each one lasts
 * the whole run (through deaths) and they stack, so every run builds differently.
 */
export interface Boon {
  id: string;
  name: string;
  text: string;
  /** Team-wide stat bonuses. */
  stats?: Partial<Record<StatKey, number>>;
  /** Siege rules: monsters corrupt slower, or the plaza is cleansed now. */
  corruptScale?: number;
  cleanse?: number;
}

export const BOONS: readonly Boon[] = [
  { id: 'fury', name: 'Fury of the Gods', text: '+8% damage', stats: { damageBonus: 0.08 } },
  { id: 'vitality', name: 'Titan Blood', text: '+180 max health', stats: { maxHealth: 180 } },
  { id: 'haste', name: 'Quickened Rites', text: '+8% cooldown reduction', stats: { cooldownReduction: 0.08 } },
  { id: 'frenzy', name: 'Frenzy', text: '+18% attack speed', stats: { bonusAttackSpeed: 0.18 } },
  { id: 'swift', name: 'Winged Sandals', text: '+8% movement speed', stats: { bonusMoveSpeed: 0.08 } },
  { id: 'thirst', name: 'Bloodthirst', text: '+7% lifesteal', stats: { lifesteal: 0.07 } },
  { id: 'bulwark', name: 'Temple Bulwark', text: '+14 physical and magical protection', stats: { physicalProtection: 14, magicalProtection: 14 } },
  { id: 'spring', name: 'Sacred Spring', text: '+5 health and +4 mana per second', stats: { healthRegen: 5, manaRegen: 4 } },
  { id: 'might', name: 'Heroic Might', text: '+20 strength and +30 intelligence', stats: { strength: 20, intelligence: 30 } },
  { id: 'hallowed', name: 'Hallowed Ground', text: 'Monsters corrupt the plaza 25% slower', corruptScale: 0.75 },
  { id: 'purify', name: 'Purifying Flame', text: 'Cleanse 40 corruption now', cleanse: 40 },
];

/**
 * Curses: from wave 4 each wave comes with a twist, announced during the break
 * before it, so the team can pick a boon that answers it.
 */
export interface Curse {
  id: string;
  name: string;
  text: string;
  /** Stat changes on every monster of the wave, as fractions of its own stat (or flat for fractions). */
  scale?: Partial<Record<'moveSpeed' | 'attackSpeed' | 'physicalProtection' | 'magicalProtection', number>>;
  flat?: Partial<Record<'lifesteal' | 'healthRegen', number>>;
  /** Swarm: this many times the thornbacks, each this much of the health. */
  swarm?: { count: number; health: number };
  /** Gods' respawns are this much slower during the wave. */
  respawn?: number;
}

export const CURSES: readonly Curse[] = [
  { id: 'swift', name: 'Swift Horde', text: 'Monsters move 30% faster', scale: { moveSpeed: 0.3 } },
  { id: 'frenzied', name: 'Frenzied', text: 'Monsters attack 35% faster', scale: { attackSpeed: 0.35 } },
  { id: 'ironhide', name: 'Ironhide', text: 'Monsters have 50% more protection', scale: { physicalProtection: 0.5, magicalProtection: 0.5 } },
  { id: 'vampiric', name: 'Vampiric', text: 'Monsters heal for 25% of their damage', flat: { lifesteal: 0.25 } },
  { id: 'swarm', name: 'Swarm', text: 'Twice the thornbacks, each a little frailer', swarm: { count: 2, health: 0.6 } },
  { id: 'dread', name: 'Dread Night', text: 'Fallen gods take twice as long to return', respawn: 2 },
];

/** The first wave that carries a curse. */
export const FIRST_CURSE = 4;

export type SiegePhase = 'break' | 'fight' | 'fallen';

export class Siege {
  wave = 0;
  corruption = 0;
  phase: SiegePhase = 'break';
  /** Seconds until the next wave while on a break. */
  timer: number = SIEGE.firstWave;
  /** Monsters of the current wave still standing. */
  readonly monsters: Unit[] = [];
  /** Monsters on the plaza right now. */
  onPlaza = 0;
  kills = 0;
  /** The three boons on offer during a break, until one is chosen. */
  offer: Boon[] | null = null;
  /** Boons taken this run, in order. */
  readonly boons: Boon[] = [];
  private corruptScale = 1;
  /** The curse on the coming wave (during a break) or the current one (during a fight). */
  curse: Curse | null = null;

  constructor(
    private readonly sim: Sim,
    private readonly base: GodDef,
  ) {
    sim.listeners.push((e) => this.on(e));
  }

  /** Waves fully cleared. */
  get held(): number {
    return this.phase === 'fight' || this.phase === 'fallen' ? this.wave - 1 : this.wave;
  }

  private on(e: SimEvent): void {
    if (e.type !== 'death') return;
    if (e.unit.kind === 'god') e.unit.combatant.respawnTimer = Math.min(e.unit.combatant.respawnTimer, SIEGE.respawn * (this.phase === 'fight' ? (this.curse?.respawn ?? 1) : 1));
    else if (e.unit.kind === 'monster' && this.monsters.includes(e.unit)) this.kills++;
  }

  step(dt: number): void {
    if (this.phase === 'fallen') return;
    for (let i = this.monsters.length - 1; i >= 0; i--) if (!this.monsters[i]!.alive) this.monsters.splice(i, 1);
    let rate = 0;
    this.onPlaza = 0;
    for (const m of this.monsters) {
      if (hypot(m.x, m.z) > SIEGE.plazaRadius) continue;
      this.onPlaza++;
      rate += isBossType(m.tag) ? SIEGE.bossCorrupt : SIEGE.corruptRate;
    }
    rate *= this.corruptScale;
    this.corruption = Math.max(0, this.corruption + (rate > 0 ? rate : -SIEGE.cleanseRate) * dt);
    if (this.corruption >= SIEGE.max) {
      this.corruption = SIEGE.max;
      this.phase = 'fallen';
      return;
    }
    if (this.phase === 'break') {
      this.timer -= dt;
      if (this.timer <= 0) this.startWave();
    } else if (this.monsters.length === 0) this.clearWave();
  }

  /** Take one of the offered boons for the whole team. */
  choose(i: number): Boon | null {
    const b = this.offer?.[i];
    if (!b) return null;
    this.offer = null;
    this.boons.push(b);
    if (b.corruptScale) this.corruptScale *= b.corruptScale;
    if (b.cleanse) this.corruption = Math.max(0, this.corruption - b.cleanse);
    for (const g of this.sim.units) {
      if (g.kind !== 'god' || g.team === 'neutral' || !b.stats) continue;
      for (const [k, v] of Object.entries(b.stats) as [StatKey, number][]) g.combatant.addPerk(k, v);
    }
    return b;
  }

  private startWave(): void {
    // an offer left unanswered is not lost: the first boon is taken
    if (this.offer) this.choose(0);
    this.wave++;
    this.phase = 'fight';
    const curse = this.curse;
    let roster = waveRoster(this.wave);
    if (curse?.swarm) {
      // capped, so a late swarm stays a crowd rather than a slideshow
      const n = roster.filter((t) => t === 'thornback').length;
      const extra = Math.min(n * (curse.swarm.count - 1), 18 - n);
      roster = [...Array<MonsterType>(extra).fill('thornback'), ...roster];
    }
    const minutes = waveMinutes(this.wave);
    const scale = waveScale(this.wave);
    roster.forEach((type, i) => {
      // early waves come from the north gate only, then from both
      const gate = SIEGE.gates[this.wave >= 3 ? i % 2 : 0]!;
      const yaw = Math.atan2(gate.x, gate.z);
      const spread = isBossType(type) ? 0 : ((i >> 1) % 6) - 2.5;
      const x = gate.x + spread * 2.2;
      const z = gate.z + (gate.z > 0 ? -1 : 1) * (Math.floor(i / 12) * 2.5);
      const u = monsterUnit(this.base, type, { x, z, yaw }, minutes);
      const c = u.combatant;
      let hp = isBossType(type) && this.wave === 5 ? FIRST_BOSS_HEALTH : scale;
      if (curse?.swarm && type === 'thornback') hp *= curse.swarm.health;
      if (hp !== 1) c.refreshTimedMod('maxHealth', c.stats.maxHealth * (hp - 1), 1e9);
      if (scale > 1) c.refreshTimedMod('attackPower', c.stats.attackPower * (scale - 1), 1e9);
      for (const [k, f] of Object.entries(curse?.scale ?? {}) as [StatKey, number][]) c.refreshTimedMod(k, c.stats[k] * f, 1e9);
      for (const [k, v] of Object.entries(curse?.flat ?? {}) as [StatKey, number][]) c.refreshTimedMod(k, k === 'healthRegen' ? c.stats.maxHealth * v : v, 1e9);
      c.health = c.stats.maxHealth;
      u.tag = type;
      // each monster has its own spot on the plaza, so the horde spreads out over it
      const a = (i / roster.length) * Math.PI * 2;
      const r = isBossType(type) ? 0 : 5 + (i % 3) * 3;
      u.home.x = Math.sin(a) * r;
      u.home.z = Math.cos(a) * r;
      const kind: CampKind = isBossType(type) ? (type as CampKind) : 'small';
      const camp: CampState = { camp: { id: `siege:${this.wave}:${i}`, kind, team: null, at: [x, z] }, members: [u], respawnAt: null, foe: null };
      u.brain = new SiegeBrain(this.sim, u, camp);
      this.monsters.push(u);
      this.sim.add(u);
    });
  }

  /** Curses never repeat back to back. */
  private rollCurse(n: number): Curse | null {
    if (n < FIRST_CURSE) return null;
    const pool = CURSES.filter((c) => c !== this.curse);
    return pool[Math.floor(this.sim.rng() * pool.length)]!;
  }

  private clearWave(): void {
    this.phase = 'break';
    this.timer = SIEGE.breakTime;
    this.corruption = Math.max(0, this.corruption - SIEGE.waveCleanse);
    this.curse = this.rollCurse(this.wave + 1);
    const pool = [...BOONS].filter((b) => !(b.cleanse && this.corruption < 10));
    this.offer = [];
    while (this.offer.length < 3 && pool.length) this.offer.push(pool.splice(Math.floor(this.sim.rng() * pool.length), 1)[0]!);
    for (const g of this.sim.units) {
      if (g.kind !== 'god' || g.team === 'neutral') continue;
      this.sim.reward(g, 40 + 15 * this.wave, 60 + 10 * this.wave);
      if (g.alive) {
        const c = g.combatant;
        c.heal(c.stats.maxHealth * 0.35);
        c.mana = Math.min(c.stats.maxMana, c.mana + c.stats.maxMana * 0.35);
      }
    }
  }
}
