import { describe, expect, test } from 'vitest';
import { GODS } from '../game/gods';
import { hashSeed, RATE } from './dsp';
import { INSTRUMENTS } from './music';
import { SKILL_SOUNDS } from './skillSounds';
import { renderRecipe, SOUNDS, type Recipe } from './sounds';

function check(name: string, recipe: Recipe): number {
  const variants = renderRecipe(recipe, hashSeed(name));
  let samples = 0;
  for (const b of variants) {
    let peak = 0;
    let sum = 0;
    let energy = 0;
    for (let i = 0; i < b.length; i++) {
      const x = b[i]!;
      if (!Number.isFinite(x)) throw new Error(`${name}: non-finite sample at ${i}`);
      peak = Math.max(peak, Math.abs(x));
      sum += x;
      energy += x * x;
    }
    expect(peak, `${name} peak`).toBeLessThanOrEqual(1.0001);
    expect(peak, `${name} is silent`).toBeGreaterThan(0.05);
    // no large DC offset (it would thump when the sound starts and stops)
    expect(Math.abs(sum / b.length), `${name} DC`).toBeLessThan(0.05);
    expect(Math.sqrt(energy / b.length), `${name} rms`).toBeGreaterThan(0.002);
    expect(b.length / RATE, `${name} length`).toBeLessThan(15);
    samples += b.length;
  }
  return samples;
}

describe('sound bank', () => {
  test('every sound renders clean audio', { timeout: 60000 }, () => {
    let total = 0;
    for (const [name, r] of Object.entries(SOUNDS)) total += check(name, r);
    for (const [name, r] of Object.entries(INSTRUMENTS)) total += check(name, r);
    // keep the whole bank light enough to render while the game loads
    expect(total / RATE).toBeLessThan(900);
  });

  test('every skill of every god has its own cast sound, and its parts render', { timeout: 60000 }, () => {
    for (const g of GODS) {
      for (const s of g.skills) {
        const ss = SKILL_SOUNDS[s.id];
        expect(ss, `${s.id} has sounds`).toBeTruthy();
        if (s.targeting.type === 'projectile') expect(ss!.travel, `${s.id} travel`).toBeTruthy();
        for (const part of ['cast', 'travel', 'impact', 'zone', 'tick'] as const) {
          const make = ss![part];
          if (make) check(`skill:${s.id}:${part}`, { make, loop: part === 'travel' || part === 'zone' });
        }
      }
    }
  });

  test('sounds are deterministic', () => {
    const a = renderRecipe(SOUNDS['hit.blade']!, 42)[0]!;
    const b = renderRecipe(SOUNDS['hit.blade']!, 42)[0]!;
    expect(a).toEqual(b);
  });
});
