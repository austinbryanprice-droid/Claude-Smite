import { describe, expect, it } from 'vitest';
import { ULTIMATE_SLOT } from '../game/loadout';
import { anubis, loki, odin, thor, zeus } from '../game/gods';
import { XP_TABLE } from '../game/progression';
import type { GodDef } from '../game/types';
import { GodBot } from './Bot';
import { Nav } from './Nav';
import { body, dummyUnit, godUnit, structureUnit, summonUnit } from './factory';
import { GROUND_WARNING, RECALL_TIME, Sim, type SimTerrain } from './Sim';
import { WORLD_SCALE, type SimEvent, type Unit } from './Unit';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };

/** A wall along x = `at` that nothing taller than a step can pass. */
const walled = (at: number): SimTerrain => ({
  groundAt: () => 0,
  resolve: (x, z, r) => (x + r > at ? { x: at - r, z } : { x, z }),
});

function setup(terrain: SimTerrain = flat) {
  // bases far from the fight so nobody is in base unless a test says so
  const sim = new Sim(terrain, { order: { x: 0, z: 200, radius: 10 }, chaos: { x: 0, z: -200, radius: 10 } }, () => 0.5);
  return sim;
}

function god(sim: Sim, def: GodDef, team: 'order' | 'chaos', x: number, z: number, level = 1): Unit {
  const u = sim.add(godUnit(def, team, { x, z, yaw: 0 }));
  if (level > 1) u.combatant.gainXp(XP_TABLE[level - 1]!);
  return u;
}

/** A tanky target that never fights back. */
function target(sim: Sim, x: number, z: number, team: 'order' | 'chaos' = 'chaos'): Unit {
  const t = sim.add(godUnit(thor, team, { x, z, yaw: 0 }));
  t.combatant.health = 1e5;
  (t.combatant as unknown as { cached: { maxHealth: number } }).cached.maxHealth = 1e5;
  return t;
}

/** Put a skill in a slot (swaps need base, so pretend for a moment) and cast it at a point. */
function castAt(sim: Sim, u: Unit, skillId: string, x: number, z: number): ReturnType<Sim['cast']> {
  const c = u.combatant;
  let slot = c.loadout.indexOf(skillId);
  if (slot < 0) {
    const ult = c.god.skills.find((s) => s.id === skillId)!.kind === 'ultimate';
    slot = ult ? ULTIMATE_SLOT : 0;
    c.inBase = true;
    expect(c.swap(slot, skillId)).toBeNull();
    c.inBase = false;
  }
  u.aim.x = x;
  u.aim.z = z;
  return sim.cast(u, slot);
}

function run(sim: Sim, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    sim.step(1 / 60);
    events.push(...sim.drainEvents());
  }
  return events;
}

const damaged = (events: SimEvent[], u: Unit) =>
  events.filter((e): e is Extract<SimEvent, { type: 'damage' }> => e.type === 'damage' && e.target === u);

describe('skill shapes', () => {
  it('a skill shot flies along the aim and hits the first enemy in its path, not one beside it', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const inPath = target(sim, 0, -10);
    const beside = target(sim, 6, -10);
    castAt(sim, z, 'zeus.wrath-mark', 0, -20);
    const events = run(sim, 1);
    expect(damaged(events, inPath)).toHaveLength(1);
    expect(damaged(events, beside)).toHaveLength(0);
  });

  it('a projectile flies for its range and no further', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const far = target(sim, 0, -(10 * WORLD_SCALE + 3));
    castAt(sim, z, 'zeus.wrath-mark', 0, -50);
    expect(damaged(run(sim, 2), far)).toHaveLength(0);
  });

  it('a bouncing bolt chains to a second enemy', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const a = target(sim, 0, -8);
    const b = target(sim, 5, -9);
    castAt(sim, z, 'zeus.arc-bolt', 0, -20);
    const events = run(sim, 1.5);
    expect(damaged(events, a)).toHaveLength(1);
    expect(damaged(events, b)).toHaveLength(1);
  });

  it('walls stop projectiles', () => {
    const sim = setup(walled(5));
    const z = god(sim, zeus, 'order', 0, 0);
    z.body.yaw = -Math.PI / 2; // facing +x
    const behindWall = target(sim, 9, 0);
    castAt(sim, z, 'zeus.wrath-mark', 20, 0);
    expect(damaged(run(sim, 1), behindWall)).toHaveLength(0);
  });

  it('shotClear sees the same walls that stop projectiles', () => {
    const sim = setup(walled(5));
    const z = god(sim, zeus, 'order', 0, 0);
    expect(sim.shotClear(z, { x: 1, z: 0 }, 3)).toBe(true);
    expect(sim.shotClear(z, { x: 1, z: 0 }, 9)).toBe(false);
    expect(sim.shotClear(z, { x: -1, z: 0 }, 9)).toBe(true);
  });

  it('ground skills land at the aim point, clamped to their range', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const range = 9 * WORLD_SCALE;
    const atEdge = target(sim, 0, -range);
    const beyond = target(sim, 0, -range - 9);
    castAt(sim, z, 'zeus.cyclone', 0, -100);
    const events = run(sim, 0.2 + GROUND_WARNING);
    expect(damaged(events, atEdge).length).toBeGreaterThan(0);
    expect(damaged(events, beyond)).toHaveLength(0);
  });

  it('ground blasts warn first, so a target that steps out is not hit', () => {
    const sim = setup();
    const l = god(sim, loki, 'order', 0, 0);
    const stays = target(sim, 0, -6);
    const dodges = target(sim, 1, -6);
    castAt(sim, l, 'loki.smoke-bomb', 0, -6);
    expect(damaged(run(sim, GROUND_WARNING / 2), stays)).toHaveLength(0);
    sim.teleport(dodges, 20, -6);
    const events = run(sim, GROUND_WARNING);
    expect(damaged(events, stays).length).toBeGreaterThan(0);
    expect(damaged(events, dodges)).toHaveLength(0);
  });

  it('Static Discharge sets off Charges: more per stack, a stun only at three', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const plain = target(sim, 0, -6);
    const one = target(sim, 4, -6);
    const full = target(sim, -4, -6);
    one.marks.set('charge', { stacks: 1, remaining: 6 });
    full.marks.set('charge', { stacks: 3, remaining: 6 });
    castAt(sim, z, 'zeus.static-discharge', 0, -6);
    const events = run(sim, 0.1);
    const dealt = (u: Unit) => damaged(events, u).reduce((a, e) => a + (e.type === 'damage' ? e.amount : 0), 0);
    expect(damaged(events, plain)).toHaveLength(0);
    expect(dealt(full)).toBeGreaterThan(dealt(one) * 2);
    expect(one.combatant.cc.has('stun')).toBe(false);
    expect(full.combatant.cc.has('stun')).toBe(true);
    expect(one.marks.has('charge')).toBe(false);
    expect(full.marks.has('charge')).toBe(false);
  });

  it('All-Seeing Eye waits on each enemy god for Odin\'s next hit', () => {
    const sim = setup();
    const o = god(sim, odin, 'order', 0, 0, 5);
    const far = target(sim, 0, -60);
    far.stealth = 5;
    castAt(sim, o, 'odin.all-seeing-eye', 0, -10);
    const cast = run(sim, 0.1);
    expect(damaged(cast, far)).toHaveLength(0);
    expect(far.marks.has('all-seeing')).toBe(true);
    expect(far.stealth).toBe(0);
    // Odin's next hit lands the waiting true damage too, once
    const hp = far.combatant.health;
    sim.strike(o, far, 10, 'physical');
    const first = hp - far.combatant.health;
    expect(first).toBeGreaterThan(50);
    expect(far.marks.has('all-seeing')).toBe(false);
    const hp2 = far.combatant.health;
    sim.strike(o, far, 10, 'physical');
    expect(hp2 - far.combatant.health).toBeLessThan(20);
  });

  it('a primed hit that kills counts the death once', () => {
    const sim = setup();
    const o = god(sim, odin, 'order', 0, 0, 5);
    const far = target(sim, 0, -60);
    castAt(sim, o, 'odin.all-seeing-eye', 0, -10);
    run(sim, 0.1);
    far.combatant.health = 100;
    sim.strike(o, far, 10, 'physical');
    expect(far.alive).toBe(false);
    expect(sim.drainEvents().filter((e) => e.type === 'death')).toHaveLength(1);
  });

  it('All-Seeing Eye keeps revealing after the primed hit lands', () => {
    const sim = setup();
    const o = god(sim, odin, 'order', 0, 0, 5);
    const far = target(sim, 0, -60);
    castAt(sim, o, 'odin.all-seeing-eye', 0, -10);
    run(sim, 0.1);
    sim.strike(o, far, 10, 'physical');
    far.stealth = 3;
    run(sim, 0.1);
    expect(far.stealth).toBe(0);
    run(sim, 6);
    far.stealth = 3;
    run(sim, 0.1);
    expect(far.stealth).toBeGreaterThan(0);
  });

  it('cones hit inside the arc and miss behind the caster', () => {
    const sim = setup();
    const l = god(sim, loki, 'order', 0, 0);
    const front = target(sim, 1, -6);
    const behind = target(sim, 0, 6);
    castAt(sim, l, 'loki.dagger-fan', 0, -10);
    const events = run(sim, 0.1);
    expect(damaged(events, front).length).toBeGreaterThan(0);
    expect(damaged(events, behind)).toHaveLength(0);
  });

  it('a dash carries the caster forward and hits each enemy it passes once', () => {
    const sim = setup();
    const t = god(sim, thor, 'order', 0, 0);
    const inLane = target(sim, 0, -6);
    castAt(sim, t, 'thor.lightning-dash', 0, -30);
    const events = run(sim, 1);
    expect(t.z).toBeCloseTo(-7 * WORLD_SCALE, 0);
    expect(damaged(events, inLane)).toHaveLength(1);
  });

  it('a blink teleports at once and is stopped by walls', () => {
    const sim = setup(walled(6));
    const z = god(sim, zeus, 'order', 0, 0);
    castAt(sim, z, 'zeus.storm-step', 30, 0);
    expect(z.x).toBeLessThanOrEqual(6);
    expect(z.x).toBeGreaterThan(4);
  });

  it('a leap damages where it lands, only after landing', () => {
    const sim = setup();
    const t = god(sim, thor, 'order', 0, 0);
    const spot = target(sim, 0, -10);
    castAt(sim, t, 'thor.tempest-leap', 0, -10);
    expect(damaged(run(sim, 0.2), spot)).toHaveLength(0);
    const later = run(sim, 1);
    expect(damaged(later, spot)).toHaveLength(1);
    expect(Math.hypot(t.x - 0, t.z + 10)).toBeLessThan(0.5);
  });

  it('a lingering area ticks once per interval for its number of hits', () => {
    const sim = setup();
    const a = god(sim, anubis, 'order', 0, 0, 5);
    const inside = target(sim, 0, -10);
    castAt(sim, a, 'anubis.sandstorm', 0, -10);
    const first = run(sim, 0.5);
    expect(inside.combatant.cc.has('blind')).toBe(true);
    expect(inside.combatant.cc.totalSlow()).toBeCloseTo(0.35);
    const events = [...first, ...run(sim, 5.5)];
    expect(damaged(events, inside)).toHaveLength(5);
  });

  it('Ascension follows the aim and makes Zeus untargetable while it rains', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0, 5);
    castAt(sim, z, 'zeus.ascension', 0, -10);
    expect(z.targetable).toBe(false);
    z.aim.x = 15;
    run(sim, 2);
    expect(sim.zones[0]!.x).toBeGreaterThan(5);
    run(sim, 3);
    expect(z.targetable).toBe(true);
  });

  it("Loki's backstab blinks him behind the god it hits", () => {
    const sim = setup();
    const l = god(sim, loki, 'order', 0, 0);
    const t = target(sim, 0, -8);
    castAt(sim, l, 'loki.backstab', 0, -20);
    run(sim, 0.5);
    expect(l.z).toBeLessThan(t.z);
  });

  it('knockbacks push the target away from the caster', () => {
    const sim = setup();
    const t = god(sim, thor, 'order', 0, 0);
    const victim = god(sim, zeus, 'chaos', 0, -3);
    castAt(sim, t, 'thor.lightning-dash', 0, -30);
    run(sim, 1);
    expect(victim.z).toBeLessThan(-3);
  });

  it('summons appear for their duration and then vanish', () => {
    const sim = setup();
    sim.summonFactory = summonUnit;
    const o = god(sim, odin, 'order', 0, 0, 5);
    castAt(sim, o, 'odin.einherjar', 0, -6);
    expect(sim.units).toHaveLength(3);
    run(sim, 8.5);
    expect(sim.units).toHaveLength(1);
  });
});

describe('basic attacks', () => {
  it('gods walk around a standing tower, not through it, and through its rubble', () => {
    const sim = setup();
    const t = god(sim, thor, 'order', 0, 0);
    const tower = sim.add(structureUnit(thor, 'order', 'tower', { x: 0, z: -6, yaw: 0 }, 2.6, 10));
    let closest = Infinity;
    for (let i = 0; i < 240; i++) {
      t.move = { x: 0, z: -1 };
      sim.step(1 / 60);
      closest = Math.min(closest, Math.hypot(t.x - tower.x, t.z - tower.z));
    }
    expect(closest).toBeGreaterThan(tower.radius + t.radius - 0.01);
    expect(t.z).toBeLessThan(-9); // slid around it and kept going
    tower.combatant.health = 0;
    tower.combatant.alive = false;
    tower.combatant.respawnTimer = Infinity;
    sim.teleport(t, 0, 0, 0);
    for (let i = 0; i < 40; i++) {
      t.move = { x: 0, z: -1 };
      sim.step(1 / 60);
    }
    expect(Math.abs(t.x)).toBeLessThan(0.01);
  });

  it('a point dead on a structure center still gets pushed out', () => {
    const sim = setup();
    const tower = sim.add(structureUnit(thor, 'order', 'tower', { x: 0, z: -8, yaw: 0 }, 2.6, 10));
    const r = sim.solid(0, -8, 0.6, 0, { x: 0, z: -8 });
    expect(Math.hypot(r.x - tower.x, r.z - tower.z)).toBeGreaterThan(tower.radius + 0.59);
  });

  it('routing reopens where something blocking goes away, once refreshed', () => {
    let wall = true;
    const nav = new Nav({ groundAt: () => 0, resolve: (x, z, r) => (wall && Math.abs(z) < 2 + r ? { x, z: z < 0 ? -2 - r : 2 + r } : { x, z }) }, 20);
    const a = { x: 0, z: -10 };
    const b = { x: 0, z: 10 };
    expect(nav.clear(a, b)).toBe(false);
    wall = false;
    expect(nav.clear(a, b)).toBe(false); // cached until told
    nav.refresh({ x: 0, z: 0 }, 4);
    expect(nav.clear(a, b)).toBe(true);
  });

  it('a leap never lands inside a structure', () => {
    const sim = setup();
    const t = god(sim, thor, 'order', 0, 0);
    const tower = sim.add(structureUnit(thor, 'order', 'tower', { x: 0, z: -8, yaw: 0 }, 2.6, 10));
    castAt(sim, t, 'thor.tempest-leap', 0, -8);
    run(sim, 2);
    expect(Math.hypot(t.x - tower.x, t.z - tower.z)).toBeGreaterThan(tower.radius + t.radius - 0.01);
  });

  it('a ranged basic spends its timer when fired and hurts when the shot arrives', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const t = target(sim, 0, -12);
    z.aim.x = 0;
    z.aim.z = -12;
    expect(sim.basic(z)).toBe(true);
    expect(sim.basic(z)).toBe(false);
    expect(damaged(sim.drainEvents(), t)).toHaveLength(0);
    expect(damaged(run(sim, 0.5), t)).toHaveLength(1);
  });

  it('Poison Blade makes basics poison and slow, refreshing rather than stacking', () => {
    const sim = setup();
    const l = god(sim, loki, 'order', 0, 0);
    const t = target(sim, 0, -8);
    const speed = t.combatant.moveSpeed;
    castAt(sim, l, 'loki.poison-blade', 0, -8);
    l.aim.x = 0;
    l.aim.z = -8;
    sim.drainEvents();
    // the cast alone poisons nobody
    expect(damaged(run(sim, 1.5), t)).toHaveLength(0);
    sim.basic(l);
    const first = run(sim, 0.3);
    expect(damaged(first, t)).toHaveLength(2); // the shot and the first poison tick
    expect(t.combatant.moveSpeed).toBeLessThan(speed);
    run(sim, 0.6);
    expect(sim.basic(l)).toBe(true);
    // a second shot restarts the poison (shot + 4 ticks) instead of adding a second one
    expect(damaged(run(sim, 4.2), t)).toHaveLength(1 + 4);
    // once the blade wears off, basics are plain again
    sim.basic(l);
    expect(damaged(run(sim, 3), t)).toHaveLength(1);
  });

  it('a melee swing hits enemies in front and misses those behind', () => {
    const sim = setup();
    const o = god(sim, odin, 'order', 0, 0);
    const front = target(sim, 0, -2);
    const behind = target(sim, 0, 2);
    o.aim.x = 0;
    o.aim.z = -10;
    sim.basic(o);
    const events = sim.drainEvents();
    expect(damaged(events, front)).toHaveLength(1);
    expect(damaged(events, behind)).toHaveLength(0);
  });
});

describe('match flow', () => {
  it('a kill pays XP and Favor, and the victim respawns at home', () => {
    const sim = setup();
    const z = god(sim, zeus, 'order', 0, 0);
    const d = sim.add(dummyUnit(zeus, 'chaos', { x: 0, z: -5, yaw: 0 }));
    d.combatant.health = 1;
    z.aim.x = 0;
    z.aim.z = -5;
    sim.basic(z);
    const events = run(sim, 0.5);
    expect(events.some((e) => e.type === 'death' && e.unit === d)).toBe(true);
    expect(z.combatant.xp).toBeGreaterThan(0);
    expect(z.combatant.favor).toBeGreaterThan(0);
    d.body.x = 30;
    const later = run(sim, 9);
    expect(later.some((e) => e.type === 'respawn' && e.unit === d)).toBe(true);
    expect(d.x).toBe(0);
  });

  it('recall takes eight seconds and is broken by damage', () => {
    const sim = setup();
    // home is the fountain; the god starts out in the field
    const z = sim.add(godUnit(zeus, 'order', { x: 0, z: 200, yaw: 0 }, body(0, 0)));
    expect(sim.startRecall(z)).toBe(true);
    run(sim, RECALL_TIME / 2);
    const enemy = god(sim, zeus, 'chaos', 0, -6);
    enemy.aim.x = 0;
    enemy.aim.z = 0;
    sim.basic(enemy);
    run(sim, 1);
    expect(z.recall).toBe(0);
    sim.remove(enemy);
    sim.startRecall(z);
    run(sim, RECALL_TIME + 0.1);
    expect(z.z).toBe(200);
    expect(z.combatant.inBase).toBe(true);
  });

  it('a bot engages an enemy that comes close and wears it down', () => {
    const sim = setup();
    const bot = god(sim, thor, 'chaos', 0, -10, 3);
    bot.brain = new GodBot(sim, bot, { anchor: { x: 0, z: -10 }, leash: 40, aggro: 25, aggression: 0.5 });
    const player = god(sim, zeus, 'order', 0, 5, 3);
    const before = player.combatant.health;
    run(sim, 6);
    expect(player.combatant.health).toBeLessThan(before);
  });

  it('a bot ignores enemies outside its aggro range', () => {
    const sim = setup();
    const bot = god(sim, thor, 'chaos', 0, -10);
    bot.brain = new GodBot(sim, bot, { anchor: { x: 0, z: -10 }, leash: 40, aggro: 20, aggression: 0.5 });
    const player = god(sim, zeus, 'order', 0, 40);
    run(sim, 3);
    expect(player.combatant.health).toBe(player.combatant.stats.maxHealth);
    expect(Math.hypot(bot.x, bot.z + 10)).toBeLessThan(3.5);
  });
});
