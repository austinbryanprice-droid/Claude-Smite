import { describe, expect, it } from 'vitest';
import { zeus } from '../game/gods';
import { godUnit, monsterUnit } from './factory';
import { BOONS, CURSES, FIRST_CURSE, monsterType, Siege, SIEGE, waveRoster } from './Siege';
import { Sim, type SimTerrain } from './Sim';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const newSim = () => new Sim(flat, { order: { ...SIEGE.bases.order }, chaos: { ...SIEGE.bases.chaos } }, () => 0.5);
const run = (sim: Sim, siege: Siege, seconds: number) => {
  for (let i = 0; i < seconds * 30; i++) {
    siege.step(1 / 30);
    sim.step(1 / 30);
  }
};

describe('Temple Siege', () => {
  it('grows each wave and brings a boss every fifth', () => {
    expect(waveRoster(1).length).toBeLessThan(waveRoster(4).length);
    expect(waveRoster(4).some((t) => t === 'treasureWyrm' || t === 'moltenColossus')).toBe(false);
    expect(waveRoster(5)).toContain('treasureWyrm');
    expect(waveRoster(10)).toContain('moltenColossus');
  });

  it('brings Thornspitters from wave 3: ranged, and tagged so the view draws each monster as itself', () => {
    expect(waveRoster(2)).not.toContain('thornSpitter');
    expect(waveRoster(3)).toContain('thornSpitter');
    const sim = newSim();
    const siege = new Siege(sim, zeus);
    run(sim, siege, SIEGE.firstWave + 0.1);
    for (const m of siege.monsters) expect(m.tag).toMatch(/^siege-small-1\.\d+:thornback$/);
    expect(monsterUnit(zeus, 'thornSpitter', { x: 0, z: 0, yaw: 0 }, 0).combatant.god.basicAttack.projectileSpeed).toBeGreaterThan(0);
  });

  it('sends monsters to the plaza, where they corrupt it until the temple falls', () => {
    const sim = newSim();
    const siege = new Siege(sim, zeus);
    run(sim, siege, SIEGE.firstWave + 0.1);
    expect(siege.wave).toBe(1);
    expect(siege.monsters.length).toBe(waveRoster(1).length);
    // nobody defends: they reach the plaza and the corruption fills
    run(sim, siege, 60);
    expect(siege.onPlaza).toBeGreaterThan(0);
    expect(siege.corruption).toBeGreaterThan(0);
    run(sim, siege, 60);
    expect(siege.phase).toBe('fallen');
    expect(siege.held).toBe(0);
  });

  it('turns on a god that comes close, and a cleared wave pays out and starts a break', () => {
    const sim = newSim();
    const siege = new Siege(sim, zeus);
    const g = sim.add(godUnit(zeus, 'order', { x: 0, z: -40, yaw: 0 }));
    run(sim, siege, SIEGE.firstWave + 4);
    const hit = g.combatant.health < g.combatant.stats.maxHealth;
    expect(hit).toBe(true);
    const xp = g.combatant.xp;
    for (const m of [...siege.monsters]) sim.strike(g, m, 1e6, 'true');
    run(sim, siege, 0.2);
    expect(siege.phase).toBe('break');
    expect(siege.held).toBe(1);
    expect(g.combatant.xp).toBeGreaterThan(xp);
  });

  it('offers three boons after a wave; a chosen one lasts through death', () => {
    const sim = newSim();
    const siege = new Siege(sim, zeus);
    const g = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    run(sim, siege, SIEGE.firstWave + 0.1);
    for (const m of [...siege.monsters]) sim.strike(g, m, 1e6, 'true');
    run(sim, siege, 0.2);
    expect(siege.offer).toHaveLength(3);
    expect(new Set(siege.offer!.map((b) => b.id)).size).toBe(3);
    siege.offer = [BOONS.find((b) => b.id === 'vitality')!, BOONS[0]!, BOONS[1]!];
    const hp = g.combatant.stats.maxHealth;
    siege.choose(0);
    expect(siege.offer).toBeNull();
    expect(g.combatant.stats.maxHealth).toBe(hp + 180);
    g.combatant.takeDamage(1e9);
    run(sim, siege, SIEGE.respawn + 0.5);
    expect(g.alive).toBe(true);
    expect(g.combatant.stats.maxHealth).toBe(hp + 180);
  });

  it('announces a curse from wave 4 and lays it on that wave', () => {
    const sim = newSim();
    const siege = new Siege(sim, zeus);
    const g = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    const clear = () => {
      for (const m of [...siege.monsters]) sim.strike(g, m, 1e6, 'true');
      run(sim, siege, 0.2);
    };
    run(sim, siege, SIEGE.firstWave + 0.1);
    for (let w = 1; w < FIRST_CURSE - 1; w++) {
      clear();
      expect(siege.curse).toBeNull();
      run(sim, siege, SIEGE.breakTime + 0.1);
    }
    clear();
    // the break before wave 4 shows what is coming
    expect(siege.curse).not.toBeNull();
    siege.curse = CURSES.find((c) => c.id === 'swift')!;
    run(sim, siege, SIEGE.breakTime + 0.1);
    expect(siege.wave).toBe(FIRST_CURSE);
    const m = siege.monsters.find((u) => monsterType(u) === 'thornback')!;
    expect(m.combatant.stats.moveSpeed).toBeCloseTo(360 * 1.3, 0);
  });

  it('a swarm brings more, frailer thornbacks', () => {
    const sim = newSim();
    const siege = new Siege(sim, zeus);
    siege.curse = CURSES.find((c) => c.id === 'swarm')!;
    run(sim, siege, SIEGE.firstWave + 0.1);
    const t = siege.monsters.filter((u) => monsterType(u) === 'thornback');
    expect(t.length).toBe(2 * waveRoster(1).filter((x) => x === 'thornback').length);
    expect(t[0]!.combatant.stats.maxHealth).toBeLessThan(300);
  });
});
