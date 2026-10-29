import { basicAttackRaw } from '../game/combat';
import type { Sim } from './Sim';
import { WORLD_SCALE, type SimEvent, type Unit } from './Unit';

/** Charges Zeus's hits leave on a target (the same mark Arc Bolt applies). */
const CHARGE = 'charge';
const CHARGE_MAX = 3;
const CHARGE_DURATION = 6;
const CHARGE_BONUS = 0.08;
/** Thor: every third basic attack sends a shockwave through the target. */
const THOR_EVERY = 3;
const THOR_SHOCK = 0.6;
/** Odin's ravens: how far they see, and how close they unmask stealth. */
const RAVEN_RANGE = 8 * WORLD_SCALE;
const RAVEN_UNMASK = 4.5 * WORLD_SCALE;
const ODIN_BONUS = 0.1;
/** Loki: bonus from behind, and how far behind counts. */
const LOKI_BONUS = 0.15;
/** Anubis: allies near him who drop low get a shield, once per ally per cooldown. */
const ANUBIS_RANGE = 9 * WORLD_SCALE;
const ANUBIS_THRESHOLD = 0.3;
const ANUBIS_SHIELD = 0.12;
const ANUBIS_COOLDOWN = 30;

/**
 * The five gods' passives. Damage passives plug into the combatant's
 * damage multiplier; the rest listen to simulation events.
 */
export class Passives {
  private readonly thorCount = new Map<Unit, number>();
  private readonly anubisReady = new Map<Unit, number>();
  private proc = false;

  constructor(private readonly sim: Sim) {
    sim.listeners.push((e) => this.onEvent(e));
  }

  install(u: Unit): void {
    const id = u.combatant.god.id;
    const sim = this.sim;
    const unitOf = (c: unknown) => sim.unitByCombatantUid((c as { uid: number }).uid);
    if (id === 'zeus') {
      u.combatant.damageAmp = (t, ability) => {
        if (ability) return 1;
        const stacks = unitOf(t)?.marks.get(CHARGE)?.stacks ?? 0;
        return 1 + stacks * CHARGE_BONUS;
      };
    } else if (id === 'odin') {
      u.combatant.damageAmp = (t) => {
        const v = unitOf(t);
        return v && v.kind === 'god' && Math.hypot(v.x - u.x, v.z - u.z) <= RAVEN_RANGE ? 1 + ODIN_BONUS : 1;
      };
    } else if (id === 'loki') {
      u.combatant.damageAmp = (t) => {
        const v = unitOf(t);
        if (!v) return 1;
        // behind: the attacker sits opposite the way the target faces
        const f = v.forward;
        const dx = u.x - v.x;
        const dz = u.z - v.z;
        const d = Math.hypot(dx, dz) || 1;
        return (f.x * dx + f.z * dz) / d < -0.3 ? 1 + LOKI_BONUS : 1;
      };
    }
  }

  /** Odin's ravens strip stealth from enemies close to him. */
  step(): void {
    for (const o of this.sim.units) {
      if (o.kind !== 'god' || !o.alive || o.combatant.god.id !== 'odin') continue;
      for (const t of this.sim.enemiesOf(o)) {
        if (t.stealth > 0 && Math.hypot(t.x - o.x, t.z - o.z) <= RAVEN_UNMASK) t.stealth = 0;
      }
    }
  }

  private onEvent(e: SimEvent): void {
    if (e.type !== 'damage' || this.proc) return;
    const src = e.source;
    const god = src && src.kind === 'god' ? src.combatant.god.id : '';
    // Zeus charges whatever he hurts
    if (src && god === 'zeus' && e.target.alive) {
      const m = e.target.marks.get(CHARGE) ?? { stacks: 0, remaining: 0 };
      m.stacks = Math.min(CHARGE_MAX, m.stacks + 1);
      m.remaining = CHARGE_DURATION;
      e.target.marks.set(CHARGE, m);
    }
    if (src && god === 'thor' && !e.ability) {
      const n = (this.thorCount.get(src) ?? 0) + 1;
      this.thorCount.set(src, n % THOR_EVERY);
      if (n >= THOR_EVERY) this.shockwave(src, e.target);
    }
    this.anubisWard(e.target);
  }

  /** Thor's shockwave: hits enemies just behind the target, along the line of the blow. */
  private shockwave(thor: Unit, target: Unit): void {
    const dx = target.x - thor.x;
    const dz = target.z - thor.z;
    const d = Math.hypot(dx, dz) || 1;
    const cx = target.x + (dx / d) * 2.5;
    const cz = target.z + (dz / d) * 2.5;
    const raw = basicAttackRaw(thor.combatant.stats) * THOR_SHOCK;
    this.proc = true;
    for (const t of this.sim.enemiesOf(thor)) {
      if (t === target || !t.alive || !t.targetable) continue;
      if (Math.hypot(t.x - cx, t.z - cz) <= 2.8 + t.radius) this.sim.strike(thor, t, raw, 'physical');
    }
    this.proc = false;
    this.sim.flashAt(thor, { type: 'circle', x: cx, z: cz, radius: 2.8 });
  }

  private anubisWard(v: Unit): void {
    if (v.kind !== 'god' || !v.alive) return;
    const c = v.combatant;
    if (c.health / c.stats.maxHealth >= ANUBIS_THRESHOLD) return;
    if ((this.anubisReady.get(v) ?? 0) > this.sim.time) return;
    const anubis = this.sim.units.find(
      (a) => a.kind === 'god' && a.alive && a.team === v.team && a.combatant.god.id === 'anubis' && Math.hypot(a.x - v.x, a.z - v.z) <= ANUBIS_RANGE,
    );
    if (!anubis) return;
    c.addShield(c.stats.maxHealth * ANUBIS_SHIELD, 4);
    this.anubisReady.set(v, this.sim.time + ANUBIS_COOLDOWN);
  }
}
