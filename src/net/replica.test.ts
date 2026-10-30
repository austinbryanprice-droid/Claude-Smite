import { describe, expect, it } from 'vitest';
import { godById } from '../game/gods';
import { godUnit } from '../sim/factory';
import { LaneBot, spawnPoint } from '../sim/LaneBot';
import { conquestBases, Match } from '../sim/Match';
import { Sim, type SimTerrain } from '../sim/Sim';
import type { SimEvent, Unit } from '../sim/Unit';
import { GuestSync, HostSync, SNAPSHOT_EVERY, type Roster, type Snapshot } from './Replica';
import { roster, type NetPlayer } from './roster';
import { encode } from './Session';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const DT = 1 / 60;
const players: NetPlayer[] = [
  { id: 'h', name: 'Player 1', god: 'zeus', team: 'order' },
  { id: 'g', name: 'Player 2', god: 'thor', team: 'chaos' },
];

function build(bots: boolean) {
  const sim = new Sim(flat, conquestBases(), () => 0.5);
  const match = new Match(sim, godById('zeus')!);
  const slots = roster(players);
  const units = slots.map((s) => {
    const u = godUnit(godById(s.god)!, s.team, spawnPoint(s.team, s.spot));
    if (bots) u.brain = new LaneBot(sim, match, u, s.role);
    return u;
  });
  for (const u of units) match.addGod(u);
  const r: Roster = { slots: units, structures: match.structures };
  return { sim, match, roster: r, slots };
}

describe('networked match copy', () => {
  it('fills slots with humans first and bots on the gods left over', () => {
    const slots = roster(players);
    expect(slots).toHaveLength(10);
    expect(slots.filter((s) => s.player)).toHaveLength(2);
    expect(slots.find((s) => s.player === 'h')).toMatchObject({ team: 'order', spot: 1, god: 'zeus' });
    const order = slots.filter((s) => s.team === 'order').map((s) => s.god);
    expect(new Set(order).size).toBe(5);
  });

  it("follows the host's match on a delay: positions, health, units, events and score", () => {
    const host = build(true);
    const guest = build(false);
    // the guest's match never reacts to events itself
    guest.sim.listeners.length = 0;
    const self = guest.roster.slots[guest.slots.findIndex((s) => s.player === 'g')]!;
    const sync = new HostSync(host.sim, host.match, host.roster, () => 0);
    sync.addGuest('g');
    const copy = new GuestSync(guest.sim, guest.match, guest.roster, self);

    const hostDeaths: SimEvent[] = [];
    host.sim.listeners.push((e) => e.type === 'death' && hostDeaths.push(e));
    let guestDeaths = 0;
    guest.sim.listeners.push((e) => e.type === 'death' && guestDeaths++);

    // the host's picture at each snapshot, to compare against the guest's delayed one
    const history: { t: number; at: Map<number, { x: number; z: number; hp: number }> }[] = [];
    const steps = Math.round(100 / DT);
    let bytes = 0;
    for (let i = 1; i <= steps; i++) {
      host.match.step(DT);
      host.sim.step(DT);
      if (i % SNAPSHOT_EVERY === 0) {
        for (const [, snap] of sync.snapshots()) {
          const text = encode(snap);
          if (i > steps / 2) bytes += text.length;
          copy.receive(JSON.parse(text) as Snapshot);
        }
        history.push({ t: host.sim.time, at: new Map(host.sim.units.map((u) => [u.id, { x: u.x, z: u.z, hp: u.combatant.health }])) });
      }
      copy.step(DT);
    }

    // minions and jungle camps were made on the guest's side too
    const kinds = (units: Unit[]) => units.filter((u) => u.kind === 'minion' || u.kind === 'monster').length;
    expect(kinds(guest.sim.units)).toBeGreaterThan(20);
    expect(Math.abs(kinds(guest.sim.units) - kinds(host.sim.units))).toBeLessThan(15);

    // every unit stands where the host had it at the guest's (delayed) clock
    const rt = guest.sim.time;
    const k = history.findIndex((h) => h.t > rt);
    const [a, b] = [history[k - 1]!, history[k]!];
    const w = (rt - a.t) / (b.t - a.t);
    const byId = (copy as unknown as { byId: Map<number, Unit> }).byId;
    let compared = 0;
    for (const [id, u] of byId) {
      if (u === self) continue;
      const pa = a.at.get(id);
      const pb = b.at.get(id);
      if (!pa || !pb) continue;
      expect(Math.abs(u.x - (pa.x + (pb.x - pa.x) * w))).toBeLessThan(0.05);
      expect(Math.abs(u.z - (pa.z + (pb.z - pa.z) * w))).toBeLessThan(0.05);
      expect(Math.abs(u.combatant.health - (pa.hp + (pb.hp - pa.hp) * w))).toBeLessThan(1);
      compared++;
    }
    expect(compared).toBeGreaterThan(40);

    // deaths reached the guest's effects (all but the last fraction of a second's)
    expect(guestDeaths).toBeGreaterThan(hostDeaths.length * 0.9);
    // the score and clock match the host's
    const kills = (m: Match) => m.gods.map((g) => m.stats.get(g)!.kills + m.stats.get(g)!.minions);
    expect(kills(guest.match).reduce((x, y) => x + y)).toBeGreaterThan(0);
    expect(Math.abs(guest.match.time - host.match.time)).toBeLessThan(0.5);
    // a guest's download stays modest: well under 100 KB/s once the match is busy
    expect(bytes / 50).toBeLessThan(100_000);
  }, 30_000);
});
