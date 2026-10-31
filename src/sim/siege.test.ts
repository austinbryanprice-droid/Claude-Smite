import { describe, expect, it } from 'vitest';
import { zeus } from '../game/gods';
import { godUnit } from './factory';
import { BOONS, Siege, SIEGE, waveRoster } from './Siege';
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
});
