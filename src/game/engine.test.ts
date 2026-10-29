import { describe, expect, it } from 'vitest';
import { CCState, computeDamage, mitigation } from './combat';
import { Combatant } from './combatant';
import { anubis, loki, odin, thor, zeus } from './gods';
import { validateLoadout } from './loadout';
import { MAX_TREE_POINTS, skillRank, treePointsEarned, XP_TABLE } from './progression';
import { effectiveSlow, zeroStats } from './stats';

const xpFor = (level: number) => XP_TABLE[level - 1]!;

describe('damage', () => {
  it('follows the 100 / (100 + protection) curve', () => {
    expect(mitigation(0)).toBe(1);
    expect(mitigation(100)).toBe(0.5);
  });

  it('applies percent penetration before flat penetration', () => {
    const attacker = { ...zeroStats(), magicalPenPct: 0.2, magicalPenFlat: 10 };
    const target = { ...zeroStats(), magicalProtection: 100 };
    // 100 * 0.8 - 10 = 70 protection
    expect(computeDamage(100, 'magical', attacker, target).dealt).toBeCloseTo(100 * (100 / 170));
  });

  it('ignores protection for true damage', () => {
    const target = { ...zeroStats(), physicalProtection: 300, magicalProtection: 300 };
    expect(computeDamage(100, 'true', zeroStats(), target).dealt).toBe(100);
  });
});

describe('slows', () => {
  it('stack linearly to 40% then diminish', () => {
    expect(effectiveSlow(0.3)).toBeCloseTo(0.3);
    expect(effectiveSlow(0.5)).toBeCloseTo(0.4545, 3);
  });
});

describe('crowd control', () => {
  it('shortens repeated hard CC with diminishing returns', () => {
    const cc = new CCState();
    expect(cc.apply('stun', 1)).toBe(1);
    cc.update(1.5);
    expect(cc.apply('stun', 1)).toBeCloseTo(0.8);
    cc.update(1.5);
    expect(cc.apply('stun', 1)).toBeCloseTo(0.6);
  });

  it('lets true hard CC ignore diminishing returns but add two stacks', () => {
    const cc = new CCState();
    cc.apply('stun', 1);
    expect(cc.apply('knockup', 1)).toBe(1);
    expect(cc.drCount).toBe(3);
  });

  it('lets rooted units still dash but not stunned ones', () => {
    const cc = new CCState();
    cc.apply('root', 1);
    expect(cc.locks().move).toBe(true);
    expect(cc.locks().movementAbilities).toBe(false);
    cc.apply('stun', 1);
    expect(cc.locks().movementAbilities).toBe(true);
  });

  it('breaks mesmerize on damage', () => {
    const cc = new CCState();
    cc.apply('mesmerize', 2);
    cc.onDamaged();
    expect(cc.has('mesmerize')).toBe(false);
  });
});

describe('progression', () => {
  it('unlocks ultimates at level 5 and ranks regular skills automatically', () => {
    expect(skillRank('ultimate', 4)).toBe(0);
    expect(skillRank('ultimate', 5)).toBe(1);
    expect(skillRank('regular', 1)).toBe(1);
    expect(skillRank('regular', 20)).toBe(5);
  });

  it('caps tree points at 35', () => {
    expect(treePointsEarned(1, 0)).toBe(0);
    expect(treePointsEarned(20, 0)).toBe(19);
    expect(treePointsEarned(20, 1e9)).toBe(MAX_TREE_POINTS);
  });
});

describe('loadout rules', () => {
  it('allows a regular skill in the ultimate slot', () => {
    const l = [...zeus.defaultLoadout];
    l[4] = 'zeus.cyclone';
    expect(validateLoadout(zeus, l)).toBeNull();
  });

  it('rejects an ultimate in a regular slot, so two ultimates are impossible', () => {
    const l = [...zeus.defaultLoadout];
    l[0] = 'zeus.olympian-spear';
    expect(validateLoadout(zeus, l)).toBe('ultimateInRegularSlot');
  });

  it('rejects duplicates', () => {
    const l = [...zeus.defaultLoadout];
    l[1] = l[0]!;
    expect(validateLoadout(zeus, l)).toBe('duplicate');
  });

  it('only allows swaps in base', () => {
    const z = new Combatant(zeus, 'order');
    z.inBase = false;
    expect(z.swap(0, 'zeus.cyclone')).toBe('notInBase');
    z.inBase = true;
    expect(z.swap(0, 'zeus.cyclone')).toBeNull();
    expect(z.loadout[0]).toBe('zeus.cyclone');
  });
});

describe('skill trees', () => {
  it('gates tiers on points spent in the same tree, but trees can be mixed', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    z.gainFavor(1e9);
    expect(z.treeBudget).toBe(35);
    expect(z.allocate('tempest.arcs')).toBe('tierLocked');
    // Points in another tree don't open Tempest's tier 2...
    for (const id of ['sky-father.might', 'sky-father.tempo']) for (let i = 0; i < 3; i++) z.allocate(id);
    expect(z.allocate('tempest.arcs')).toBe('tierLocked');
    // ...but 5 in Tempest itself do, while the Sky Father points stay put.
    for (let i = 0; i < 3; i++) z.allocate('tempest.force');
    for (let i = 0; i < 2; i++) z.allocate('tempest.focus');
    expect(z.allocate('tempest.arcs')).toBeNull();
    expect(z.allocate('sky-father.presence')).toBeNull();
    expect(z.unspentPoints).toBe(35 - 13);
  });

  it('applies stat nodes and respects the budget', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(3)); // 2 points
    const before = z.stats.intelligence;
    expect(z.allocate('tempest.force')).toBeNull();
    expect(z.allocate('tempest.force')).toBeNull();
    expect(z.allocate('tempest.force')).toBe('noPoints');
    expect(z.stats.intelligence).toBe(before + 16);
  });

  it('blocks a respec outside base and one that would orphan a higher tier', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    for (const id of ['tempest.force', 'tempest.focus']) for (let i = 0; i < 3; i++) z.allocate(id);
    z.allocate('tempest.arcs');
    z.inBase = false;
    expect(z.deallocate('tempest.arcs')).toBe('notInBase');
    z.inBase = true;
    expect(z.deallocate('tempest.force')).toBeNull(); // 5 left in tier 1, still enough
    expect(z.deallocate('tempest.force')).toBe('wouldBreakTier');
  });

  it('needs the keystone prerequisite maxed, and refunds keep it', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    z.gainFavor(1e9);
    const tempest = zeus.trees[0].nodes;
    const key = tempest.find((n) => n.tier === 4)!;
    expect(key.requires).toBe('tempest.wide');
    for (const n of tempest.filter((n) => n.tier < 3)) while (z.allocate(n.id) === null);
    while (z.allocate('tempest.fury') === null);
    expect(z.allocate(key.id)).toBe('needsPrereq');
    while (z.allocate('tempest.wide') === null);
    expect(z.allocate(key.id)).toBeNull();
    expect(z.deallocate('tempest.wide')).toBe('wouldBreakTier');
  });

  it('resets one tree or all of them, in base only', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    z.allocate('tempest.force');
    z.allocate('aegis.vigor');
    z.inBase = false;
    expect(z.resetTrees()).toBe('notInBase');
    z.inBase = true;
    expect(z.resetTrees('tempest')).toBeNull();
    expect(z.allocation).toEqual({ 'aegis.vigor': 1 });
    expect(z.resetTrees()).toBeNull();
    expect(z.unspentPoints).toBe(z.treeBudget);
  });

  it('feeds skill modifiers into resolved casts', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    const base = z.resolve(0).extraBounces;
    for (const id of ['tempest.force', 'tempest.focus']) for (let i = 0; i < 3; i++) z.allocate(id);
    z.allocate('tempest.arcs');
    z.allocate('tempest.arcs');
    expect(z.resolve(0).extraBounces).toBe(base + 2);
  });
});

describe('combatant', () => {
  it('casts: spends mana, starts cooldown, and refuses while stunned', () => {
    const t = new Combatant(thor, 'order');
    const manaBefore = t.mana;
    const r = t.cast(0);
    expect(r.ok).toBe(true);
    expect(t.mana).toBeLessThan(manaBefore);
    expect(t.canCast(0)).toBe('cooldown');
    t.receiveCC('stun', 1);
    expect(t.canCast(1)).toBe('cc');
  });

  it('locks the ultimate until level 5', () => {
    const t = new Combatant(thor, 'order');
    expect(t.canCast(4)).toBe('locked');
    t.gainXp(xpFor(5));
    expect(t.canCast(4)).toBeNull();
  });

  it('deals mitigated skill damage and kills', () => {
    const l = new Combatant(loki, 'order');
    const a = new Combatant(anubis, 'chaos');
    const r = l.cast(0);
    if (!r.ok) throw new Error(r.error);
    const hp = a.health;
    l.applySkillTo(r.cast, a);
    expect(a.health).toBeLessThan(hp);
    a.takeDamage(1e6, l);
    expect(a.alive).toBe(false);
    expect(a.respawnTimer).toBeGreaterThan(0);
  });

  it('shields absorb damage before health', () => {
    const a = new Combatant(anubis, 'order');
    a.addShield(100, 5);
    a.takeDamage(60);
    expect(a.health).toBe(a.stats.maxHealth);
    expect(a.shieldTotal).toBe(40);
  });

  it('keeps cooldowns when a skill is swapped out and back in', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(5));
    expect(z.cast(4).ok).toBe(true);
    expect(z.swap(4, 'zeus.skyfall-storm')).toBeNull();
    expect(z.canCast(4)).toBe('cooldown');
    z.swap(4, 'zeus.olympian-spear');
    z.swap(4, 'zeus.skyfall-storm');
    expect(z.canCast(4)).toBe('cooldown');
    z.update(z.cooldownOf(4) + 0.01);
    expect(z.cooldownOf(4)).toBe(0);
  });

  it('only grants the hard-CC keystone shield for hard CC', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    z.gainFavor(1e9);
    const aegis = zeus.trees[2].nodes;
    for (const n of aegis.filter((n) => n.tier < 4)) while (z.allocate(n.id) === null);
    expect(z.allocate('aegis.throne')).toBeNull();
    z.receiveCC('blind', 1);
    z.receiveCC('cripple', 1);
    expect(z.shieldTotal).toBe(0);
    z.receiveCC('stun', 1);
    expect(z.shieldTotal).toBeGreaterThan(0);
  });

  it('keeps cooldowns ticking while dead', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(20));
    z.cast(4);
    const cd = z.cooldownOf(4);
    z.takeDamage(1e6);
    z.update(z.respawnTimer + 0.1);
    expect(z.alive).toBe(true);
    expect(z.cooldownOf(4)).toBeLessThan(cd - 50);
  });

  it('does not carry debuffs from a lethal hit into the next life', () => {
    const o = new Combatant(odin, 'order');
    const z = new Combatant(zeus, 'chaos');
    expect(o.loadout[1]).toBe('odin.ravens');
    const r = o.cast(1);
    if (!r.ok) throw new Error(r.error);
    z.health = 1;
    o.applySkillTo(r.cast, z);
    expect(z.alive).toBe(false);
    z.update(z.respawnTimer + 0.1);
    expect(z.stats.physicalProtection).toBe(zeus.base.physicalProtection);
  });

  it('cannot refill health or mana by cycling a respec', () => {
    const z = new Combatant(zeus, 'order');
    z.gainXp(xpFor(2));
    z.health = 100;
    z.mana = 50;
    for (let i = 0; i < 3; i++) {
      expect(z.allocate('aegis.vigor')).toBeNull();
      expect(z.deallocate('aegis.vigor')).toBeNull();
    }
    z.allocate('tempest.flow');
    z.deallocate('tempest.flow');
    expect(z.health).toBeCloseTo(100);
    expect(z.mana).toBeCloseTo(50);
  });

  it('basic attacks never hit allies or yourself', () => {
    const a = new Combatant(zeus, 'order');
    const ally = new Combatant(zeus, 'order');
    expect(a.basicAttack(ally)).toBeNull();
    expect(a.basicAttack(a)).toBeNull();
    expect(ally.health).toBe(ally.stats.maxHealth);
    expect(a.basicAttack(new Combatant(thor, 'chaos'))).not.toBeNull();
  });

  it('a ranged shot spends the attack timer when fired and deals damage when it lands', () => {
    const a = new Combatant(zeus, 'order');
    const t = new Combatant(thor, 'chaos');
    const shot = a.startBasic(() => 1)!;
    expect(shot).not.toBeNull();
    expect(a.basicReady).toBe(false);
    expect(a.startBasic()).toBeNull();
    expect(t.health).toBe(t.stats.maxHealth);
    expect(a.landBasic(new Combatant(zeus, 'order'), shot)).toBeNull();
    expect(a.landBasic(t, shot)!.dealt).toBeGreaterThan(0);
    expect(t.health).toBeLessThan(t.stats.maxHealth);
  });

  it('refreshes a zone slow on each tick instead of stacking it', () => {
    const a = new Combatant(anubis, 'order');
    const z = new Combatant(zeus, 'chaos');
    a.gainXp(xpFor(5));
    z.health = z.stats.maxHealth = 1e6;
    const r = a.cast(4); // Sandstorm
    if (!r.ok) throw new Error(r.error);
    a.applySkillTo(r.cast, z);
    z.update(1);
    a.applySkillTo(r.cast, z);
    expect(z.cc.totalSlow()).toBeCloseTo(0.35);
    // A slow from a different source still stacks.
    z.receiveCC('slow', 2, 0.2, 'other');
    expect(z.cc.totalSlow()).toBeCloseTo(0.55);
  });

  it('only lifesteals damage the target could take', () => {
    const o = new Combatant(odin, 'order');
    const z = new Combatant(zeus, 'chaos');
    o.addTimedMod('lifesteal', 0.5, 10);
    o.health = 100;
    z.health = 1;
    o.basicAttack(z, () => 1);
    expect(z.alive).toBe(false);
    expect(o.health).toBeCloseTo(100.5);
  });

  it('clears diminishing returns on death', () => {
    const z = new Combatant(zeus, 'order');
    z.receiveCC('stun', 1);
    expect(z.cc.drCount).toBe(1);
    z.takeDamage(1e6);
    expect(z.cc.drCount).toBe(0);
  });

  it('heals allies but never damages them', () => {
    const a = new Combatant(anubis, 'order');
    const ally = new Combatant(thor, 'order');
    ally.takeDamage(200);
    const hp = ally.health;
    const slot = 3;
    a.swap(slot, 'anubis.scales-of-maat');
    const r = a.cast(slot);
    if (!r.ok) throw new Error(r.error);
    a.applySkillTo(r.cast, ally);
    expect(ally.health).toBeGreaterThan(hp);
  });

  it('grows current health when max health grows', () => {
    const z = new Combatant(zeus, 'order');
    const hp = z.health;
    z.gainXp(xpFor(2));
    expect(z.health).toBeCloseTo(hp + zeus.growth.maxHealth!);
  });

  it('respawns at full health in base', () => {
    const z = new Combatant(zeus, 'order');
    z.inBase = false;
    z.takeDamage(1e6);
    z.update(z.respawnTimer + 0.1);
    expect(z.alive).toBe(true);
    expect(z.inBase).toBe(true);
    expect(z.health).toBe(z.stats.maxHealth);
  });
});
