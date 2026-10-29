/**
 * The Conquest map as data: where every lane, structure, fountain and camp
 * sits. The simulation reads it for gameplay and the scene builds terrain and
 * meshes from it, so this file is the single source of truth for both.
 *
 * Meters on the XZ plane, +Y up, map centered on the origin. Order's base is
 * at -Z and Chaos's at +Z. The map is mirror-symmetric across z = 0 (Chaos
 * positions are Order's with z negated), so lanes keep their side of the map
 * for both teams: Solo on -X, Duo on +X.
 *
 * Scale: about 70% of Smite's Conquest (design.md, section 5). A god runs
 * about 6.6 m/s, so walking mid lane Phoenix to Phoenix takes about 30 s.
 */

export type Team = 'order' | 'chaos';
export type LaneId = 'solo' | 'mid' | 'duo';
export type Vec2 = readonly [number, number];

export interface Lane {
  id: LaneId;
  /** Centerline from Order's Phoenix to Chaos's Phoenix. */
  points: readonly Vec2[];
  /** Paved width, meters. */
  width: number;
}

export interface Path {
  points: readonly Vec2[];
  width: number;
}

export type CampKind = 'might' | 'wisdom' | 'swiftness' | 'insight' | 'small' | 'treasureWyrm' | 'moltenColossus';

export interface Camp {
  id: string;
  kind: CampKind;
  /** Owning side; neutral bosses have none. */
  team: Team | null;
  at: Vec2;
}

export interface Tower {
  id: string;
  team: Team;
  lane: LaneId;
  tier: 'outer' | 'inner';
  at: Vec2;
}

export interface Phoenix {
  id: string;
  team: Team;
  lane: LaneId;
  at: Vec2;
}

export interface Base {
  team: Team;
  fountain: Vec2;
  titan: Vec2;
  /** Where gods spawn and respawn, facing the enemy base. */
  spawn: { x: number; z: number; yaw: number };
  /** Open stone courtyard around the Titan. */
  plaza: { at: Vec2; radius: number };
}

/** Mirror an Order position to Chaos's side. */
const mirror = (p: Vec2): Vec2 => [p[0], -p[1]];

/** Order half of a lane, from its Phoenix to the center line. */
const HALF_LANES: Record<LaneId, readonly Vec2[]> = {
  mid: [[0, -96], [0, -48], [0, 0]],
  solo: [[-24, -100], [-58, -88], [-84, -58], [-94, -22], [-95, 0]],
  duo: [[24, -100], [58, -88], [84, -58], [94, -22], [95, 0]],
};

function fullLane(half: readonly Vec2[]): Vec2[] {
  const back = [...half].reverse().slice(1).map(mirror);
  return [...half, ...back];
}

export const ConquestLayout = {
  /** The playable map spans [-halfExtent, halfExtent] on both axes; cliffs beyond. */
  halfExtent: 150,

  radii: {
    fountain: 11,
    tower: 2.6,
    /** Towers shoot gods and minions inside this range. */
    towerRange: 16,
    phoenix: 3.4,
    phoenixRange: 14,
    titan: 6,
    titanRange: 14,
    camp: 7,
    boss: 11,
    /** Ground flattened and paved around each structure. */
    structurePad: 6,
  },

  lanes: [
    { id: 'solo', points: fullLane(HALF_LANES.solo), width: 9 },
    { id: 'mid', points: fullLane(HALF_LANES.mid), width: 10 },
    { id: 'duo', points: fullLane(HALF_LANES.duo), width: 9 },
  ] as readonly Lane[],

  bases: [
    {
      team: 'order',
      fountain: [0, -138],
      titan: [0, -118],
      spawn: { x: 0, z: -132, yaw: Math.PI },
      plaza: { at: [0, -120], radius: 26 },
    },
    {
      team: 'chaos',
      fountain: [0, 138],
      titan: [0, 118],
      spawn: { x: 0, z: 132, yaw: 0 },
      plaza: { at: [0, 120], radius: 26 },
    },
  ] as readonly Base[],

  /** Two towers per lane per side, outer first in line of fire. */
  towers: (['order', 'chaos'] as const).flatMap((team) =>
    (['solo', 'mid', 'duo'] as const).flatMap((lane) => {
      const sign = team === 'order' ? 1 : -1;
      const half = HALF_LANES[lane];
      const at = (frac: number): Vec2 => {
        const p = alongPolyline(half, frac * polylineLength(half));
        return [p[0], p[1] * sign];
      };
      return [
        { id: `${team}-${lane}-inner`, team, lane, tier: 'inner' as const, at: at(0.3) },
        { id: `${team}-${lane}-outer`, team, lane, tier: 'outer' as const, at: at(0.62) },
      ];
    }),
  ) as readonly Tower[],

  phoenixes: (['order', 'chaos'] as const).flatMap((team) =>
    (['solo', 'mid', 'duo'] as const).map((lane) => {
      const p = HALF_LANES[lane][0]!;
      return { id: `${team}-${lane}-phoenix`, team, lane, at: team === 'order' ? p : mirror(p) };
    }),
  ) as readonly Phoenix[],

  /** Dirt jungle paths linking the lanes (Order half; Chaos's are mirrored in). */
  paths: (() => {
    const order: Path[] = [
      // mid to solo and duo through the inner jungle
      { points: [[0, -70], [-22, -66], [-42, -56], [-62, -60], [-76, -70]], width: 3.4 },
      { points: [[0, -70], [22, -66], [42, -56], [62, -60], [76, -70]], width: 3.4 },
      // outer jungle loops past the buff camps
      { points: [[0, -30], [-24, -32], [-46, -28], [-66, -36], [-88, -40]], width: 3.4 },
      { points: [[0, -30], [24, -32], [46, -28], [66, -36], [88, -40]], width: 3.4 },
      // river-side paths to the bosses
      { points: [[-94, -8], [-72, -6], [-54, 0]], width: 3.8 },
      { points: [[94, -8], [72, -6], [54, 0]], width: 3.8 },
      { points: [[0, -10], [-24, -6], [-40, 0]], width: 3.8 },
      { points: [[0, -10], [24, -6], [40, 0]], width: 3.8 },
    ];
    return [...order, ...order.map((p) => ({ ...p, points: p.points.map(mirror) }))];
  })() as readonly Path[],

  camps: (() => {
    const order: Omit<Camp, 'team' | 'id'>[] = [
      { kind: 'might', at: [-46, -48] },
      { kind: 'wisdom', at: [46, -48] },
      { kind: 'swiftness', at: [-60, -22] },
      { kind: 'insight', at: [60, -22] },
      { kind: 'small', at: [-22, -78] },
      { kind: 'small', at: [22, -78] },
      { kind: 'small', at: [-30, -20] },
      { kind: 'small', at: [30, -20] },
    ];
    const camps: Camp[] = [];
    order.forEach((c, i) => {
      camps.push({ id: `order-${c.kind}-${i}`, team: 'order', ...c });
      camps.push({ id: `chaos-${c.kind}-${i}`, team: 'chaos', kind: c.kind, at: mirror(c.at) });
    });
    // neutral bosses on the center line: Treasure Wyrm on the duo side, Colossus on the solo side
    camps.push({ id: 'treasure-wyrm', kind: 'treasureWyrm', team: null, at: [56, 0] });
    camps.push({ id: 'molten-colossus', kind: 'moltenColossus', team: null, at: [-56, 0] });
    return camps;
  })() as readonly Camp[],

  /** Open circles that must stay flat and clear of foliage: structure courtyards and boss pits. */
  get plazas(): readonly { at: Vec2; radius: number }[] {
    const r = this.radii;
    return [
      ...this.bases.map((b) => b.plaza),
      ...this.bases.map((b) => ({ at: b.fountain, radius: r.fountain + 2 })),
      ...this.towers.map((t) => ({ at: t.at, radius: r.structurePad })),
      ...this.phoenixes.map((p) => ({ at: p.at, radius: r.structurePad })),
      ...this.camps.map((c) => ({ at: c.at, radius: c.team === null ? r.boss : r.camp })),
    ];
  },
};

export function baseOf(team: Team): Base {
  return ConquestLayout.bases.find((b) => b.team === team)!;
}

/** A lane's points ordered from `team`'s side toward the enemy base. */
export function laneFrom(team: Team, lane: LaneId): readonly Vec2[] {
  const pts = ConquestLayout.lanes.find((l) => l.id === lane)!.points;
  return team === 'order' ? pts : [...pts].reverse();
}

export function polylineLength(points: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return len;
}

/** The point `distance` meters along a polyline (clamped to its ends). */
export function alongPolyline(points: readonly Vec2[], distance: number): Vec2 {
  let left = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= seg) {
      const t = seg === 0 ? 0 : left / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= seg;
  }
  return points[points.length - 1]!;
}

/** Distance from (x, z) to a polyline, and how far along it the closest point is. */
export function nearestOnPolyline(points: readonly Vec2[], x: number, z: number): { distance: number; along: number } {
  let best = { distance: Infinity, along: 0 };
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const abx = bx - ax;
    const abz = bz - az;
    const seg = Math.hypot(abx, abz);
    const t = seg === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / (seg * seg)));
    const d = Math.hypot(x - (ax + abx * t), z - (az + abz * t));
    if (d < best.distance) best = { distance: d, along: walked + seg * t };
    walked += seg;
  }
  return best;
}
