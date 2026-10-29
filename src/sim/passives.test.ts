import { describe, expect, it } from 'vitest';
import { anubis, loki, odin, thor, zeus } from '../game/gods';
import type { GodDef } from '../game/types';
import { godUnit } from './factory';
import { conquestBases } from './Match';
import { Sim, type SimTerrain } from './Sim';
import type { Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

function setup() {
  return new Sim(flat, conquestBases(), () => 0.99);
}

function place(sim: Sim, god: GodDef, team: 'order' | 'chaos', x: number, z: number, yaw = 0): Unit {
  const u = sim.add(godUnit(god, team, { x, z, yaw }));
  u.combatant.gainXp(1e6);
  u.combatant.health = u.combatant.stats.maxHealth;
  return u;
}

/** Fire one basic attack at `t` and return the damage it did. */
function basicAt(sim: Sim, u: Unit, t: Unit): number {
  u.aim.x = t.x;
  u.aim.z = t.z;
  u.combatant.basicCooldown = 0;
  const before = t.combatant.health + t.combatant.shieldTotal;
  sim.basic(u, { homing: t });
  for (let i = 0; i < 90; i++) sim.step(1 / 60);
  return before - (t.combatant.health + t.combatant.shieldTotal);
}

describe('god passives', () => {
  it('Zeus: each Charge on a target makes his basic attacks hit harder', () => {
    const sim = setup();
    const z = place(sim, zeus, 'order', 0, 0);
    const t = place(sim, thor, 'chaos', 0, -8);
    const first = basicAt(sim, z, t);
    expect(t.marks.get('charge')?.stacks).toBe(1);
    basicAt(sim, z, t);
    const third = basicAt(sim, z, t);
    expect(third).toBeGreaterThan(first * 1.12);
  });

  it('Thor: every third basic attack sends a shockwave through the target', () => {
    const sim = setup();
    const th = place(sim, thor, 'order', 0, 0);
    const front = place(sim, zeus, 'chaos', 0, -2.5);
    const behind = place(sim, zeus, 'chaos', 0, -5.5);
    basicAt(sim, th, front);
    basicAt(sim, th, front);
    expect(behind.combatant.health).toBe(behind.combatant.stats.maxHealth);
    basicAt(sim, th, front);
    expect(behind.combatant.health).toBeLessThan(behind.combatant.stats.maxHealth);
  });

  it('Loki: attacks from behind deal more damage', () => {
    const sim = setup();
    const l = place(sim, loki, 'order', 0, 0);
    // the target faces away from Loki (yaw 0 faces -Z), then toward him
    const t = place(sim, odin, 'chaos', 0, -8, 0);
    t.brain = null;
    const back = basicAt(sim, l, t);
    t.body.yaw = Math.PI;
    const front = basicAt(sim, l, t);
    expect(back / front).toBeGreaterThan(1.1);
  });

  it('Odin: ravens unmask stealthed enemies close by', () => {
    const sim = setup();
    place(sim, odin, 'order', 0, 0);
    const near = place(sim, loki, 'chaos', 0, -4);
    const far = place(sim, loki, 'chaos', 0, -40);
    near.stealth = 3;
    far.stealth = 3;
    sim.step(1 / 60);
    expect(near.stealth).toBe(0);
    expect(far.stealth).toBeGreaterThan(0);
  });

  it('Anubis: shields a nearby ally who drops low, once per cooldown', () => {
    const sim = setup();
    place(sim, anubis, 'order', 0, 0);
    const ally = place(sim, thor, 'order', 3, 0);
    const foe = place(sim, zeus, 'chaos', 3, -6);
    ally.combatant.health = ally.combatant.stats.maxHealth * 0.3;
    basicAt(sim, foe, ally);
    expect(ally.combatant.shieldTotal).toBeGreaterThan(0);
  });
});
