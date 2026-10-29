import { describe, expect, it } from 'vitest';
import { thor, zeus } from '../game/gods';
import { FAVOR_REWARDS } from '../game/progression';
import { ConquestLayout as L } from '../map/ConquestLayout';
import { godUnit } from './factory';
import { BUFF_DURATION, buffMark, CAMP_FIRST_SPAWN, CAMP_RESPAWN, LEASH, type CampState } from './Jungle';
import { conquestBases, Match } from './Match';
import { Sim, type SimTerrain } from './Sim';
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

function camp(match: Match, kind: string): CampState {
  return match.jungle.camps.find((c) => c.camp.kind === kind && c.camp.team === 'order')!;
}

/** A god standing next to a camp, out of reach of every other camp. */
function godAt(sim: Sim, c: CampState, offset = 3): Unit {
  const [x, z] = c.camp.at;
  const g = sim.add(godUnit(zeus, 'order', { x: x + offset, z, yaw: 0 }));
  g.combatant.gainXp(1e5);
  g.combatant.health = g.combatant.stats.maxHealth;
  return g;
}

describe('jungle camps', () => {
  it('grow in every side camp a little after the match starts', () => {
    const { sim, match } = setup();
    run(sim, match, CAMP_FIRST_SPAWN - 1);
    expect(sim.units.some((u) => u.kind === 'monster')).toBe(false);
    run(sim, match, 1.5);
    const sides = L.camps.filter((c) => c.team !== null);
    expect(match.jungle.camps.length).toBe(sides.length);
    expect(camp(match, 'small').members.length).toBe(3);
    expect(camp(match, 'might').members.length).toBe(1);
    expect(sim.units.filter((u) => u.kind === 'monster' && u.team === 'neutral').length).toBeGreaterThan(sides.length);
  });

  it('fight back as a pack when one monster is hit', () => {
    const { sim, match } = setup();
    run(sim, match, CAMP_FIRST_SPAWN + 0.5);
    const c = camp(match, 'small');
    const g = godAt(sim, c);
    const hp = g.combatant.health;
    sim.strike(g, c.members[1]!, 10, 'physical');
    run(sim, match, 4);
    expect(c.foe).toBe(g);
    expect(g.combatant.health).toBeLessThan(hp);
  });

  it('give up past the leash, walk home and heal', () => {
    const { sim, match } = setup();
    run(sim, match, CAMP_FIRST_SPAWN + 0.5);
    const c = camp(match, 'small');
    const g = godAt(sim, c);
    const alpha = c.members[0]!;
    sim.strike(g, alpha, 300, 'true');
    run(sim, match, 0.5);
    const hurt = alpha.combatant.health;
    expect(hurt).toBeLessThan(alpha.combatant.stats.maxHealth);
    // the god walks away out of the leash
    g.body.x = c.camp.at[0] + L.radii.camp + LEASH + 10;
    run(sim, match, 6);
    expect(c.foe).toBeNull();
    expect(Math.hypot(alpha.x - alpha.home.x, alpha.z - alpha.home.z)).toBeLessThan(0.6);
    expect(alpha.combatant.health).toBe(alpha.combatant.stats.maxHealth);
  });

  it("give the Warden's buff, XP and favor to the god who kills it, and grow back later", () => {
    const { sim, match } = setup();
    run(sim, match, CAMP_FIRST_SPAWN + 0.5);
    const c = camp(match, 'might');
    const g = godAt(sim, c, 5);
    const favor = g.combatant.favor;
    const bonus = g.combatant.stats.damageBonus;
    sim.strike(g, c.members[0]!, 1e6, 'true');
    expect(c.members[0]!.alive).toBe(false);
    expect(g.marks.get(buffMark('might'))?.remaining).toBe(BUFF_DURATION);
    expect(g.combatant.stats.damageBonus).toBeCloseTo(bonus + 0.1);
    expect(g.combatant.favor).toBe(favor + FAVOR_REWARDS.buffCamp);
    expect(c.respawnAt).not.toBeNull();
    run(sim, match, CAMP_RESPAWN.buff + 1);
    expect(c.members[0]!.alive).toBe(true);
    expect(c.members[0]!.combatant.stats.maxHealth).toBeGreaterThan(2000);
  });

  it('lose the buff on death, and Wisdom adds XP', () => {
    const { sim, match } = setup();
    run(sim, match, CAMP_FIRST_SPAWN + 0.5);
    const wisdom = camp(match, 'wisdom');
    const g = godAt(sim, wisdom, 5);
    g.combatant.xp = 0;
    sim.strike(g, wisdom.members[0]!, 1e6, 'true');
    expect(g.marks.has(buffMark('wisdom'))).toBe(true);
    // with Wisdom, the Warden's own XP already counts the bonus
    expect(g.combatant.xp).toBeCloseTo(c0Xp(wisdom) * 1.2, 0);
    g.combatant.takeDamage(1e9);
    run(sim, match, 0.1);
    expect(g.marks.has(buffMark('wisdom'))).toBe(false);
  });
});

function c0Xp(c: CampState): number {
  return c.members[0]!.bounty!.xp;
}
