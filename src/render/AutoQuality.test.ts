import { describe, expect, it } from 'vitest';
import { AutoQuality } from './AutoQuality';

function run(auto: AutoQuality, fps: number, seconds: number, cpuMs = 0): void {
  for (let t = 0; t < seconds; t += 1 / fps) auto.frame(1 / fps, cpuMs);
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

  it('keeps the resolution when the CPU is what holds the frame rate back', () => {
    let scale = 1;
    const auto = new AutoQuality((s) => (scale = s));
    // 30 fps with 30 ms of the 33 ms frame spent in game code
    run(auto, 30, 30, 30);
    expect(scale).toBe(1);
    // the same frame rate with the CPU mostly idle: the GPU is the limit
    run(auto, 30, 11, 5);
    expect(scale).toBe(0.85);
  });

  it('keeps the resolution when the GPU is idle for much of each frame', () => {
    let scale = 1;
    let gpu: number | null = 8;
    const auto = new AutoQuality((s) => (scale = s), () => gpu);
    // 30 fps, but the GPU works only 8 ms of each 33 ms frame
    run(auto, 30, 30);
    expect(scale).toBe(1);
    // the GPU busy for most of the frame: it is the limit
    gpu = 28;
    run(auto, 30, 5);
    expect(scale).toBe(0.85);
  });

  it('ignores stalls such as a hidden tab', () => {
    let scale = 1;
    const auto = new AutoQuality((s) => (scale = s));
    for (let i = 0; i < 100; i++) auto.frame(1);
    expect(scale).toBe(1);
  });
});
