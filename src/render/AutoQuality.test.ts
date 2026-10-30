import { describe, expect, it } from 'vitest';
import { AutoQuality } from './AutoQuality';
import type { QualityName } from './Quality';

function run(auto: AutoQuality, fps: number, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / fps) auto.frame(1 / fps);
}

describe('AutoQuality', () => {
  it('steps down one preset at a time while the frame rate stays low', () => {
    let q: QualityName = 'high';
    const auto = new AutoQuality(() => q, (to) => (q = to));
    run(auto, 30, 5);
    expect(q).toBe('high'); // still settling after the start
    run(auto, 30, 6);
    expect(q).toBe('medium');
    run(auto, 30, 11);
    expect(q).toBe('low');
    run(auto, 30, 30);
    expect(q).toBe('low');
  });

  it('leaves a smooth game and a player choice alone', () => {
    let q: QualityName = 'ultra';
    const auto = new AutoQuality(() => q, (to) => (q = to));
    run(auto, 60, 30);
    expect(q).toBe('ultra');
    auto.stop();
    run(auto, 20, 30);
    expect(q).toBe('ultra');
  });

  it('ignores stalls such as a hidden tab', () => {
    let q: QualityName = 'high';
    const auto = new AutoQuality(() => q, (to) => (q = to));
    for (let i = 0; i < 100; i++) auto.frame(1);
    expect(q).toBe('high');
  });
});
