import { describe, expect, it } from 'vitest';
import { thor, zeus } from '../game/gods';
import { Duel, DUEL, DUEL_BOONS } from './Duel';
import { godUnit } from './factory';
import { Sim, type SimTerrain } from './Sim';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const setup = () => {
  const sim = new Sim(flat, { order: { ...DUEL.bases.order }, chaos: { ...DUEL.bases.chaos } }, () => 0.5);
  const duel = new Duel(sim);
  const a = sim.add(godUnit(zeus, 'order', DUEL.spawns.order));
  const b = sim.add(godUnit(thor, 'chaos', DUEL.spawns.chaos));
  duel.begin(a, b);
  const run = (s: number) => {
    for (let i = 0; i < s * 30; i++) {
      duel.step(1 / 30);
      sim.step(1 / 30);
    }
  };
  return { sim, duel, a, b, run };
};

describe('Temple Duel', () => {
  it('counts down, then a fall takes the round and the next one starts levelled up, healed and in place', () => {
    const { duel, a, b, run } = setup();
    expect(duel.phase).toBe('countdown');
    expect(a.combatant.level).toBe(DUEL.startLevel);
    run(DUEL.countdown + 0.1);
    expect(duel.phase).toBe('fight');
    b.combatant.takeDamage(1e9);
    run(0.1);
    expect(duel.wins.order).toBe(1);
    expect(duel.phase).toBe('pause');
    run(DUEL.pause + 0.2);
    expect(duel.round).toBe(2);
    expect(b.alive).toBe(true);
    expect(b.combatant.level).toBe(DUEL.startLevel + DUEL.levelsPerRound);
    expect(b.combatant.health).toBe(b.combatant.stats.maxHealth);
    expect(Math.hypot(b.x - DUEL.spawns.chaos.x, b.z - DUEL.spawns.chaos.z)).toBeLessThan(0.5);
  });

  it('the ring closes after a while and burns whoever stands outside', () => {
    const { duel, a, run } = setup();
    run(DUEL.countdown + 0.1);
    expect(duel.ring).toBe(DUEL.ringStart);
    run(DUEL.ringHold);
    const hp = a.combatant.health;
    // both stand still at their marks, 13 m out: once the ring passes them they burn
    run(DUEL.ringClose * 0.7);
    expect(duel.ring).toBeLessThan(13);
    expect(a.combatant.health).toBeLessThan(hp);
    run(DUEL.ringClose);
    // nobody can wait it out: the fire ends the round
    expect(duel.round).toBe(2);
  });

  it('gods falling together is a draw, and the round is fought again', () => {
    const { duel, a, b, run } = setup();
    run(DUEL.countdown + 0.1);
    a.combatant.takeDamage(1e9);
    b.combatant.takeDamage(1e9);
    run(0.1);
    expect(duel.lastRound).toBeNull();
    expect(duel.wins).toEqual({ order: 0, chaos: 0 });
    run(DUEL.pause + 0.2);
    expect(duel.round).toBe(2);
    expect(a.alive && b.alive).toBe(true);
  });

  it('three rounds win the duel', () => {
    const { duel, b, run } = setup();
    for (let r = 0; r < DUEL.rounds; r++) {
      run(DUEL.countdown + 0.1);
      b.combatant.takeDamage(1e9);
      run(DUEL.pause + 0.2);
    }
    expect(duel.winner).toBe('order');
    expect(duel.phase).toBe('over');
  });

  it("gives a round's loser a lasting boon: a bot picks at once, the player chooses", () => {
    const { duel, a, b, run } = setup();
    duel.human = 'order';
    expect(DUEL_BOONS.length).toBeGreaterThanOrEqual(3);
    run(DUEL.countdown + 0.1);
    b.combatant.takeDamage(1e9);
    run(0.1);
    // the bot side lost: it took a boon by itself
    expect(duel.offer).toBeNull();
    expect(duel.boons.chaos.length).toBe(1);
    run(DUEL.pause + DUEL.countdown + 0.2);
    expect(duel.phase).toBe('fight');
    const before = a.combatant.stats.damageBonus;
    a.combatant.takeDamage(1e9);
    run(0.1);
    // the player lost: three choices wait, with a longer break
    expect(duel.offer?.team).toBe('order');
    expect(duel.offer?.boons.length).toBe(3);
    expect(duel.timer).toBeGreaterThan(DUEL.pause);
    const fury = duel.offer!.boons.findIndex((x) => x.id === 'fury');
    const pick = duel.choose(fury >= 0 ? fury : 0)!;
    expect(duel.boons.order).toEqual([pick]);
    expect(duel.timer).toBeLessThanOrEqual(2);
    if (pick.id === 'fury') expect(a.combatant.stats.damageBonus).toBeCloseTo(before + 0.08, 5);
  });
});
