/**
 * God voices: wordless efforts, pain, battle cries and death cries, sung by
 * the formant voice in gestures.ts. Each god has a voice of its own (pitch,
 * throat size, grit, breath), so a fight can be followed by ear.
 */

import { ahr, bell, Biquad, fill, glide, white, type Rand } from './dsp';
import { layer, vowel, VOWELS } from './gestures';
import type { Recipe } from './sounds';

interface Voice {
  /** Speaking pitch in Hz. */
  pitch: number;
  /** Formant scale: below 1 is a bigger throat. */
  throat: number;
  growl: number;
  breath: number;
  /** Extra voices for a fuller, stranger sound. */
  voices: number;
}

export const GOD_VOICES: Record<string, Voice> = {
  // a ringing, commanding baritone
  zeus: { pitch: 118, throat: 0.95, growl: 0.04, breath: 0.1, voices: 1 },
  // a big, gruff bellow
  thor: { pitch: 96, throat: 0.86, growl: 0.12, breath: 0.16, voices: 2 },
  // old and deep, with a weathered rasp
  odin: { pitch: 84, throat: 0.88, growl: 0.08, breath: 0.24, voices: 1 },
  // light, quick and sly
  loki: { pitch: 152, throat: 1.04, growl: 0.02, breath: 0.14, voices: 1 },
  // a dry, hollow, doubled growl from the tomb
  anubis: { pitch: 72, throat: 0.82, growl: 0.16, breath: 0.4, voices: 3 },
};

type Vowel = keyof typeof VOWELS;

function sing(r: Rand, v: Voice, len: number, vow: Vowel, pitch: (t: number) => number, env: (t: number) => number, gain = 1): Float32Array {
  const formants = VOWELS[vow].map(([f, q, g]) => [f * v.throat, q, g] as [number, number, number]);
  const out = vowel(r, len, pitch, formants, { voices: v.voices, detune: 0.03, growl: v.growl, breath: v.breath, vibrato: 0.01, env, gain });
  // the push of air at the start of an effort
  const hp = new Biquad('bandpass', 1400 * v.throat, 0.8);
  const nz = white(r);
  fill(out, (t) => hp.run(nz()) * ahr(t, 0.008, 0.03, 0.08) * 0.25 * gain);
  return out;
}

function pick<T>(r: Rand, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

/** A short grunt of effort (attacks and skills). */
function effort(r: Rand, v: Voice): Float32Array {
  const len = 0.22 + r() * 0.12;
  const p = v.pitch * (0.95 + r() * 0.15);
  return sing(r, v, len, pick(r, ['ah', 'eh', 'oh'] as const), (t) => p * (1 + 0.18 * bell(t, len, 0.3)) * glide(1, 0.85, t, len), (t) => ahr(t, 0.015, len * 0.35, len * 0.6));
}

/** Being hurt: a sharp, pitched-up cry that falls away. */
function hurt(r: Rand, v: Voice): Float32Array {
  const len = 0.3 + r() * 0.12;
  const p = v.pitch * (1.35 + r() * 0.2);
  return sing(r, { ...v, growl: v.growl + 0.06 }, len, pick(r, ['eh', 'ah'] as const), (t) => p * glide(1, 0.72, t, len), (t) => ahr(t, 0.01, len * 0.2, len * 0.75));
}

/** An ultimate's battle cry: rising, held, doubled. */
function cry(r: Rand, v: Voice): Float32Array {
  const len = 0.75;
  const p = v.pitch * 1.15;
  const fuller = { ...v, voices: v.voices + 1, growl: v.growl + 0.04 };
  return sing(r, fuller, len, 'ah', (t) => p * glide(0.85, 1.25, t, len * 0.4), (t) => ahr(t, 0.04, len * 0.5, len * 0.45), 1.1);
}

/** Falling in battle: a long cry that sinks and breaks. */
function death(r: Rand, v: Voice): Float32Array {
  const len = 1.1;
  const p = v.pitch * 1.3;
  const a = sing(r, { ...v, growl: v.growl + 0.1 }, len, 'ah', (t) => p * glide(1, 0.55, t, len), (t) => ahr(t, 0.02, len * 0.25, len * 0.7));
  const b = sing(r, { ...v, breath: v.breath + 0.3 }, 0.5, 'oh', (t) => p * 0.5 * glide(1, 0.8, t, 0.5), (t) => ahr(t, 0.05, 0.1, 0.35), 0.5);
  return layer([a, 1], [b, 1, 0.75]);
}

export const VOICE_SOUNDS: Record<string, Recipe> = {};
for (const [god, v] of Object.entries(GOD_VOICES)) {
  VOICE_SOUNDS[`voice.${god}.effort`] = { variants: 4, peak: 0.6, make: (r) => effort(r, v) };
  VOICE_SOUNDS[`voice.${god}.hurt`] = { variants: 3, peak: 0.65, make: (r) => hurt(r, v) };
  VOICE_SOUNDS[`voice.${god}.cry`] = { variants: 2, peak: 0.75, make: (r) => cry(r, v) };
  VOICE_SOUNDS[`voice.${god}.death`] = { variants: 1, peak: 0.75, make: (r) => death(r, v) };
}
