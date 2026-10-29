/**
 * Life around the jungle and the lanes: the breathing and grumbling of camps
 * waiting for a fight, the bosses' own idle beds (the Wyrm's hissing breath,
 * the Colossus's bubbling lava), and the tramp of a passing minion wave.
 * All loops, followed around by GameAudio.
 */

import { ahr, bell, Biquad, brown, buf, fill, glide, loopable, mixIn, Osc, perc, pink, wander, white, type Rand } from './dsp';
import { clang, knock, vowel } from './gestures';
import type { Recipe } from './sounds';

/** Slow breaths: filtered noise swelling in and out, `rate` breaths per second. */
function breaths(out: Float32Array, r: Rand, len: number, rate: number, tone: number, gain: number): void {
  const n = pink(r);
  const bp = new Biquad('bandpass', tone, 0.9);
  const count = Math.max(1, Math.round(len * rate));
  const period = len / count;
  fill(out, (t) => {
    const ph = (t % period) / period;
    // in-breath is quieter and higher than the out-breath
    const env = ph < 0.4 ? Math.sin((ph / 0.4) * Math.PI) * 0.45 : Math.sin(((ph - 0.4) / 0.6) * Math.PI);
    return bp.run(n()) * env * gain;
  }, 0, len);
}

/** A camp of beasts at rest: breathing, a grumble now and then, a paw on stone. */
function beasts(r: Rand, len: number): Float32Array {
  const out = buf(len + 0.6);
  breaths(out, r, len, 0.35, 420, 0.9);
  for (let k = 0; k < 2; k++) {
    const at = 0.4 + r() * (len - 1.6);
    const d = 0.6 + r() * 0.5;
    const p = 95 + r() * 40;
    mixIn(out, vowel(r, d, (t) => p * glide(1, 0.8, t, d) * (1 + 0.08 * bell(t, d, 0.4)), [[420, 4, 1], [900, 5, 0.5], [2000, 6, 0.15]], { breath: 0.5, growl: 0.25, voices: 2, detune: 0.04, env: (t) => ahr(t, 0.12, d * 0.4, d * 0.45), gain: 0.35 }), at);
  }
  mixIn(out, knock(r, 0.08, 300), r() * (len - 0.2), 0.3);
  return loopable(out, 0.6);
}

/** The Treasure Wyrm asleep on its hoard: huge slow breaths with a serpent's hiss, coins shifting. */
function wyrmRest(r: Rand, len: number): Float32Array {
  const out = buf(len + 0.8);
  breaths(out, r, len, 0.22, 240, 1.2);
  const hiss = new Biquad('highpass', 3500);
  const n = white(r);
  const count = Math.max(1, Math.round(len * 0.22));
  const period = len / count;
  fill(out, (t) => {
    const ph = (t % period) / period;
    const h = hiss.run(n());
    return ph > 0.45 ? h * Math.sin(((ph - 0.45) / 0.55) * Math.PI) * 0.25 : 0;
  }, 0, len);
  // a low rumble in its chest
  const lp = new Biquad('lowpass', 90);
  const br = brown(r);
  fill(out, () => lp.run(br()) * 1.2, 0, len);
  // coins sliding off the hoard
  for (let k = 0; k < 5; k++) mixIn(out, clang(r, 0.3, 2400 + r() * 1800, { decay: 0.15, gain: 0.12 }), r() * (len - 0.4));
  return loopable(out, 0.8);
}

/** The Molten Colossus's lava: thick slow bubbles, hissing steam and a deep roiling bed. */
function lava(r: Rand, len: number): Float32Array {
  const out = buf(len + 0.6);
  const lp = new Biquad('lowpass', 160, 0.8);
  const br = brown(r);
  const wob = wander(r, 0.8);
  fill(out, () => lp.run(br()) * 1.6 * (0.7 + 0.3 * wob()), 0, len);
  const count = Math.round(len * 5);
  for (let k = 0; k < count; k++) {
    const at = r() * (len - 0.3);
    const f = 70 + r() * 110;
    const d = 0.08 + r() * 0.15;
    const o = new Osc();
    const g = 0.25 + r() * 0.35;
    // a blup: a low sine that bends up as the bubble bursts
    fill(out, (t) => o.sine(f * (1 + t * 6)) * perc(t, 0.004, d) * g, at, at + d * 1.4);
  }
  const hp = new Biquad('highpass', 2500);
  const n = white(r);
  for (let k = 0; k < 2; k++) {
    const at = r() * (len - 1);
    fill(out, (t) => hp.run(n()) * ahr(t, 0.1, 0.3, 0.5) * 0.12, at, at + 0.9);
  }
  return loopable(out, 0.6);
}

/** A minion wave on the march: many boots out of step, armor and buckles jingling. */
function march(r: Rand, len: number): Float32Array {
  const out = buf(len + 0.4);
  const soldiers = 7;
  for (let s = 0; s < soldiers; s++) {
    const pace = 0.5 + (r() - 0.5) * 0.06;
    let t = r() * pace;
    while (t < len) {
      mixIn(out, knock(r, 0.07, 220 + r() * 160), t, 0.4 + r() * 0.2);
      // a clink of mail on every other step
      if (r() < 0.5) mixIn(out, clang(r, 0.12, 3000 + r() * 2500, { decay: 0.06, gain: 0.08 }), t + 0.02);
      t += pace;
    }
  }
  // the low shuffle of the whole column
  const bp = new Biquad('bandpass', 500, 0.7);
  const n = pink(r);
  fill(out, (t) => bp.run(n()) * 0.12 * (0.8 + 0.2 * Math.sin(t * 2 * Math.PI * 2)), 0, len);
  return loopable(out, 0.4);
}

export const CREATURE_SOUNDS: Record<string, Recipe> = {
  'idle.beasts': { loop: true, variants: 2, peak: 0.45, make: (r) => beasts(r, 6) },
  'idle.wyrm': { loop: true, peak: 0.6, make: (r) => wyrmRest(r, 9) },
  'idle.lava': { loop: true, peak: 0.55, make: (r) => lava(r, 6) },
  'march': { loop: true, peak: 0.45, make: (r) => march(r, 4) },
};
