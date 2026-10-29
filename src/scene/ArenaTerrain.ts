import { fbm2, simplex2, smoothstep as sstep } from '../core/random';
import { Arena, laneDistance, pathDistance } from './ArenaLayout';
import type { TerrainDef } from './Terrain';

/**
 * The temple arena's terrain: a grassy valley floor around the temple, rising
 * into layered cliffs with canyons where the lanes exit.
 */
export function arenaTerrain(): TerrainDef {
  const n = simplex2(91);
  return {
    size: Arena.terrainSize,
    segments: 400,
    maskSize: Arena.maskSize,
    maskRes: 512,
    height: arenaHeight(),
    mask(x, z) {
      const edgeNoise = fbm2(n, x * 0.25, z * 0.25, 3);
      const pd = pathDistance(x, z) + edgeNoise * 0.9;
      const ld = laneDistance(x, z) + edgeNoise * 0.5;
      const r = Math.hypot(x, z);
      const dirt = 1 - sstep(-0.6, 1.4, pd);
      // dirt apron around the temple base and lane borders
      const apron = (1 - sstep(Arena.plaza.baseRadius - 0.5, Arena.plaza.baseRadius + 3.5 + edgeNoise * 2, r));
      const laneDirt = 1 - sstep(0, 2.2, ld);
      const paved = 1 - sstep(-0.4, 0.3, ld);
      const damp = Math.max(0, fbm2(n, x * 0.05, z * 0.05, 3)) * 0.8;
      const macro = fbm2(n, x * 0.015 + 100, z * 0.015, 4) * 0.5 + 0.5;
      return [Math.min(1, Math.max(dirt, apron * 0.9, laneDirt * 0.85)), paved, damp, macro];
    },
  };
}

function arenaHeight(): (x: number, z: number) => number {
  const n1 = simplex2(11);
  const n2 = simplex2(23);
  const n3 = simplex2(37);
  const { valleyRadius, plaza } = Arena;
  return (x, z) => {
    const r = Math.hypot(x, z);
    // gentle undulation on the valley floor
    let h = fbm2(n1, x * 0.018, z * 0.018, 4) * 1.6 + fbm2(n2, x * 0.07, z * 0.07, 2) * 0.25;
    // cliffs: warped radius so the rim is irregular
    const warpR = r + fbm2(n2, x * 0.012, z * 0.012, 3) * 22;
    const rim = sstep(valleyRadius - 4, valleyRadius + 38, warpR);
    const ridge = 1 - Math.abs(fbm2(n3, x * 0.02, z * 0.02, 5));
    const strata = Math.round(rim * 7 + ridge * 0.6) / 7; // terraced ledges
    const cliffH = (38 + ridge * 40 + fbm2(n1, x * 0.008, z * 0.008, 3) * 25) * (rim * 0.55 + strata * 0.45);
    // canyons where lanes leave the valley
    const lane = laneDistance(x, z);
    const canyon = 1 - sstep(4, 26 + Math.max(0, r - valleyRadius) * 0.25, lane);
    h += cliffH * (1 - canyon * 0.92);
    // distant mountains
    h += sstep(170, 250, r) * (60 + fbm2(n3, x * 0.004, z * 0.004, 4) * 60);
    // flatten under the temple and lanes so architecture sits cleanly
    const plazaFlat = 1 - sstep(plaza.baseRadius + 1, plaza.baseRadius + 10, r);
    const laneFlat = 1 - sstep(1.5, 7, lane);
    const flat = Math.max(plazaFlat, laneFlat * (1 - rim));
    h = h * (1 - flat) + -0.05 * flat;
    // slight dip of the dirt paths
    const pd = pathDistance(x, z);
    h -= (1 - sstep(-1, 2.5, pd)) * 0.12;
    return h;
  };
}
