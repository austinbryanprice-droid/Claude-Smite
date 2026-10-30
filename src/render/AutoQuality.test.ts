import { describe, expect, it } from 'vitest';
import { AutoQuality } from './AutoQuality';

function run(auto: AutoQuality, fps: number, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / fps) auto.frame(1 / fps);
}

describe('AutoQuality', () => {
  it('steps the resolution down while the frame rate stays low', () => {
    let scale = 1;
    const auto = new AutoQuality((s) => (scale = s));
    run(auto, 30, 5);
    expect(scale).toBe(1); // still settling after the start
    run(auto, 30, 6);
    expect(scale).toBe(0.85);
    run(auto, 30, 10);
    expect(scale).toBe(0.7);
    run(auto, 30, 60);
    expect(scale).toBe(0.55);
  });

  it('leaves a smooth game and a player choice alone', () => {
    let scale = 1;
    const auto = new AutoQuality((s) => (scale = s));
    run(auto, 60, 30);
    expect(scale).toBe(1);
    auto.stop();
    run(auto, 20, 30);
    expect(scale).toBe(1);
  });

  it('ignores stalls such as a hidden tab', () => {
    let scale = 1;
    const auto = new AutoQuality((s) => (scale = s));
    for (let i = 0; i < 100; i++) auto.frame(1);
    expect(scale).toBe(1);
  });
});
