import { describe, expect, it } from 'vitest';
import { godById } from '../game/gods';
import type { PlayerController } from '../player/PlayerController';
import { godUnit } from '../sim/factory';
import { LaneBot, spawnPoint } from '../sim/LaneBot';
import { conquestBases, Match } from '../sim/Match';
import { Sim, type SimTerrain } from '../sim/Sim';
import type { Body } from '../sim/Unit';
import { NetGuest, NetHost } from './NetGame';
import type { Roster } from './Replica';
import { roster, type NetPlayer } from './roster';
import type { Msg, NetSession } from './Session';

const flat: SimTerrain = { groundAt: () => 0, resolve: (x, z) => ({ x, z }) };
const DT = 1 / 60;
const players: NetPlayer[] = [
  { id: 'h', name: 'Player 1', god: 'zeus', team: 'order' },
  { id: 'g', name: 'Player 2', god: 'thor', team: 'order' },
];

/** Two ends of a session joined in memory; messages arrive when `flush` runs (one network hop). */
function pair() {
  const wire: [string, string, string][] = [];
  const handlers = new Map<string, (from: string, msg: Msg) => void>();
  const end = (me: string, host: boolean) =>
    ({
      isHost: host,
      me,
      players,
      guests: host ? ['g'] : [],
      onLeave: () => undefined,
      listen: (h: (from: string, msg: Msg) => void) => handlers.set(me, h),
      send: (_to: string, msg: Msg | string) => wire.push([host ? 'g' : 'h', host ? 'h' : 'g', typeof msg === 'string' ? msg : JSON.stringify(msg)]),
      broadcast: (msg: Msg | string) => wire.push(['g', 'h', typeof msg === 'string' ? msg : JSON.stringify(msg)]),
    }) as unknown as NetSession;
  const flush = () => {
    for (const [to, from, text] of wire.splice(0)) handlers.get(to)?.(host_(from), JSON.parse(text) as Msg);
  };
  const host_ = (from: string) => (from === 'h' ? 'host' : from);
  return { host: end('h', true), guest: end('g', false), flush };
}

function build(sim: Sim, match: Match, body: (s: ReturnType<typeof roster>[number]) => Body | undefined, bots: boolean) {
  const slots = roster(players);
  const units = slots.map((s) => {
    const u = godUnit(godById(s.god)!, s.team, spawnPoint(s.team, s.spot), body(s));
    if (bots && !s.player) u.brain = new LaneBot(sim, match, u, s.role);
    return u;
  });
  for (const u of units) match.addGod(u);
  return { slots, units, roster: { slots: units, structures: match.structures } as Roster };
}

describe('networked players', () => {
  it("moves a guest's god by their input, hands it back after a teleport, and casts for them", () => {
    const net = pair();
    const hsim = new Sim(flat, conquestBases(), () => 0.5);
    const hmatch = new Match(hsim, godById('zeus')!);
    const host = new NetHost(net.host, hsim, () => undefined, () => undefined);
    const h = build(hsim, hmatch, (s) => (s.player === 'g' ? host.bodyFor(s, spawnPoint(s.team, s.spot)) : undefined), true);
    host.bind(hmatch, h.roster, h.slots);
    const remote = h.units[h.slots.findIndex((s) => s.player === 'g')]!;

    const gsim = new Sim(flat, conquestBases(), () => 0.5);
    const gmatch = new Match(gsim, godById('zeus')!);
    const g = build(gsim, gmatch, () => undefined, false);
    gsim.listeners.length = 0;
    const self = g.units[g.slots.findIndex((s) => s.player === 'g')]!;
    const pos = { x: self.x, y: 0, z: self.z, set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; } };
    const ctrl = { position: pos, yaw: self.body.yaw, spawn(x: number, z: number, yaw: number) { pos.set(x, 0, z); this.yaw = yaw; } };
    const guest = new NetGuest(net.guest, gsim, gmatch, g.roster, self, ctrl as unknown as PlayerController);

    const step = (n: number, move?: () => void) => {
      for (let i = 0; i < n; i++) {
        move?.();
        // the guest's body follows its controller, as CombatGame's body adapter does
        self.body.x = pos.x;
        self.body.z = pos.z;
        guest.step(DT);
        net.flush();
        if (host.started) {
          host.beforeStep();
          hmatch.step(DT);
          hsim.step(DT);
          host.afterStep(DT);
        } else host.wait(DT);
        net.flush();
      }
    };
    host.ready();
    guest.ready();
    step(30);
    expect(host.started).toBe(true);
    expect(guest.live).toBe(true);

    // walking: the host's copy of the god follows the guest's controller
    const start = { x: remote.x, z: remote.z };
    step(60, () => (pos.z -= 5 * DT));
    expect(remote.z).toBeLessThan(start.z - 3.5);
    expect(Math.hypot(remote.vx, remote.vz)).toBeGreaterThan(3);

    // the host moves the god itself: the guest's stale inputs are ignored and its controller snaps there
    hsim.teleport(remote, 10, 10, 0);
    step(30, () => (pos.z -= 5 * DT));
    expect(Math.hypot(remote.x - 10, remote.z - 10)).toBeLessThan(3);
    expect(Math.hypot(pos.x - 10, pos.z - 10)).toBeLessThan(3);

    // a cast request spends the god's mana on the host
    remote.combatant.gainXp(1e6);
    const mana = remote.combatant.mana;
    self.aim.x = remote.x;
    self.aim.z = remote.z - 10;
    step(10);
    guest.cast(0);
    step(10);
    expect(remote.combatant.mana).toBeLessThan(mana);
  });
});
