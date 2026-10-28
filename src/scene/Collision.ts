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

/** Anything that can report a walkable height at a point (or null if not over it). */
export type GroundSurface = (x: number, z: number) => number | null;

export class CollisionWorld {
  readonly colliders: Collider[] = [];
  private readonly surfaces: GroundSurface[] = [];

  constructor(private readonly baseGround: (x: number, z: number) => number) {}

  addCircle(x: number, z: number, r: number, top = Infinity): void {
    this.colliders.push({ kind: 'circle', x, z, r, top });
  }

  addBox(x: number, z: number, hx: number, hz: number, yaw: number, top = Infinity): void {
    this.colliders.push({ kind: 'box', x, z, hx, hz, yaw, top });
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
      for (const c of this.colliders) {
        if (c.top <= feetY + stepHeight) continue;
        if (c.kind === 'circle') {
          const dx = x - c.x;
          const dz = z - c.z;
          const d = Math.hypot(dx, dz);
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
          const d = Math.hypot(dx, dz);
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
    const steps = Math.ceil(maxDist / 0.25);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (y < this.groundAt(x, z) + 0.25) return Math.max(0, t - 0.25);
      for (const c of this.colliders) {
        if (y > c.top) continue;
        if (c.kind === 'circle') {
          if (Math.hypot(x - c.x, z - c.z) < c.r + radius) return Math.max(0, t - 0.25);
        } else {
          const cos = Math.cos(c.yaw);
          const sin = Math.sin(c.yaw);
          const lx = (x - c.x) * cos - (z - c.z) * sin;
          const lz = (x - c.x) * sin + (z - c.z) * cos;
          if (Math.abs(lx) < c.hx + radius && Math.abs(lz) < c.hz + radius) return Math.max(0, t - 0.25);
        }
      }
    }
    return best;
  }
}
