import { describe, expect, it } from 'vitest';
import { thor, zeus } from '../game/gods';
import { godUnit } from './factory';
import { Scoreboard, scoreTable } from './Scoreboard';
import { Sim, type SimTerrain } from './Sim';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

describe('Scoreboard', () => {
  it('tallies takedowns, deaths and damage per god', () => {
    const sim = new Sim(flat, { order: { x: 0, z: 200, radius: 9 }, chaos: { x: 0, z: -200, radius: 9 } }, () => 0.5);
    const board = new Scoreboard(sim);
    const z = sim.add(godUnit(zeus, 'order', { x: 0, z: 0, yaw: 0 }));
    const t = sim.add(godUnit(thor, 'chaos', { x: 0, z: 2, yaw: 0 }));
    board.track([z, t]);
    sim.strike(z, t, 100, 'true');
    sim.strike(z, t, 1e5, 'true');
    sim.step(1 / 30);
    const lz = board.lines.get(z)!;
    const lt = board.lines.get(t)!;
    expect(lz.kills).toBe(1);
    expect(lt.deaths).toBe(1);
    expect(lz.godDamage).toBeGreaterThan(100);
    expect(lt.taken).toBe(lz.godDamage);
    expect(board.sorted('order')[0]!.unit).toBe(z);
    expect(scoreTable(board, z, 'gods')).toContain('(you)');
  });
});
