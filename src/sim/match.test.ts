import { describe, expect, it } from 'vitest';
import { anubis, loki, odin, thor, zeus } from '../game/gods';
import { FAVOR_REWARDS } from '../game/progression';
import { ConquestLayout as L } from '../map/ConquestLayout';
import { godUnit, minionUnit } from './factory';
import { LaneBot, ROLES, spawnPoint } from './LaneBot';
import { conquestBases, FIRST_WAVE, Match, PHOENIX_RESPAWN, WAVE_INTERVAL } from './Match';
import { BACKDOOR_SCALE, Sim, type SimTerrain } from './Sim';
import type { Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const DT = 1 / 60;

function setup() {
  const sim = new Sim(flat, conquestBases(), () => 0.5);
  const match = new Match(sim, thor);
  return { sim, match };
}

function run(sim: Sim, match: Match, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    match.step(DT);
    sim.step(DT);
  }
}

const minions = (sim: Sim) => sim.units.filter((u) => u.kind === 'minion' && u.alive);

function kill(u: Unit): void {
  u.combatant.takeDamage(1e9);
}

describe('Conquest match', () => {
  it('builds every structure from the layout', () => {
    const { match } = setup();
    expect(match.structures.size).toBe(L.towers.length + L.phoenixes.length + 2);
    expect(match.titans.order.alive && match.titans.chaos.alive).toBe(true);
  });

  it('sends a wave of six down every lane, with a brute every third wave', () => {
    const { sim, match } = setup();
    run(sim, match, FIRST_WAVE + 5);
    expect(minions(sim)).toHaveLength(2 * 3 * 6);
    expect(minions(sim).filter((m) => m.tag.endsWith('brute'))).toHaveLength(0);
    run(sim, match, WAVE_INTERVAL * 2);
    expect(match.wave).toBe(3);
    expect(sim.units.filter((m) => m.kind === 'minion' && m.tag.endsWith('brute')).length).toBeGreaterThan(0);
  });

  it('minions walk their lane and fight the enemy wave in the middle', () => {
    const { sim, match } = setup();
    const deaths: Unit[] = [];
    sim.listeners.push((e) => {
      if (e.type === 'death' && e.unit.kind === 'minion') deaths.push(e.unit);
    });
    run(sim, match, FIRST_WAVE + 45);
    expect(deaths.length).toBeGreaterThan(6);
    // the fights happen near the center line, not at a base
    for (const d of deaths) expect(Math.abs(d.z)).toBeLessThan(45);
    // nobody has lost a structure to an even trade
    expect([...match.structures.values()].every((s) => s.alive)).toBe(true);
  });

  it('shields each structure until the one in front of it falls', () => {
    const { sim, match } = setup();
    const outer = match.structures.get('chaos-mid-outer')!;
    const inner = match.structures.get('chaos-mid-inner')!;
    const phoenix = match.structures.get('chaos-mid-phoenix')!;
    const titan = match.titans.chaos;
    expect(inner.shielded()).toBe(true);
    expect(phoenix.shielded()).toBe(true);
    expect(titan.shielded()).toBe(true);
    // a god standing at the inner tower with its basic attack does nothing to it
    const z = sim.add(godUnit(zeus, 'order', { x: inner.x, z: inner.z - 9, yaw: 0 }));
    z.aim.x = inner.x;
    z.aim.z = inner.z;
    const before = inner.combatant.health;
    sim.basic(z);
    run(sim, match, 1);
    expect(inner.combatant.health).toBe(before);
    kill(outer);
    kill(inner);
    expect(phoenix.shielded()).toBe(false);
    kill(phoenix);
    expect(titan.shielded()).toBe(false);
  });

  it('only basic attacks hurt structures, and less with no minions nearby', () => {
    const { sim, match } = setup();
    const tower = match.structures.get('chaos-duo-outer')!;
    tower.brain = null; // hold fire for this test
    const z = sim.add(godUnit(zeus, 'order', { x: tower.x, z: tower.z - 6, yaw: 0 }));
    z.combatant.gainXp(1e6);
    z.aim.x = tower.x;
    z.aim.z = tower.z;
    const full = tower.combatant.health;
    // a skill shot passes by the tower
    for (let s = 0; s < 4; s++) sim.cast(z, s);
    run(sim, match, 1.5);
    expect(tower.combatant.health).toBe(full);

    // basic attack without a minion nearby
    z.combatant.basicCooldown = 0;
    sim.basic(z);
    run(sim, match, 1);
    const backdoor = full - tower.combatant.health;
    expect(backdoor).toBeGreaterThan(0);

    // same attack with an allied minion at the tower
    const m = sim.add(minionUnit(thor, 'order', 'melee', { x: tower.x, z: tower.z - 4, yaw: 0 }, { wave: 0, empowered: false }));
    m.brain = null;
    const mid = tower.combatant.health;
    z.combatant.basicCooldown = 0;
    sim.basic(z);
    run(sim, match, 1);
    const open = mid - tower.combatant.health;
    expect(backdoor / open).toBeCloseTo(BACKDOOR_SCALE, 1);
  });

  it('towers shoot minions first and switch to a god who attacks their god', () => {
    const { sim, match } = setup();
    const tower = match.structures.get('chaos-mid-outer')!;
    const m = sim.add(minionUnit(thor, 'order', 'brute', { x: tower.x, z: tower.z - 8, yaw: 0 }, { wave: 0, empowered: false }));
    m.brain = null;
    m.combatant.health = 1e5;
    const attacker = sim.add(godUnit(zeus, 'order', { x: tower.x + 3, z: tower.z - 10, yaw: 0 }));
    const defender = sim.add(godUnit(thor, 'chaos', { x: tower.x + 3, z: tower.z - 4, yaw: 0 }));
    run(sim, match, 2);
    const brain = match.brains.get(tower)!;
    expect(brain.current).toBe(m);
    expect(attacker.combatant.health).toBe(attacker.combatant.stats.maxHealth);
    // Zeus hits Thor under the tower
    attacker.aim.x = defender.x;
    attacker.aim.z = defender.z;
    sim.basic(attacker);
    run(sim, match, 1.5);
    expect(brain.current).toBe(attacker);
    expect(attacker.combatant.health).toBeLessThan(attacker.combatant.stats.maxHealth);
  });

  it('tower shots hit a god harder each time', () => {
    const { sim, match } = setup();
    const tower = match.structures.get('order-solo-outer')!;
    const g = sim.add(godUnit(thor, 'chaos', { x: tower.x, z: tower.z + 8, yaw: 0 }));
    g.combatant.gainXp(1e6);
    const hits: number[] = [];
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.target === g) hits.push(e.amount);
    });
    run(sim, match, 4);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits[2]!).toBeGreaterThan(hits[0]! * 1.4);
  });

  it('a fallen Phoenix empowers the enemy wave in its lane and rises again later', () => {
    const { sim, match } = setup();
    const phoenix = match.structures.get('chaos-solo-phoenix')!;
    kill(phoenix);
    run(sim, match, 0.1);
    expect(match.empowered.order.has('solo')).toBe(true);
    run(sim, match, FIRST_WAVE + 2);
    const solo = minions(sim).filter((m) => m.team === 'order' && m.tag.startsWith('solo'));
    const mid = minions(sim).filter((m) => m.team === 'order' && m.tag.startsWith('mid'));
    expect(solo[0]!.name).toMatch(/Empowered/);
    expect(solo[0]!.combatant.stats.maxHealth).toBeGreaterThan(mid[0]!.combatant.stats.maxHealth);
    run(sim, match, PHOENIX_RESPAWN);
    expect(phoenix.alive).toBe(true);
    expect(match.empowered.order.has('solo')).toBe(false);
  }, 30000);

  it('shares minion XP with gods nearby and gives Favor for the last hit', () => {
    const { sim, match } = setup();
    const m = sim.add(minionUnit(thor, 'chaos', 'melee', { x: 0, z: 0, yaw: 0 }, { wave: 0, empowered: false }));
    m.brain = null;
    const killer = sim.add(godUnit(zeus, 'order', { x: 0, z: -6, yaw: 0 }));
    const helper = sim.add(godUnit(thor, 'order', { x: 4, z: -6, yaw: 0 }));
    const far = sim.add(godUnit(thor, 'order', { x: 0, z: -80, yaw: 0 }));
    match.addGod(killer);
    m.combatant.health = 1;
    killer.aim.x = 0;
    killer.aim.z = 0;
    sim.basic(killer);
    run(sim, match, 1);
    expect(m.alive).toBe(false);
    expect(killer.combatant.favor).toBe(FAVOR_REWARDS.minion);
    expect(helper.combatant.xp).toBeGreaterThan(0);
    expect(helper.combatant.favor).toBe(0);
    expect(far.combatant.xp).toBe(0);
    expect(match.stats.get(killer)!.minions).toBe(1);
    run(sim, match, 2);
    expect(sim.units).not.toContain(m);
  });

  it('counts kills and assists and ends when a Titan falls', () => {
    const { sim, match } = setup();
    const a = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    const b = sim.add(godUnit(thor, 'order', { x: 3, z: 0, yaw: 0 }));
    const v = sim.add(godUnit(thor, 'chaos', { x: 0, z: 5, yaw: 0 }));
    for (const g of [a, b, v]) match.addGod(g);
    b.aim.x = v.x;
    b.aim.z = v.z;
    b.body.x = 1.5;
    b.body.z = 3.5;
    sim.basic(b);
    v.combatant.health = 1;
    a.aim.x = v.x;
    a.aim.z = v.z;
    run(sim, match, 0.2);
    a.combatant.basicCooldown = 0;
    if (v.alive) {
      v.combatant.health = 1;
      sim.basic(a);
      run(sim, match, 1);
    }
    expect(v.alive).toBe(false);
    const sa = match.stats.get(a)!;
    const sb = match.stats.get(b)!;
    expect(sa.kills + sb.kills).toBe(1);
    expect(sa.assists + sb.assists).toBe(1);
    expect(match.stats.get(v)!.deaths).toBe(1);

    kill(match.titans.chaos);
    run(sim, match, 0.1);
    expect(match.winner).toBe('order');
  });

  it('runs five minutes of waves without blowing up', () => {
    const { sim, match } = setup();
    const start = performance.now();
    run(sim, match, 300);
    expect(sim.units.filter((u) => u.kind === 'minion').length).toBeLessThan(140);
    // equal waves trade evenly: no Titan falls on its own
    expect(match.winner).toBeNull();
    expect(performance.now() - start).toBeLessThan(20000);
  }, 30000);

  it('plays a full five-on-five bot match to a Titan kill', () => {
    let seed = 7;
    const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const sim = new Sim(flat, conquestBases(), rng);
    const match = new Match(sim, thor);
    const gods = [zeus, thor, odin, loki, anubis];
    for (const team of ['order', 'chaos'] as const) {
      gods.forEach((g, i) => {
        const u = godUnit(team === 'order' ? g : gods[(i + 2) % 5]!, team, spawnPoint(team, i));
        u.brain = new LaneBot(sim, match, u, ROLES[i]!);
        match.addGod(u);
      });
    }
    for (let i = 0; i < 30 * 60 * 60 && !match.winner; i++) {
      match.step(DT);
      sim.step(DT);
    }
    expect(match.winner).not.toBeNull();
    const all = [...match.stats.values()];
    expect(all.reduce((a, s) => a + s.kills, 0)).toBeGreaterThan(10);
    expect(all.every((s) => s.minions > 0)).toBe(true);
    expect(match.gods.every((g) => g.combatant.level >= 10)).toBe(true);
  }, 120000);
});
