import { describe, expect, it } from 'vitest';
import { thor, zeus } from '../game/gods';
import { FAVOR_REWARDS } from '../game/progression';
import { ConquestLayout as L } from '../map/ConquestLayout';
import { godUnit } from './factory';
import { BOSS_FIRST_SPAWN, BOSS_SPECIAL, BUFF_DURATION, BUFF_KINDS, buffMark, FURY_DURATION, WYRM_TEAM_XP, CAMP_FIRST_SPAWN, CAMP_RESPAWN, LEASH, type CampState } from './Jungle';
import { LaneBot, ROLES, spawnPoint } from './LaneBot';
import { conquestBases, Match } from './Match';
import { Nav } from './Nav';
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
    expect(match.jungle.camps.length).toBe(L.camps.length);
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
    expect(c.members[0]!.combatant.stats.maxHealth).toBeGreaterThan(950);
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

describe('jungle bots', () => {
  it('the roaming bot clears its own camps and takes a buff', () => {
    const { sim, match } = setup();
    const g = sim.add(godUnit(thor, 'order', spawnPoint('order', 4)));
    g.brain = new LaneBot(sim, match, g, 'roam');
    run(sim, match, 100);
    const cleared = match.jungle.camps.filter((c) => c.camp.team === 'order' && c.respawnAt !== null).length;
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect(BUFF_KINDS.some((k) => g.marks.has(buffMark(k)))).toBe(true);
  });
});

describe('navigation', () => {
  it('finds a way around a wall', () => {
    // a wall along x = 0 from z = -20 to z = 20
    const walled: SimTerrain = {
      groundAt: () => 0,
      resolve: (x, z, r) => (Math.abs(x) < 1 + r && Math.abs(z) < 20 ? { x: x < 0 ? -1 - r : 1 + r, z } : { x, z }),
    };
    const nav = new Nav(walled, 40);
    const path = nav.path({ x: -10, z: 0 }, { x: 10, z: 0 });
    expect(path.length).toBeGreaterThan(2);
    for (let i = 1; i < path.length; i++) expect(nav.clear(path[i - 1]!, path[i]!)).toBe(true);
    expect(Math.max(...path.map((p) => Math.abs(p.z)))).toBeGreaterThan(19);
  });
});

describe('jungle bosses', { timeout: 20000 }, () => {
  const boss = (match: Match, kind: string) => match.jungle.camps.find((c) => c.camp.kind === kind)!;

  it('the Treasure Wyrm rises at two minutes and rewards the whole team', () => {
    const { sim, match } = setup();
    run(sim, match, BOSS_FIRST_SPAWN.treasureWyrm - 1);
    const w = boss(match, 'treasureWyrm');
    expect(w.members.length).toBe(0);
    run(sim, match, 1.5);
    expect(w.members[0]!.name).toBe('Treasure Wyrm');
    const killer = godAt(sim, w, 6);
    const friend = sim.add(godUnit(thor, 'order', { x: 0, z: -130, yaw: 0 }));
    const favor = friend.combatant.favor;
    const xp = friend.combatant.xp;
    sim.strike(killer, w.members[0]!, 1e7, 'true');
    expect(friend.combatant.favor).toBe(favor + FAVOR_REWARDS.treasureWyrm);
    expect(friend.combatant.xp).toBe(xp + WYRM_TEAM_XP);
    expect(w.respawnAt).not.toBeNull();
  });

  it("the Molten Colossus gives its slayers' whole team Fury", () => {
    const { sim, match } = setup();
    run(sim, match, BOSS_FIRST_SPAWN.moltenColossus + 0.5);
    const c = boss(match, 'moltenColossus');
    const killer = godAt(sim, c, 8);
    const friend = sim.add(godUnit(thor, 'order', { x: 0, z: -130, yaw: 0 }));
    const foe = sim.add(godUnit(thor, 'chaos', { x: 0, z: 130, yaw: 0 }));
    sim.strike(killer, c.members[0]!, 1e7, 'true');
    expect(friend.marks.get(buffMark('fury'))?.remaining).toBe(FURY_DURATION);
    expect(killer.marks.has(buffMark('fury'))).toBe(true);
    expect(foe.marks.has(buffMark('fury'))).toBe(false);
  });

  it('bosses wind up an area attack that hits everything around them', () => {
    const { sim, match } = setup();
    run(sim, match, BOSS_FIRST_SPAWN.treasureWyrm + 0.5);
    const w = boss(match, 'treasureWyrm');
    const a = godAt(sim, w, 4);
    const b = godAt(sim, w, -4);
    sim.strike(a, w.members[0]!, 10, 'physical');
    let hurt = 0;
    sim.listeners.push((e) => {
      if (e.type === 'damage' && e.target === b) hurt += e.amount;
    });
    // b never attacks and the Wyrm fights a; only the area attack can reach b
    run(sim, match, 7 + BOSS_SPECIAL.treasureWyrm.windup);
    expect(hurt).toBeGreaterThan(0);
  });
});

describe('boss calls', { timeout: 30000 }, () => {
  it('a strong team gathers at the Wyrm pit and slays it together', () => {
    const { sim, match } = setup();
    const team: Unit[] = [];
    for (let i = 0; i < 4; i++) {
      const g = sim.add(godUnit(i % 2 ? thor : zeus, 'order', spawnPoint('order', i)));
      g.combatant.gainXp(4000);
      g.combatant.health = g.combatant.stats.maxHealth;
      g.brain = new LaneBot(sim, match, g, ROLES[i]!);
      match.addGod(g);
      team.push(g);
    }
    let slain = false;
    sim.listeners.push((e) => {
      if (e.type === 'death' && e.unit.tag.endsWith('treasureWyrm') && e.killer?.team === 'order') slain = true;
    });
    run(sim, match, BOSS_FIRST_SPAWN.treasureWyrm + 2);
    let called: string | undefined;
    for (let i = 0; i < 60 && !called; i++) {
      run(sim, match, 1);
      called = match.objectives.call('order')?.camp.kind;
    }
    expect(called).toBe('treasureWyrm');
    for (let i = 0; i < 180 && !slain; i++) run(sim, match, 1);
    expect(slain).toBe(true);
  });

  it('a weak team leaves the bosses alone', () => {
    const { sim, match } = setup();
    const g = sim.add(godUnit(zeus, 'order', spawnPoint('order', 0)));
    g.brain = new LaneBot(sim, match, g, 'mid');
    match.addGod(g);
    run(sim, match, BOSS_FIRST_SPAWN.treasureWyrm + 2);
    expect(match.objectives.call('order')).toBeNull();
  });
});
