import { describe, expect, it } from 'vitest';
import { odin, thor, zeus } from '../game/gods';
import { GodBot } from './Bot';
import { Clash, CLASH, CLASH_SPAWNS } from './Clash';
import { godUnit } from './factory';
import { Sim, type SimTerrain } from './Sim';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const newSim = () => new Sim(flat, { order: { ...CLASH.bases.order }, chaos: { ...CLASH.bases.chaos } }, () => 0.5);

describe('Temple Clash', () => {
  it('scores a team holding the plaza alone, and nobody while it is contested', () => {
    const sim = newSim();
    const clash = new Clash(sim);
    const a = sim.add(godUnit(zeus, 'order', { x: 0, z: 2, yaw: 0 }));
    for (let i = 0; i < 60; i++) clash.step(1 / 30);
    expect(clash.plaza).toBe('order');
    expect(clash.score.order).toBeCloseTo(CLASH.holdRate * 2, 5);
    sim.add(godUnit(thor, 'chaos', { x: 3, z: 0, yaw: 0 }));
    const before = clash.score.order;
    clash.step(1);
    expect(clash.plaza).toBe('contested');
    expect(clash.score.order).toBe(before);
    a.combatant.takeDamage(1e9);
    clash.step(1);
    expect(clash.plaza).toBe('chaos');
  });

  it('awards takedowns, shortens respawns and ends at the target', () => {
    const sim = newSim();
    const clash = new Clash(sim);
    const z = sim.add(godUnit(zeus, 'order', { x: 0, z: 30, yaw: 0 }));
    const t = sim.add(godUnit(thor, 'chaos', { x: 0, z: 31, yaw: 0 }));
    sim.strike(z, t, 1e5, 'true');
    sim.step(1 / 30);
    expect(clash.kills.order).toBe(1);
    expect(clash.score.order).toBe(CLASH.killPoints);
    expect(t.combatant.respawnTimer).toBeLessThanOrEqual(CLASH.respawn);
    clash.score.order = CLASH.target - 1;
    sim.teleport(z, 0, 0);
    for (let i = 0; i < 45; i++) clash.step(1 / 30);
    expect(clash.winner).toBe('order');
  });

  it('runs a bot-only match to a winner without errors', () => {
    const sim = newSim();
    const clash = new Clash(sim);
    const defs = [zeus, thor, odin];
    for (const team of ['order', 'chaos'] as const) {
      defs.forEach((d, i) => {
        const u = sim.add(godUnit(d, team, CLASH_SPAWNS[team][i]!));
        u.brain = new GodBot(sim, u, { anchor: { x: (i - 1) * 6, z: team === 'order' ? 4 : -4 }, leash: 70, aggro: 24, aggression: 0.55 });
      });
    }
    for (let i = 0; i < 30 * 60 * 12 && !clash.winner; i++) {
      clash.step(1 / 30);
      sim.step(1 / 30);
      sim.drainEvents();
    }
    expect(clash.winner).not.toBeNull();
    // the bots go after relics too
    expect(clash.lastClaim).not.toBeNull();
    const levels = sim.units.filter((u) => u.kind === 'god').map((u) => u.combatant.level);
    expect(Math.min(...levels)).toBeGreaterThan(5);
  });

  it('doubles points during the temple blessing', () => {
    const sim = newSim();
    const clash = new Clash(sim);
    sim.add(godUnit(zeus, 'order', { x: 0, z: 2, yaw: 0 }));
    const start = CLASH.blessingEvery - CLASH.blessingLength;
    for (let i = 0; i < 30 * (start - 1); i++) clash.step(1 / 30);
    expect(clash.blessing).toBe(0);
    expect(clash.blessingIn).toBeCloseTo(1, 3);
    const before = clash.score.order;
    for (let i = 0; i < 30 * 3; i++) clash.step(1 / 30);
    expect(clash.blessing).toBeGreaterThan(0);
    // 1 s unblessed, 2 s blessed
    expect(clash.score.order - before).toBeCloseTo(CLASH.holdRate * 5, 1);
  });

  it('raises a Sun Relic beside the plaza that a lone team claims for points and a blessing', () => {
    const sim = newSim();
    const clash = new Clash(sim);
    const R = CLASH.relic;
    const a = sim.add(godUnit(zeus, 'order', { x: 40, z: 40, yaw: 0 }));
    for (let i = 0; i < 30 * (R.first - 0.5); i++) clash.step(1 / 30);
    expect(clash.relic).toBeNull();
    for (let i = 0; i < 30; i++) clash.step(1 / 30);
    const relic = clash.relic!;
    expect(relic).not.toBeNull();
    expect(Math.abs(relic.x)).toBeGreaterThan(CLASH.plazaRadius);
    // an enemy beside it holds the claim
    a.combatant.takeDamage(a.combatant.stats.maxHealth * 0.5);
    const hurt = a.combatant.health;
    sim.teleport(a, relic.x, relic.z);
    const t = sim.add(godUnit(thor, 'chaos', { x: relic.x + 1, z: relic.z, yaw: 0 }));
    for (let i = 0; i < 30 * 3; i++) clash.step(1 / 30);
    expect(clash.relic).not.toBeNull();
    expect(relic.progress).toBe(0);
    sim.teleport(t, -40, -40);
    for (let i = 0; i < 30 * (R.claim + 0.1); i++) clash.step(1 / 30);
    expect(clash.relic).toBeNull();
    expect(clash.lastClaim).toBe('order');
    expect(clash.score.order).toBe(R.points);
    expect(clash.relicBuff.order).toBeGreaterThan(R.time - 1);
    expect(a.combatant.health).toBeGreaterThan(hurt);
    // the next one rises on the other flank
    for (let i = 0; i < 30 * (R.every + 0.1); i++) clash.step(1 / 30);
    expect(clash.relic!.x).toBeCloseTo(-relic.x, 5);
  });
});
