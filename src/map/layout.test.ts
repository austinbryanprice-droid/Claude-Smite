import { describe, expect, it } from 'vitest';
import { baseOf, ConquestLayout as L, laneFrom, nearestOnPolyline, polylineLength } from './ConquestLayout';

const dist = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('Conquest layout', () => {
  it('keeps everything inside the map', () => {
    const all = [...L.lanes.flatMap((l) => l.points), ...L.paths.flatMap((p) => p.points), ...L.camps.map((c) => c.at)];
    for (const [x, z] of all) {
      expect(Math.abs(x)).toBeLessThan(L.halfExtent);
      expect(Math.abs(z)).toBeLessThan(L.halfExtent);
    }
  });

  it('is mirror-symmetric between the teams', () => {
    for (const t of L.towers.filter((t) => t.team === 'order')) {
      const twin = L.towers.find((c) => c.id === t.id.replace('order', 'chaos'))!;
      expect(twin.at[0]).toBeCloseTo(t.at[0]);
      expect(twin.at[1]).toBeCloseTo(-t.at[1]);
    }
    expect(baseOf('chaos').titan[1]).toBe(-baseOf('order').titan[1]);
  });

  it('puts towers and phoenixes on their lanes, outer tower nearer the enemy', () => {
    for (const t of L.towers) {
      const lane = laneFrom(t.team, t.lane);
      expect(nearestOnPolyline(lane, t.at[0], t.at[1]).distance).toBeLessThan(0.01);
    }
    for (const team of ['order', 'chaos'] as const) {
      for (const lane of ['solo', 'mid', 'duo'] as const) {
        const pts = laneFrom(team, lane);
        const inner = L.towers.find((t) => t.id === `${team}-${lane}-inner`)!;
        const outer = L.towers.find((t) => t.id === `${team}-${lane}-outer`)!;
        const phoenix = L.phoenixes.find((p) => p.id === `${team}-${lane}-phoenix`)!;
        const along = (p: readonly [number, number]) => nearestOnPolyline(pts, p[0], p[1]).along;
        expect(along(phoenix.at)).toBeLessThan(along(inner.at));
        expect(along(inner.at)).toBeLessThan(along(outer.at));
        expect(along(outer.at)).toBeLessThan(polylineLength(pts) / 2);
      }
    }
  });

  it('keeps structures apart and the titan inside its plaza', () => {
    const structures = [...L.towers.map((t) => t.at), ...L.phoenixes.map((p) => p.at)];
    for (let i = 0; i < structures.length; i++) {
      for (let j = i + 1; j < structures.length; j++) expect(dist(structures[i]!, structures[j]!)).toBeGreaterThan(12);
    }
    for (const b of L.bases) expect(dist(b.titan, b.plaza.at)).toBeLessThan(b.plaza.radius);
  });

  it('has a mid lane walk of about 30 seconds at god speed', () => {
    const mid = L.lanes.find((l) => l.id === 'mid')!;
    const seconds = polylineLength(mid.points) / 6.6;
    expect(seconds).toBeGreaterThan(25);
    expect(seconds).toBeLessThan(45);
  });
});
