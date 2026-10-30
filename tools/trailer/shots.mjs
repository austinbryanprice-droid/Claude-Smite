// The trailer's in-game shots, filmed by film.mjs. `setup(stage, game)` and
// `director(dt, t, stage)` run inside the game page (src/dev/Stage.ts), so
// they are written as plain functions: the shared parts are spliced in as source.

/**
 * A god on the temple plaza unleashing its ultimate, then a skill, on an enemy
 * god, while the camera circles from the hero's front round to the side.
 */
function hero(god, foe, opts = {}) {
  const cfg = JSON.stringify({ god, foe, slots: opts.slots ?? [[0.15, 4], [1.25, 0]], a0: opts.a0 ?? 1.95, a1: opts.a1 ?? 1.3 });
  return {
    url: `map=arena&god=${god}&quality=high`,
    frames: opts.frames ?? 66,
    setup: `(s, g) => {
      const cfg = ${cfg};
      s.clear();
      s.park(0, 44);
      const u = s.god(cfg.god, 'order', 0, 15, 0);
      const f = s.god(cfg.foe, 'chaos', 0, 9, Math.PI);
      u.brain = null;
      f.brain = null;
      Object.assign(s.vars, { hero: u, foe: f, cfg, gy: g.world.collision.groundAt(0, 12) });
      return { hero: u.name, foe: f.name, gy: s.vars.gy };
    }`,
    director: `(dt, t, s) => {
      const { hero, foe, cfg, gy } = s.vars;
      for (const [at, slot] of cfg.slots) if (t >= at && !s.vars['c' + at]) { s.vars['c' + at] = 1; s.cast(hero, slot, foe.x, foe.z); }
      const k = Math.min(1, t / 2.2);
      const e = k * k * (3 - 2 * k);
      const a = cfg.a0 + (cfg.a1 - cfg.a0) * e;
      const r = 7.4 - 1.2 * e;
      const cx = 0, cz = 12.2;
      s.look(cx + Math.sin(a) * r, gy + 1.9 - 0.3 * e, cz + Math.cos(a) * r, cx, gy + 1.15, cz, 48);
    }`,
  };
}

/**
 * A Conquest moment found by skipping the bot match ahead until `find` (page
 * source returning the units to film, or null) has them, then circling them.
 * `cam`: radius, height, start angle, sweep (radians over the shot), fov.
 */
function conquest(find, opts = {}) {
  const cam = JSON.stringify({ r: 14, h: 7, a0: 0.6, sweep: 0.5, fov: 50, ...(opts.cam ?? {}) });
  return {
    url: opts.url ?? 'map=conquest&god=thor&quality=medium',
    frames: opts.frames ?? 60,
    setup: `(s, g) => {
      const find = ${find};
      const gods = () => s.combat.sim.units.filter((u) => u.kind === 'god' && u.alive && u !== s.combat.player);
      s.park(0, -150);
      ${opts.before ?? ''}
      s.vars.gy = (x, z) => g.world.collision.groundAt(x, z);
      s.vars.find = () => find(s.combat.sim.units.filter((u) => u.alive), gods());
      if (${opts.skip ?? 0}) s.skip(${opts.skip ?? 0});
      const ok = s.skipUntil(() => !!s.vars.find(), ${opts.limit ?? 600});
      const who = s.vars.find() ?? [];
      s.vars.cam = ${cam};
      s.vars.f = null;
      return { ok, at: s.skipped, who: who.map((u) => u.name + ' ' + Math.round(u.x) + ',' + Math.round(u.z)) };
    }`,
    director: `(dt, t, s) => {
      const c = s.vars.cam;
      const who = s.vars.find();
      if (who && who.length) {
        let x = 0, z = 0;
        for (const u of who) { x += u.x; z += u.z; }
        x /= who.length; z /= who.length;
        if (!s.vars.f) s.vars.f = { x, z };
        // ease toward the action so the camera never jerks
        const k = Math.min(1, dt * 1.5);
        s.vars.f.x += (x - s.vars.f.x) * k;
        s.vars.f.z += (z - s.vars.f.z) * k;
      }
      const f = s.vars.f;
      const a = c.a0 + c.sweep * (t / 2.2);
      const cx = f.x + Math.sin(a) * c.r, cz = f.z + Math.cos(a) * c.r;
      const gy = s.vars.gy;
      s.look(cx, Math.max(gy(cx, cz) + 1.5, gy(f.x, f.z) + c.h), cz, f.x, gy(f.x, f.z) + 1.4, f.z, c.fov);
    }`,
  };
}

/** A fixed flight path (start and end camera and target) over the map a few seconds into the match. */
function flight(from, to, opts = {}) {
  const path = JSON.stringify({ from, to, fov: opts.fov ?? 50, dur: opts.dur ?? 2.2 });
  return {
    url: 'map=conquest&god=thor&quality=medium',
    frames: opts.frames ?? 66,
    setup: `(s, g) => {
      s.park(0, -150);
      s.skip(${opts.skip ?? 5});
      s.vars.p = ${path};
      s.vars.gy = (x, z) => g.world.collision.groundAt(x, z);
      return { at: s.skipped };
    }`,
    director: `(dt, t, s) => {
      const { from, to, fov, dur } = s.vars.p;
      const k = Math.min(1, t / dur);
      const e = k * k * (3 - 2 * k) * 0.6 + k * 0.4;
      const m = (i) => from[i] + (to[i] - from[i]) * e;
      s.look(m(0), m(1), m(2), m(3), m(4), m(5), fov);
    }`,
  };
}

function brawl(order, chaos, cam) {
  const teams = JSON.stringify({ order, chaos });
  return conquest(`(us, gods) => (gods.length >= 4 ? gods : null)`, {
    url: 'map=arena&god=zeus&quality=high',
    before: `s.clear();
      const T = ${teams};
      T.order.forEach((id, i) => s.god(id, 'order', (i - 1) * 3, 18, 0, { aggression: 0.9, leash: 40, aggro: 40 }));
      T.chaos.forEach((id, i) => s.god(id, 'chaos', (i - 1) * 3, 4, Math.PI, { aggression: 0.9, leash: 40, aggro: 40 }));`,
    skip: 1.2,
    limit: 5,
    frames: 75,
    cam: { r: 10, h: 3.2, sweep: 0.45, ...cam },
  });
}

export const SHOTS = {
  probeArena: {
    url: 'map=arena&god=zeus&quality=high',
    frames: 1,
    setup: (s, g) => ({ spawn: g.world.spawn, units: g.combat.debugState().units }),
    director: (dt, t, s) => s.look(0, 6, 22, 0, 1, 0, 55),
  },
  heroZeus: hero('zeus', 'thor'),
  heroThor: hero('thor', 'loki'),
  heroOdin: hero('odin', 'anubis'),
  heroLoki: hero('loki', 'odin'),
  heroAnubis: hero('anubis', 'zeus'),

  // Conquest, found by skipping the bot match ahead (finders get living units and living gods)
  cqVista: flight([16, 30, -150, 0, 0, -100], [6, 17, -66, 0, 0, -10], { skip: 28, frames: 75, dur: 2.5 }),
  cqClash: conquest(`(us) => {
    const m = us.filter((u) => u.kind === 'minion' && Math.abs(u.x) < 14 && Math.abs(u.z) < 60);
    const o = m.filter((u) => u.team === 'order'), c = m.filter((u) => u.team === 'chaos');
    if (o.length < 3 || c.length < 3) return null;
    const near = o.filter((a) => c.some((b) => Math.hypot(a.x - b.x, a.z - b.z) < 7));
    return near.length >= 3 ? m.filter((u) => near.some((a) => Math.hypot(a.x - u.x, a.z - u.z) < 12)) : null;
  }`, { skip: 20, limit: 120, frames: 66, cam: { r: 11, h: 4.5, a0: 1.2, sweep: 0.35 } }),
  cqTower: conquest(`(us) => {
    const t = us.find((u) => u.kind === 'tower' && us.some((m) => m.kind === 'minion' && m.team !== u.team && Math.hypot(m.x - u.x, m.z - u.z) < 13));
    return t ? [t, t, t, ...us.filter((m) => m.kind === 'minion' && m.team !== t.team && Math.hypot(m.x - t.x, m.z - t.z) < 13)] : null;
  }`, { skip: 40, limit: 300, frames: 66, cam: { r: 18, h: 9, a0: 2.4, sweep: 0.3 } }),
  cqPhoenix: flight([14, 6, -82, 0, 5, -96], [-12, 9, -80, 0, 4, -96], { skip: 5, frames: 66 }),
  cqTitan: flight([-18, 5, -96, 0, 9, -118], [12, 3.5, -98, 0, 10, -118], { skip: 5, frames: 66, fov: 55 }),
  cqJungle: conquest(`(us, gods) => {
    const m = us.find((u) => u.kind === 'monster' && u.radius <= 2.2 && u.combatant.health < u.combatant.stats.maxHealth * 0.85 && gods.some((g) => Math.hypot(g.x - u.x, g.z - u.z) < 7));
    return m ? [m, ...gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 7)] : null;
  }`, { skip: 10, limit: 200, frames: 66, cam: { r: 9, h: 4, a0: 0.8, sweep: 0.4 } }),
  cqWyrm: conquest(`(us, gods) => {
    const m = us.find((u) => u.name === 'Treasure Wyrm' && u.combatant.health < u.combatant.stats.maxHealth * 0.95 && gods.filter((g) => Math.hypot(g.x - u.x, g.z - u.z) < 14).length >= 2);
    return m ? [m, m, ...gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 14)] : null;
  }`, { skip: 118, limit: 600, frames: 66, cam: { r: 16, h: 6, a0: 2.0, sweep: 0.4 } }),
  cqColossus: conquest(`(us, gods) => {
    const m = us.find((u) => u.name === 'Molten Colossus' && u.combatant.health < u.combatant.stats.maxHealth * 0.95 && gods.filter((g) => Math.hypot(g.x - u.x, g.z - u.z) < 15).length >= 2);
    return m ? [m, m, ...gods.filter((g) => Math.hypot(g.x - m.x, g.z - m.z) < 15)] : null;
  }`, { skip: 298, limit: 700, frames: 66, cam: { r: 18, h: 7, a0: -0.8, sweep: 0.4 } }),
  cqFight: conquest(`(us, gods) => {
    for (const a of gods) {
      const near = gods.filter((g) => Math.hypot(g.x - a.x, g.z - a.z) < 16);
      if (near.filter((g) => g.team === 'order').length >= 2 && near.filter((g) => g.team === 'chaos').length >= 2) return near;
    }
    return null;
  }`, { skip: 60, limit: 900, frames: 75, cam: { r: 15, h: 6.5, a0: 1.0, sweep: 0.45 } }),
  // three against three on the temple plaza, every god at level 20
  brawlA: brawl(['zeus', 'odin', 'anubis'], ['thor', 'loki', 'odin'], { a0: 1.4 }),
  brawlB: brawl(['thor', 'loki', 'zeus'], ['anubis', 'zeus', 'thor'], { a0: -1.2 }),

  probeConquest: {
    url: 'map=conquest&god=thor&quality=medium',
    frames: 1,
    setup: `(s, g) => {
      const out = [];
      const L = (x, z) => Math.round(g.world.collision.groundAt(x, z) * 10) / 10;
      out.push({ ground: { orderFountain: L(0, -138), titan: L(0, -118), phoenixMid: L(0, -96), mid: L(0, 0), wyrm: L(56, 0), colossus: L(-56, 0), might: L(-46, -48) } });
      for (const sec of [30, 60, 120, 180, 240, 300, 360]) {
        s.skip(sec - s.skipped);
        const us = s.combat.sim.units.filter((u) => u.alive);
        const gods = us.filter((u) => u.kind === 'god').map((u) => u.name[0] + u.team[0] + Math.round(u.x) + ',' + Math.round(u.z));
        const bosses = us.filter((u) => u.kind === 'monster' && u.radius > 2).map((u) => u.name + ' ' + Math.round(u.combatant.health));
        const minions = us.filter((u) => u.kind === 'minion').length;
        const hurt = us.filter((u) => (u.kind === 'tower' || u.kind === 'phoenix') && u.combatant.health < u.combatant.stats.maxHealth).map((u) => u.name + Math.round(u.x) + ',' + Math.round(u.z));
        out.push({ sec, gods: gods.join(' '), bosses, minions, hurt });
      }
      return out;
    }`,
    director: '(dt, t, s) => s.look(0, 60, -40, 0, 0, 0, 55)',
  },
};
