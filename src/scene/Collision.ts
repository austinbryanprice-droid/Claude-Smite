import { hypot } from '../core/math';
/**
 * Lightweight 2D (XZ) collision world for the arena. Static architecture
 * registers circles and oriented boxes; moving actors are resolved as circles.
 * Heights let short obstacles (low rubble) be stepped over.
 */
export interface CircleCollider {
  kind: 'circle';
  x: number;
  z: number;
  r: number;
  top: number;
}

export interface BoxCollider {
  kind: 'box';
  x: number;
  z: number;
  /** Half extents along the box's local X and Z axes. */
  hx: number;
  hz: number;
  /** Rotation around Y, radians. */
  yaw: number;
  top: number;
}

export type Collider = CircleCollider | BoxCollider;

/** Side of a lookup cell, in meters. */
const CELL = 8;
const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
const ascending = (a: number, b: number) => a - b;

/** Anything that can report a walkable height at a point (or null if not over it). */
export type GroundSurface = (x: number, z: number) => number | null;

export class CollisionWorld {
  readonly colliders: Collider[] = [];
  private readonly cameraBlockers: Collider[] = [];
  private readonly surfaces: GroundSurface[] = [];
  /** Signed distance to the edge of the walkable area (positive inside), if the map has walls. */
  private walkable: ((x: number, z: number) => number) | null = null;
  /** Indices of the colliders whose bounds touch each cell, so a query only visits its neighbours. */
  private readonly cells = new Map<number, number[]>();
  /** Last query that visited each collider (dedupes colliders spanning several cells). */
  private readonly seen: number[] = [];
  private query = 0;
  private readonly nearIdx: number[] = [];
  private readonly near: Collider[] = [];

  constructor(private readonly baseGround: (x: number, z: number) => number) {}

  addCircle(x: number, z: number, r: number, top = Infinity): void {
    this.add({ kind: 'circle', x, z, r, top });
  }

  addBox(x: number, z: number, hx: number, hz: number, yaw: number, top = Infinity): void {
    this.add({ kind: 'box', x, z, hx, hz, yaw, top });
  }

  private add(c: Collider): void {
    const i = this.colliders.push(c) - 1;
    this.seen.push(0);
    const r = c.kind === 'circle' ? c.r : hypot(c.hx, c.hz);
    for (let cx = Math.floor((c.x - r) / CELL); cx <= Math.floor((c.x + r) / CELL); cx++) {
      for (let cz = Math.floor((c.z - r) / CELL); cz <= Math.floor((c.z + r) / CELL); cz++) {
        const k = cellKey(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }

  /**
   * The colliders whose bounds touch the box [x0, x1] x [z0, z1], in the order
   * they were added (so results match a scan of every collider). The array is
   * reused by the next query.
   */
  private gather(x0: number, z0: number, x1: number, z1: number): readonly Collider[] {
    const q = ++this.query;
    const idx = this.nearIdx;
    idx.length = 0;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const i of list) {
          if (this.seen[i] === q) continue;
          this.seen[i] = q;
          idx.push(i);
        }
      }
    }
    idx.sort(ascending);
    const near = this.near;
    near.length = idx.length;
    for (let k = 0; k < idx.length; k++) near[k] = this.colliders[idx[k]!]!;
    return near;
  }

  /**
   * Adds an obstacle only the camera ray sees (units and shots pass through,
   * e.g. structures the sim already handles). Returned so its `top` can change.
   */
  addCameraBlocker(c: Collider): Collider {
    this.cameraBlockers.push(c);
    return c;
  }

  /** Confines movement to where `field` is positive (meters to the nearest wall). */
  setWalkable(field: (x: number, z: number) => number): void {
    this.walkable = field;
  }

  addSurface(s: GroundSurface): void {
    this.surfaces.push(s);
  }

  /** Highest walkable height at (x, z). */
  groundAt(x: number, z: number): number {
    let h = this.baseGround(x, z);
    for (const s of this.surfaces) {
      const v = s(x, z);
      if (v !== null && v > h) h = v;
    }
    return h;
  }

  /**
   * Pushes a circle of `radius` at (x, z) out of every collider taller than
   * `feetY + stepHeight`. Returns the corrected position.
   */
  resolve(x: number, z: number, radius: number, feetY: number, stepHeight = 0.55): { x: number; z: number } {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      // a meter of slack covers the pushes earlier colliders make this pass
      const reach = radius + 1;
      for (const c of this.gather(x - reach, z - reach, x + reach, z + reach)) {
        if (c.top <= feetY + stepHeight) continue;
        if (c.kind === 'circle') {
          const dx = x - c.x;
          const dz = z - c.z;
          const d = hypot(dx, dz);
          const min = c.r + radius;
          if (d < min && d > 1e-6) {
            x = c.x + (dx / d) * min;
            z = c.z + (dz / d) * min;
            moved = true;
          }
        } else {
          const cos = Math.cos(c.yaw);
          const sin = Math.sin(c.yaw);
          const lx = (x - c.x) * cos - (z - c.z) * sin;
          const lz = (x - c.x) * sin + (z - c.z) * cos;
          const cx = Math.max(-c.hx, Math.min(c.hx, lx));
          const cz = Math.max(-c.hz, Math.min(c.hz, lz));
          let dx = lx - cx;
          let dz = lz - cz;
          const d = hypot(dx, dz);
          let nlx = lx;
          let nlz = lz;
          if (d < 1e-6) {
            // center inside the box: push out along the shallowest axis
            const px = c.hx - Math.abs(lx);
            const pz = c.hz - Math.abs(lz);
            if (px < pz) nlx = Math.sign(lx || 1) * (c.hx + radius);
            else nlz = Math.sign(lz || 1) * (c.hz + radius);
            moved = true;
          } else if (d < radius) {
            dx /= d;
            dz /= d;
            nlx = cx + dx * radius;
            nlz = cz + dz * radius;
            moved = true;
          } else {
            continue;
          }
          x = c.x + nlx * cos + nlz * sin;
          z = c.z - nlx * sin + nlz * cos;
        }
      }
      if (this.walkable) {
        const f = this.walkable(x, z);
        if (f < radius) {
          // push out along the field's gradient
          const e = 0.3;
          const gx = this.walkable(x + e, z) - this.walkable(x - e, z);
          const gz = this.walkable(x, z + e) - this.walkable(x, z - e);
          const g = hypot(gx, gz);
          if (g > 1e-6) {
            x += (gx / g) * (radius - f);
            z += (gz / g) * (radius - f);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    return { x, z };
  }

  /**
   * Distance along a ray (XZ only, plus a height check) to the first collider,
   * used by the camera to avoid clipping into columns and walls.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, radius = 0.3): number {
    const best = maxDist;
    // Units can walk through camera-only blockers; when the ray starts inside
    // one (the player is in a tower), ignore it rather than pin the camera there.
    const blockers = this.cameraBlockers.filter((c) => !hitsAny([c], ox, oy, oz, 0));
    const steps = Math.ceil(maxDist / 0.25);
    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    const near = this.gather(Math.min(ox, ex) - radius, Math.min(oz, ez) - radius, Math.max(ox, ex) + radius, Math.max(oz, ez) + radius);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (y < this.groundAt(x, z) + 0.25) return Math.max(0, t - 0.25);
      if (hitsAny(near, x, y, z, radius) || hitsAny(blockers, x, y, z, radius)) return Math.max(0, t - 0.25);
    }
    return best;
  }
}

/** Whether a sphere-ish probe of `radius` at (x, y, z) is inside any collider below its top. */
function hitsAny(colliders: readonly Collider[], x: number, y: number, z: number, radius: number): boolean {
  for (const c of colliders) {
    if (y > c.top) continue;
    if (c.kind === 'circle') {
      if (hypot(x - c.x, z - c.z) < c.r + radius) return true;
    } else {
      const cos = Math.cos(c.yaw);
      const sin = Math.sin(c.yaw);
      const lx = (x - c.x) * cos - (z - c.z) * sin;
      const lz = (x - c.x) * sin + (z - c.z) * cos;
      if (Math.abs(lx) < c.hx + radius && Math.abs(lz) < c.hz + radius) return true;
    }
  }
  return false;
}
