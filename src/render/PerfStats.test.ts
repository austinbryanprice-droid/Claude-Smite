import { describe, expect, it, vi } from 'vitest';
import { PerfStats, percentile } from './PerfStats';

vi.stubGlobal('document', { hidden: false, addEventListener: () => {} });
vi.stubGlobal('screen', { width: 2560, height: 1600 });
vi.stubGlobal('devicePixelRatio', 1.5);

const info = {
  gpu: 'NVIDIA GeForce RTX 4090 Laptop GPU',
  backend: 'WebGPU',
  quality: 'High',
  renderScale: 1,
  autoDrops: 0,
  canvas: { width: 2560, height: 1600 },
  mode: 'conquest',
  shaders: 2,
};

describe('PerfStats', () => {
  it('reads percentiles from sorted values', () => {
    const v = Float32Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(51);
    expect(percentile(v, 0.99)).toBe(100);
    expect(percentile(new Float32Array(0), 0.5)).toBe(0);
  });

  it('reports frame intervals and names the stalls', () => {
    const perf = new PerfStats();
    let now = 0;
    for (let i = 0; i < 300; i++) {
      // a 16.7 ms frame, with one 180 ms stall after frame 100
      now += i === 101 ? 180 : 1000 / 60;
      perf.begin(now);
      for (let k = 0; k < 4; k++) perf.mark(k);
      perf.end(i < 100 ? 10 : 13);
    }
    const text = perf.report(info);
    expect(text).toContain('GPU: NVIDIA GeForce RTX 4090 Laptop GPU · WebGPU · no GPU timing');
    expect(text).toContain('Frame interval ms: p50 16.7');
    expect(text).toContain('max 180');
    expect(text).toContain('Stalls since load: 1 over 50 ms · 1 over 100 ms · 0 over 250 ms');
    // the stall follows the frame that started 3 new shaders
    expect(text).toMatch(/180 ms at [\d.]+ s: the frame before ran [\d.]+ ms of game code and started 3 shaders/);
    expect(text).toContain('Display: 2560×1600 at 1.5x');
  });
});
