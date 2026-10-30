import type { SimTerrain } from './Sim';
import type { Point } from './Unit';
import { hypot } from '../core/math';

/** Grid cell size, meters. */
const CELL = 2;
/** Clearance a cell needs to count as walkable (a god's radius plus a little). */
const CLEARANCE = 0.75;

/**
 * A walkability grid over the map, sampled from the terrain's own collision
 * (a cell is open if a god-sized circle there is not pushed anywhere), with
 * A* and string-pulling on top. Built lazily the first time a bot asks for a
 * path, since sampling the whole map takes a moment.
 */
export class Nav {
  private open: Uint8Array | null = null;
  private readonly size: number;
  private readonly origin: number;

  constructor(
    private readonly terrain: SimTerrain,
    /** The map spans [-halfExtent, halfExtent] on both axes. */
    halfExtent: number,
  ) {
    this.size = Math.ceil((halfExtent * 2) / CELL);
    this.origin = -halfExtent;
  }

  /** Sample the grid now (it takes a moment), so the first jungle trip doesn't hitch mid-match. */
  warm(): void {
    this.grid();
  }

  /** The next point to walk toward on the way from `from` to `to`. */
  next(from: Point, to: Point): Point {
    const path = this.path(from, to);
    return path[1] ?? to;
  }

  /** A walkable path from `from` to `to` (both included), or the straight line if none is found. */
  path(from: Point, to: Point): Point[] {
    const grid = this.grid();
    if (this.clear(from, to)) return [from, to];
    const s = this.nearestOpen(this.cellOf(from));
    const g = this.nearestOpen(this.cellOf(to));
    if (s < 0 || g < 0) return [from, to];
    const cells = this.astar(grid, s, g);
    if (!cells) return [from, to];
    // string-pull: keep only the corners we can't see past
    const pts: Point[] = [from, ...cells.slice(1, -1).map((c) => this.center(c)), to];
    const out: Point[] = [from];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.clear(pts[i]!, pts[j]!)) j--;
      out.push(pts[j]!);
      i = j;
    }
    return out;
  }

  /** Whether a straight walk from a to b stays on open cells. */
  clear(a: Point, b: Point): boolean {
    const grid = this.grid();
    const d = hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(d / (CELL * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const c = this.cellOf({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      if (c < 0 || !grid[c]) return false;
    }
    return true;
  }

  private grid(): Uint8Array {
    if (this.open) return this.open;
    const n = this.size;
    const open = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) open[j * n + i] = this.sample(i, j);
    return (this.open = open);
  }

  /** Re-sample the cells within `r` of `p`, after something there appeared or went away. */
  refresh(p: Point, r: number): void {
    const open = this.open;
    if (!open) return;
    const n = this.size;
    const lo = (v: number) => Math.max(0, Math.floor((v - r - this.origin) / CELL));
    const hi = (v: number) => Math.min(n - 1, Math.floor((v + r - this.origin) / CELL));
    for (let j = lo(p.z); j <= hi(p.z); j++) for (let i = lo(p.x); i <= hi(p.x); i++) open[j * n + i] = this.sample(i, j);
  }

  private sample(i: number, j: number): number {
    const x = this.origin + (i + 0.5) * CELL;
    const z = this.origin + (j + 0.5) * CELL;
    const r = this.terrain.resolve(x, z, CLEARANCE, this.terrain.groundAt(x, z));
    return hypot(r.x - x, r.z - z) < 0.05 ? 1 : 0;
  }

  private cellOf(p: Point): number {
    const i = Math.floor((p.x - this.origin) / CELL);
    const j = Math.floor((p.z - this.origin) / CELL);
    if (i < 0 || j < 0 || i >= this.size || j >= this.size) return -1;
    return j * this.size + i;
  }

  private center(c: number): Point {
    const i = c % this.size;
    const j = (c - i) / this.size;
    return { x: this.origin + (i + 0.5) * CELL, z: this.origin + (j + 0.5) * CELL };
  }

  /** The closest open cell to `c` (itself if open), searching a few rings out. */
  private nearestOpen(c: number): number {
    const grid = this.grid();
    if (c < 0) return -1;
    if (grid[c]) return c;
    const n = this.size;
    const ci = c % n;
    const cj = (c - ci) / n;
    for (let r = 1; r <= 4; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          if (grid[j * n + i]) return j * n + i;
        }
      }
    }
    return -1;
  }

  private astar(grid: Uint8Array, start: number, goal: number): number[] | null {
    const n = this.size;
    const gi = goal % n;
    const gj = (goal - gi) / n;
    const h = (c: number) => {
      const i = c % n;
      const j = (c - i) / n;
      const dx = Math.abs(i - gi);
      const dz = Math.abs(j - gj);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    const cost = new Map<number, number>([[start, 0]]);
    const from = new Map<number, number>();
    const heap = new MinHeap();
    heap.push(start, h(start));
    const closed = new Set<number>();
    while (heap.size) {
      const c = heap.pop();
      if (c === goal) {
        const out = [c];
        let k = c;
        while (from.has(k)) out.push((k = from.get(k)!));
        return out.reverse();
      }
      if (closed.has(c)) continue;
      closed.add(c);
      const ci = c % n;
      const cj = (c - ci) / n;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const k = j * n + i;
          if (!grid[k] || closed.has(k)) continue;
          // no cutting corners past walls
          if (di && dj && (!grid[cj * n + i] || !grid[j * n + ci])) continue;
          const g = cost.get(c)! + (di && dj ? Math.SQRT2 : 1);
          if (g >= (cost.get(k) ?? Infinity)) continue;
          cost.set(k, g);
          from.set(k, c);
          heap.push(k, g + h(k));
        }
      }
    }
    return null;
  }
}

/** A binary min-heap of cell indices by priority. */
class MinHeap {
  private readonly items: number[] = [];
  private readonly prio: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, p: number): void {
    const { items, prio } = this;
    let i = items.length;
    items.push(item);
    prio.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent]! <= p) break;
      items[i] = items[parent]!;
      prio[i] = prio[parent]!;
      i = parent;
    }
    items[i] = item;
    prio[i] = p;
  }

  pop(): number {
    const { items, prio } = this;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastPrio = prio.pop()!;
    if (items.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        let mp = lastPrio;
        if (l < items.length && prio[l]! < mp) {
          m = l;
          mp = prio[l]!;
        }
        if (r < items.length && prio[r]! < mp) m = r;
        if (m === i) break;
        items[i] = items[m]!;
        prio[i] = prio[m]!;
        i = m;
      }
      items[i] = lastItem;
      prio[i] = lastPrio;
    }
    return top;
  }
}
