import { fbm2, simplex2, smoothstep as sstep } from '../../core/random';
import { ConquestLayout as L, type Vec2 } from '../../map/ConquestLayout';
import type { GrassField } from '../Grass';
import type { TerrainDef } from '../Terrain';
import { hypot } from '../../core/math';

/** Grass verge on each side of a paved lane that is still walkable. */
const LANE_VERGE = 5;
/** Walkable jungle on each side of a dirt path's edge. */
const PATH_VERGE = 4.5;
/** Extra walkable ring around every plaza circle. */
const PLAZA_VERGE = 2;
/** Height of the jungle walls between corridors. */
const WALL_HEIGHT = 5.5;

export interface ConquestTerrainDef extends TerrainDef {
  /** Meters to the nearest jungle wall: positive where gods can walk. */
  walkable(x: number, z: number): number;
  /** Distance to the nearest lane's paved edge (negative on the lane). */
  laneDistance(x: number, z: number): number;
  /** Distance to the nearest dirt path's edge (negative on the path). */
  pathDistance(x: number, z: number): number;
  /** Distance to the nearest plaza edge (negative inside one). */
  plazaDistance(x: number, z: number): number;
  grass: GrassField;
}

/** A scalar field sampled on a regular grid, read back with bilinear filtering. */
class FieldGrid {
  private readonly data: Float32Array;
  private readonly n: number;

  constructor(private readonly half: number, private readonly cell: number, fn: (x: number, z: number) => number) {
    this.n = Math.ceil((half * 2) / cell) + 1;
    this.data = new Float32Array(this.n * this.n);
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) this.data[j * this.n + i] = fn(-half + i * cell, -half + j * cell);
    }
  }

  sample(x: number, z: number): number {
    const fx = Math.min(Math.max((x + this.half) / this.cell, 0), this.n - 1.001);
    const fz = Math.min(Math.max((z + this.half) / this.cell, 0), this.n - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * this.n + i;
    const d = this.data;
    return (d[k]! * (1 - tx) + d[k + 1]! * tx) * (1 - tz) + (d[k + this.n]! * (1 - tx) + d[k + this.n + 1]! * tx) * tz;
  }
}

function segDist(px: number, pz: number, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * abx + (pz - a[1]) * abz) / (abx * abx + abz * abz || 1)));
  return hypot(px - (a[0] + abx * t), pz - (a[1] + abz * t));
}

function polyDist(px: number, pz: number, pts: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, pz, pts[i - 1]!, pts[i]!));
  return d;
}

/**
 * Conquest terrain: paved lanes and jungle corridors cut through raised,
 * overgrown rock walls, inside a ring of cliffs and distant mountains. Every
 * shape comes from `ConquestLayout`, so gameplay and visuals always agree.
 */
export function conquestTerrain(): ConquestTerrainDef {
  const E = L.halfExtent;
  const plazas = L.plazas;
  const laneD = (x: number, z: number) => {
    let d = Infinity;
    for (const l of L.lanes) d = Math.min(d, polyDist(x, z, l.points) - l.width / 2);
    return d;
  };
  const pathD = (x: number, z: number) => {
    let d = Infinity;
    for (const p of L.paths) d = Math.min(d, polyDist(x, z, p.points) - p.width / 2);
    return d;
  };
  const plazaD = (x: number, z: number) => {
    let d = Infinity;
    for (const p of plazas) d = Math.min(d, hypot(x - p.at[0], z - p.at[1]) - p.radius);
    return d;
  };

  const n1 = simplex2(201);
  const n2 = simplex2(202);
  const n3 = simplex2(203);
  const half = E + 20;
  const cell = 0.75;
  const lane = new FieldGrid(half, cell, laneD);
  const path = new FieldGrid(half, cell, pathD);
  const plaza = new FieldGrid(half, cell, plazaD);
  // The walls wander a little so corridors don't look machine-cut.
  const open = new FieldGrid(half, cell, (x, z) => {
    const wobble = fbm2(n1, x * 0.06, z * 0.06, 3) * 1.6;
    return Math.max(LANE_VERGE - laneD(x, z), PATH_VERGE - pathD(x, z), PLAZA_VERGE - plazaD(x, z)) + wobble;
  });

  /** Meters past the playable square's edge (negative inside). */
  const border = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z)) - E + fbm2(n2, x * 0.015, z * 0.015, 3) * 10;

  const height = (x: number, z: number): number => {
    const o = open.sample(x, z);
    const ld = lane.sample(x, z);
    const pd = plaza.sample(x, z);
    // jungle walls: steep rocky sides, lumpy overgrown tops
    const depth = -o;
    const ridge = 1 - Math.abs(fbm2(n3, x * 0.03, z * 0.03, 4));
    const wallH = WALL_HEIGHT + ridge * 3 + fbm2(n1, x * 0.11, z * 0.11, 3) * 1.2;
    let h = sstep(-0.6, 3.8, depth) * wallH;
    // terraced ledges partway up, like the arena's cliffs
    h += sstep(4, 14, depth) * (2 + ridge * 4);
    // cliffs and mountains beyond the playable square
    const b = border(x, z);
    h += sstep(-14, 26, b) * (24 + ridge * 26 + fbm2(n2, x * 0.01, z * 0.01, 3) * 14);
    h += sstep(60, 160, b) * (50 + fbm2(n3, x * 0.004, z * 0.004, 4) * 50);
    // gentle undulation in the open jungle, flat on lanes and plazas
    const flat = 1 - sstep(0.5, 6, Math.min(ld, pd));
    h += fbm2(n2, x * 0.05, z * 0.05, 3) * 0.45 * (1 - flat);
    // slight dip along dirt paths
    h -= (1 - sstep(-1, 2.5, path.sample(x, z))) * 0.12 * (1 - flat);
    return h * (1 - flat * (1 - sstep(0, 3, depth)));
  };

  const nMask = simplex2(204);
  return {
    size: 2 * E + 420,
    segments: 560,
    maskSize: 2 * half,
    maskRes: 1024,
    height,
    walkable: (x, z) => Math.min(open.sample(x, z), -border(x, z) - 2),
    laneDistance: (x, z) => lane.sample(x, z),
    pathDistance: (x, z) => path.sample(x, z),
    plazaDistance: (x, z) => plaza.sample(x, z),
    mask(x, z) {
      const edge = fbm2(nMask, x * 0.25, z * 0.25, 3);
      const ld = lane.sample(x, z) + edge * 0.5;
      const pd = path.sample(x, z) + edge * 0.9;
      // structure pads and the base courtyards are paved; camps are dirt clearings
      let pavedPad = Infinity;
      let campD = Infinity;
      for (const s of [...L.towers, ...L.phoenixes]) pavedPad = Math.min(pavedPad, hypot(x - s.at[0], z - s.at[1]) - L.radii.structurePad);
      for (const b of L.bases) {
        pavedPad = Math.min(pavedPad, hypot(x - b.plaza.at[0], z - b.plaza.at[1]) - b.plaza.radius);
        pavedPad = Math.min(pavedPad, hypot(x - b.fountain[0], z - b.fountain[1]) - L.radii.fountain - 2);
      }
      // buff camps and the Wyrm's hoard sit on old paved floors inside their dirt clearing
      let campFloor = Infinity;
      for (const c of L.camps) {
        const d = hypot(x - c.at[0], z - c.at[1]);
        campD = Math.min(campD, d - (c.team === null ? L.radii.boss : L.radii.camp));
        if (c.kind !== 'small' && c.kind !== 'moltenColossus') campFloor = Math.min(campFloor, d - (c.team === null ? L.radii.boss - 0.8 : L.radii.camp - 0.2));
      }
      const paved = Math.max(1 - sstep(-0.4, 0.3, ld), 1 - sstep(-0.6, 0.4, pavedPad + edge * 0.8), 1 - sstep(-0.5, 0.3, campFloor + edge * 0.5));
      const dirt = Math.max(
        1 - sstep(-0.6, 1.4, pd),
        (1 - sstep(0, 2.2, ld)) * 0.85,
        (1 - sstep(-1, 2.5, campD + edge * 2)) * 0.95,
        (1 - sstep(0, 3, pavedPad + edge * 2)) * 0.8,
      );
      const damp = Math.max(0, fbm2(nMask, x * 0.05, z * 0.05, 3)) * 0.8;
      const macro = fbm2(nMask, x * 0.015 + 100, z * 0.015, 4) * 0.5 + 0.5;
      return [Math.min(1, dirt), paved, damp, macro];
    },
    grass: {
      extent: E + 12,
      round: false,
      density: 0.6,
      maxHeight: 14,
      // no grass on the jungle wall tops: nobody walks there, the trees cover
      // them, and sunlit tufts along the crests read as glowing fringes
      reject: (x, z) => plaza.sample(x, z) < -0.5 || open.sample(x, z) < -3,
    },
  };
}
