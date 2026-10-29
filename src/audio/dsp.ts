/**
 * A small sample-level synthesis kit. Every sound in the game is built from
 * these pieces into plain Float32Arrays once at load time, then played back
 * through Web Audio. Nothing here touches the browser, so recipes can be
 * unit tested and render the same on every machine (all noise is seeded).
 */

import { rng } from '../core/random';

export const RATE = 44100;
const TAU = Math.PI * 2;

export type Rand = () => number;

/** A mono buffer of `seconds` length. */
export function buf(seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.round(seconds * RATE)));
}

export function seeded(seed: number): Rand {
  return rng(seed);
}

/** A seed from a string, so every skill id gets its own stable randomness. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Envelopes, as functions of time in seconds

/** Linear attack then exponential decay to silence; `decay` is the time to fall 60 dB. */
export function perc(t: number, attack: number, decay: number): number {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(((t - attack) / decay) * -6.9);
}

/** Attack, hold at 1, then release, all linear-in-dB ramps shaped for natural fades. */
export function ahr(t: number, attack: number, hold: number, release: number): number {
  if (t < 0) return 0;
  if (t < attack) return Math.sin((t / attack) * Math.PI * 0.5);
  t -= attack;
  if (t < hold) return 1;
  t -= hold;
  if (t < release) return Math.pow(1 - t / release, 2);
  return 0;
}

/** A smooth bump peaking at `peak` (0..1 of `len`). */
export function bell(t: number, len: number, peak = 0.5): number {
  const x = t / len;
  if (x <= 0 || x >= 1) return 0;
  return x < peak ? Math.sin((x / peak) * Math.PI * 0.5) ** 2 : Math.cos(((x - peak) / (1 - peak)) * Math.PI * 0.5) ** 2;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Exponential glide from a to b over `len` seconds. */
export function glide(a: number, b: number, t: number, len: number): number {
  const x = Math.min(1, Math.max(0, t / len));
  return a * Math.pow(b / a, x);
}

// ---------------------------------------------------------------------------
// Sources

/** White noise in -1..1. */
export function white(r: Rand): () => number {
  return () => r() * 2 - 1;
}

/** Pink-ish noise (Paul Kellet's economy filter). */
export function pink(r: Rand): () => number {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return (b0 + b1 + b2 + w * 0.1848) * 0.2;
  };
}

/** Brown noise: a leaky random walk, deep rumble. */
export function brown(r: Rand): () => number {
  let v = 0;
  return () => {
    v = (v + (r() * 2 - 1) * 0.04) * 0.996;
    return v * 3.2;
  };
}

/** An oscillator with a running phase so frequency can change every sample. */
export class Osc {
  phase: number;
  constructor(phase = 0) {
    this.phase = phase;
  }
  /** Advance by `freq` Hz and return the phase (0..1). */
  step(freq: number): number {
    this.phase += freq / RATE;
    this.phase -= Math.floor(this.phase);
    return this.phase;
  }
  sine(freq: number): number {
    return Math.sin(this.step(freq) * TAU);
  }
  /** Band-limited-ish saw (polyBLEP). */
  saw(freq: number): number {
    const dt = freq / RATE;
    const p = this.step(freq);
    return 2 * p - 1 - blep(p, dt);
  }
  square(freq: number, width = 0.5): number {
    const dt = freq / RATE;
    const p = this.step(freq);
    let v = p < width ? 1 : -1;
    v += blep(p, dt);
    let q = p - width;
    if (q < 0) q += 1;
    v -= blep(q, dt);
    return v;
  }
  tri(freq: number): number {
    const p = this.step(freq);
    return 1 - 4 * Math.abs(p - 0.5);
  }
}

function blep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Filters

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peak' | 'notch';

/** RBJ biquad; call `set` as often as every sample for sweeps. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private type: BiquadType,
    freq: number,
    q = 0.707,
    gainDb = 0,
  ) {
    this.set(freq, q, gainDb);
  }

  set(freq: number, q = 0.707, gainDb = 0): this {
    const f = Math.min(Math.max(freq, 10), RATE * 0.49);
    const w = (TAU * f) / RATE;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    let b0: number;
    let b1: number;
    let b2: number;
    let a0: number;
    let a1: number;
    let a2: number;
    switch (this.type) {
      case 'lowpass':
        b0 = (1 - cw) / 2;
        b1 = 1 - cw;
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cw) / 2;
        b1 = -(1 + cw);
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
        // constant 0 dB peak gain
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1;
        b1 = -2 * cw;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cw;
        a2 = 1 - alpha;
        break;
      case 'peak': {
        const A = Math.pow(10, gainDb / 40);
        b0 = 1 + alpha * A;
        b1 = -2 * cw;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cw;
        a2 = 1 - alpha / A;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** One-pole lowpass, cheap smoothing. */
export class OnePole {
  private y = 0;
  private a: number;
  constructor(freq: number) {
    this.a = 1 - Math.exp((-TAU * freq) / RATE);
  }
  set(freq: number): void {
    this.a = 1 - Math.exp((-TAU * freq) / RATE);
  }
  run(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** Soft clip for warmth and loudness. */
export function drive(x: number, amount: number): number {
  return Math.tanh(x * amount) / Math.tanh(amount);
}

// ---------------------------------------------------------------------------
// Building blocks

/** Smoothly varying random value in -1..1, for wobble and grit. */
export function wander(r: Rand, rate: number): () => number {
  let a = r() * 2 - 1;
  let b = r() * 2 - 1;
  let t = 0;
  const step = rate / RATE;
  return () => {
    t += step;
    if (t >= 1) {
      t -= 1;
      a = b;
      b = r() * 2 - 1;
    }
    const s = t * t * (3 - 2 * t);
    return a + (b - a) * s;
  };
}

/** Karplus-Strong plucked string. */
export function pluck(out: Float32Array, freq: number, r: Rand, opts: { gain?: number; damp?: number; bright?: number; start?: number } = {}): void {
  const n = Math.max(2, Math.round(RATE / freq));
  const line = new Float32Array(n);
  const bright = opts.bright ?? 0.6;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += (r() * 2 - 1 - lp) * bright;
    line[i] = lp;
  }
  const damp = opts.damp ?? 0.996;
  const g = opts.gain ?? 1;
  const start = Math.round((opts.start ?? 0) * RATE);
  let idx = 0;
  let prev = 0;
  for (let i = start; i < out.length; i++) {
    const cur = line[idx]!;
    const next = (cur + prev) * 0.5 * damp;
    prev = cur;
    line[idx] = next;
    out[i]! += cur * g;
    idx = (idx + 1) % n;
  }
}

/** Inharmonic partials with independent decays: bells, metal, chimes. */
export function modal(out: Float32Array, base: number, partials: readonly [ratio: number, gain: number, decay: number][], opts: { start?: number; gain?: number; attack?: number } = {}): void {
  const start = Math.round((opts.start ?? 0) * RATE);
  const g = opts.gain ?? 1;
  const atk = opts.attack ?? 0.001;
  for (const [ratio, pg, decay] of partials) {
    const w = (TAU * base * ratio) / RATE;
    if (base * ratio > RATE * 0.45) continue;
    const k = Math.exp(-6.9 / (decay * RATE));
    let env = 1;
    for (let i = start; i < out.length; i++) {
      const t = (i - start) / RATE;
      const a = t < atk ? t / atk : 1;
      out[i]! += Math.sin(w * (i - start)) * env * a * pg * g;
      env *= k;
      if (env < 1e-4) break;
    }
  }
}

/** Mix `src` into `out` at `at` seconds with gain. */
export function mixIn(out: Float32Array, src: Float32Array, at = 0, gain = 1): void {
  const o = Math.round(at * RATE);
  const n = Math.min(src.length, out.length - o);
  for (let i = 0; i < n; i++) out[o + i]! += src[i]! * gain;
}

/** Remove DC offset and sub-audible rumble (a gentle 18 Hz highpass). */
export function dcBlock(b: Float32Array): Float32Array {
  const R = 1 - (TAU * 18) / RATE;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    const y = x - x1 + R * y1;
    x1 = x;
    y1 = y;
    b[i] = y;
  }
  return b;
}

/** Scale so the peak sits at `peak`. */
export function normalize(b: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i]!));
  if (m > 1e-6) {
    const g = peak / m;
    for (let i = 0; i < b.length; i++) b[i]! *= g;
  }
  return b;
}

/** Short fades at both ends so nothing clicks. */
export function declick(b: Float32Array, inMs = 1.5, outMs = 8): Float32Array {
  const a = Math.min(b.length, Math.round((inMs / 1000) * RATE));
  const z = Math.min(b.length, Math.round((outMs / 1000) * RATE));
  for (let i = 0; i < a; i++) b[i]! *= i / a;
  for (let i = 0; i < z; i++) b[b.length - 1 - i]! *= i / z;
  return b;
}

/** Make a buffer loop seamlessly by crossfading its tail into its head. */
export function loopable(b: Float32Array, fade = 0.25): Float32Array {
  const n = Math.min(Math.round(fade * RATE), Math.floor(b.length / 3));
  const out = b.slice(0, b.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = b[i]! * Math.sqrt(t) + b[b.length - n + i]! * Math.sqrt(1 - t);
  }
  return out;
}

/** Fill `out` with fn(t, i), adding into what is there. */
export function fill(out: Float32Array, fn: (t: number, i: number) => number, from = 0, to = out.length / RATE): void {
  const a = Math.max(0, Math.round(from * RATE));
  const z = Math.min(out.length, Math.round(to * RATE));
  for (let i = a; i < z; i++) out[i]! += fn((i - a) / RATE, i);
}

/** Simple feedback comb/allpass reverb tail baked into a buffer (for dry recipes that want air). */
export function tail(b: Float32Array, size = 0.6, mix = 0.25, damp = 3500): Float32Array {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ line: new Float32Array(Math.round(d * size)), i: 0, lp: new OnePole(damp) }));
  const out = new Float32Array(b.length);
  for (let n = 0; n < b.length; n++) {
    const x = b[n]!;
    let wet = 0;
    for (const c of combs) {
      const y = c.line[c.i]!;
      c.line[c.i] = x + c.lp.run(y) * 0.8;
      c.i = (c.i + 1) % c.line.length;
      wet += y;
    }
    out[n] = x * (1 - mix) + wet * 0.25 * mix;
  }
  return out;
}

/** Granular crackle: sparse random clicks, for fire, sand, static and debris. */
export function crackle(out: Float32Array, r: Rand, density: number, env: (t: number) => number, opts: { tone?: number; gain?: number; len?: number } = {}): void {
  const tone = opts.tone ?? 4000;
  const g = opts.gain ?? 0.6;
  const len = Math.round((opts.len ?? 0.004) * RATE);
  const p = density / RATE;
  const f = new Biquad('bandpass', tone, 1.2);
  let left = 0;
  let amp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    if (left <= 0 && r() < p * env(t)) {
      left = len * (0.5 + r());
      amp = (0.3 + r() * 0.7) * (r() < 0.5 ? -1 : 1);
    }
    let x = 0;
    if (left > 0) {
      x = (r() * 2 - 1) * amp * (left / len);
      left--;
    }
    out[i]! += f.run(x) * g * 3;
  }
}

export { TAU };
