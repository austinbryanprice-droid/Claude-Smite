/**
 * Single source of truth for where things are in the temple arena. Terrain,
 * grass, architecture and collision all read from here so they stay in sync.
 * Units are meters; +Y is up; the temple sits at the origin.
 */
export const Arena = {
  terrainSize: 520,
  /** Playable valley radius; cliffs start rising beyond it. */
  valleyRadius: 78,
  /** Region (centered) covered by the terrain splat mask texture. */
  maskSize: 260,

  plaza: {
    radius: 17,
    stepCount: 3,
    stepHeight: 0.32,
    stepDepth: 0.95,
    /** Top surface height of the temple platform. */
    get topY(): number {
      return this.stepCount * this.stepHeight;
    },
    /** Outer radius of the lowest step. */
    get baseRadius(): number {
      return this.radius + this.stepCount * this.stepDepth;
    },
    columnRing: 14.2,
    columnCount: 14,
    columnHeight: 8.2,
    columnRadius: 0.62,
  },

  /** Paved lanes leaving the plaza north and south, ending in canyons. */
  lanes: [
    { from: [0, -19], to: [0, -150], width: 8.5 },
    { from: [0, 19], to: [0, 150], width: 8.5 },
  ] as { from: [number, number]; to: [number, number]; width: number }[],

  /** Dirt jungle paths, as polylines. */
  paths: [
    { points: [[-19, 2], [-30, 6], [-42, 2], [-55, -8], [-70, -10], [-95, -6]], width: 3.2 },
    { points: [[19, -2], [31, -7], [44, -3], [57, 8], [72, 10], [95, 4]], width: 3.2 },
  ] as { points: [number, number][]; width: number }[],

  /** Player spawn: on the south lane, looking north at the temple. */
  spawn: { x: 0, z: 34, yaw: 0 },
};

/** Distance from point p to segment ab in the XZ plane. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz)));
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Distance to the nearest lane centerline, in meters. */
export function laneDistance(x: number, z: number): number {
  let d = Infinity;
  for (const l of Arena.lanes) d = Math.min(d, distToSegment(x, z, l.from[0], l.from[1], l.to[0], l.to[1]) - l.width / 2);
  return d;
}

/** Distance to the nearest dirt path edge (negative inside the path). */
export function pathDistance(x: number, z: number): number {
  let d = Infinity;
  for (const p of Arena.paths) {
    for (let i = 0; i < p.points.length - 1; i++) {
      const [ax, az] = p.points[i]!;
      const [bx, bz] = p.points[i + 1]!;
      d = Math.min(d, distToSegment(x, z, ax, az, bx, bz) - p.width / 2);
    }
  }
  return d;
}
