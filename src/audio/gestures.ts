/**
 * Sound gestures: whooshes, thumps, zaps, thunder, metal, sand, smoke and
 * voices, each a small parametric generator. The SFX bank and the per-skill
 * sounds are layered from these.
 */

import {
  ahr, bell, Biquad, brown, buf, crackle, drive, fill, glide, lerp, modal, OnePole, Osc, perc, pink, pluck, RATE, wander, white, type Rand,
} from './dsp';

/** Air moving past: band-passed noise sweeping from f0 to f1 under a bump envelope. */
export function whoosh(r: Rand, len: number, f0: number, f1: number, opts: { q?: number; peak?: number; gain?: number; grit?: number } = {}): Float32Array {
  const out = buf(len);
  const n = pink(r);
  const bp = new Biquad('bandpass', f0, opts.q ?? 1.4);
  const bp2 = new Biquad('bandpass', f0 * 1.6, (opts.q ?? 1.4) * 1.3);
  const wob = wander(r, 18);
  const g = opts.gain ?? 1;
  const grit = opts.grit ?? 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const f = glide(f0, f1, t, len);
    if ((i & 15) === 0) {
      bp.set(f, opts.q ?? 1.4);
      bp2.set(f * 1.6, (opts.q ?? 1.4) * 1.3);
    }
    const x = n() * (1 + wob() * grit);
    out[i] = (bp.run(x) * 2.2 + bp2.run(x) * 1.1) * bell(t, len, opts.peak ?? 0.45) * g;
  }
  return out;
}

/** A body blow: a pitch-dropping sine, a click on top and a little noise. */
export function thump(r: Rand, len: number, f0: number, f1: number, opts: { click?: number; noise?: number; gain?: number; drive?: number } = {}): Float32Array {
  const out = buf(len);
  const o = new Osc();
  const nz = white(r);
  const lp = new Biquad('lowpass', 900, 0.8);
  const click = opts.click ?? 0.5;
  const noise = opts.noise ?? 0.3;
  const dr = opts.drive ?? 1.5;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const f = glide(f0, f1, t, len * 0.35);
    const body = o.sine(f) * perc(t, 0.002, len * 0.8);
    const c = nz() * perc(t, 0.0005, 0.012) * click;
    const ns = lp.run(nz()) * perc(t, 0.001, len * 0.3) * noise;
    out[i] = drive(body + c + ns, dr) * (opts.gain ?? 1);
  }
  return out;
}

/** Electric zap: a buzzing tone that jitters in pitch, with hissing static. */
export function zap(r: Rand, len: number, freq: number, opts: { chaos?: number; fall?: number; gain?: number; hiss?: number } = {}): Float32Array {
  const out = buf(len);
  const o = new Osc();
  const o2 = new Osc(0.3);
  const nz = white(r);
  const hp = new Biquad('highpass', 2500, 0.7);
  const bp = new Biquad('bandpass', freq * 3, 0.9);
  const chaos = opts.chaos ?? 0.5;
  let jump = 1;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    if (r() < 0.004) jump = 1 + (r() * 2 - 1) * chaos;
    const f = freq * jump * glide(1, opts.fall ?? 0.5, t, len);
    const tone = o.square(f, 0.3 + r() * 0.05) * 0.5 + o2.saw(f * 2.01) * 0.4;
    const env = perc(t, 0.002, len) * (0.6 + 0.4 * (r() < 0.5 ? 1 : 0.3));
    const s = hp.run(nz()) * (opts.hiss ?? 0.5) * perc(t, 0.001, len * 0.7);
    out[i] = drive(bp.run(tone) * 2 + tone * 0.25 + s, 2) * env * (opts.gain ?? 1);
  }
  return out;
}

/** Thunder: a sharp crack that rolls off into a long, grumbling rumble. */
export function thunder(r: Rand, len: number, opts: { crack?: number; rumble?: number; gain?: number; delay?: number } = {}): Float32Array {
  const out = buf(len);
  const nz = white(r);
  const br = brown(r);
  const hp = new Biquad('highpass', 1800, 0.6);
  const lp = new Biquad('lowpass', 260, 0.7);
  const lp2 = new Biquad('lowpass', 120, 0.9);
  const wob = wander(r, 9);
  const crack = opts.crack ?? 1;
  const rumble = opts.rumble ?? 1;
  const d = opts.delay ?? 0.02;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const c = hp.run(nz()) * perc(t, 0.0008, 0.09) * crack * 1.6 + nz() * perc(t, 0.0005, 0.018) * crack;
    const rr = (lp.run(br()) * 1.6 + lp2.run(nz()) * 1.4) * ahr(t - d, 0.05, len * 0.1, len * 0.8) * (0.6 + 0.5 * Math.abs(wob())) * rumble;
    out[i] = drive(c + rr, 1.6) * (opts.gain ?? 1);
  }
  return out;
}

/** Struck metal: inharmonic partials, ringing. */
export function clang(r: Rand, len: number, base: number, opts: { gain?: number; decay?: number; bright?: number } = {}): Float32Array {
  const out = buf(len);
  const d = opts.decay ?? 0.6;
  const b = opts.bright ?? 1;
  const ratios = [1, 2.32, 2.76, 4.07, 5.4, 6.9, 8.93];
  modal(
    out,
    base * (0.98 + r() * 0.04),
    ratios.map((x, k) => [x * (1 + (r() - 0.5) * 0.01), (1 / (1 + k * 0.6)) * (k > 2 ? b : 1), d * (1 - k * 0.1)] as [number, number, number]),
    { gain: (opts.gain ?? 1) * 0.5 },
  );
  // the strike itself
  const nz = white(r);
  const hp = new Biquad('highpass', 3000);
  fill(out, (t) => hp.run(nz()) * perc(t, 0.0003, 0.02) * 0.6 * (opts.gain ?? 1), 0, 0.05);
  return out;
}

/** A glassy, glittering rise: many detuned sine partials with tremolo. */
export function shimmer(r: Rand, len: number, base: number, opts: { rise?: number; gain?: number; peak?: number; voices?: number } = {}): Float32Array {
  const out = buf(len);
  const voices = opts.voices ?? 7;
  const rise = opts.rise ?? 1.5;
  for (let v = 0; v < voices; v++) {
    const o = new Osc(r());
    const ratio = [1, 1.5, 2, 3, 4, 5, 6, 8][v % 8]! * (1 + (r() - 0.5) * 0.012);
    const trem = 6 + r() * 9;
    const tp = r() * 6;
    const g = 1 / (1 + v * 0.5);
    for (let i = 0; i < out.length; i++) {
      const t = i / RATE;
      const f = base * ratio * glide(1, rise, t, len);
      out[i]! += o.sine(f) * g * (0.65 + 0.35 * Math.sin(t * trem * 6.283 + tp));
    }
  }
  const pk = opts.peak ?? 0.3;
  for (let i = 0; i < out.length; i++) out[i]! *= bell(i / RATE, len, pk) * (opts.gain ?? 1) * 0.35;
  return out;
}

/** Hissing, grainy sand: filtered noise plus dense grains. */
export function sand(r: Rand, len: number, opts: { tone?: number; gain?: number; peak?: number; grains?: number } = {}): Float32Array {
  const out = buf(len);
  const n = white(r);
  const tone = opts.tone ?? 3500;
  const bp = new Biquad('bandpass', tone, 0.8);
  const hp = new Biquad('highpass', 1200);
  const wob = wander(r, 12);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = (bp.run(n()) * 1.4 + hp.run(n()) * 0.3) * bell(t, len, opts.peak ?? 0.3) * (0.7 + 0.3 * wob());
  }
  crackle(out, r, opts.grains ?? 900, (t) => bell(t, len, opts.peak ?? 0.3), { tone: tone * 1.3, gain: 0.5, len: 0.002 });
  for (let i = 0; i < out.length; i++) out[i]! *= opts.gain ?? 1;
  return out;
}

/** A soft, dark puff of smoke. */
export function puff(r: Rand, len: number, opts: { tone?: number; gain?: number } = {}): Float32Array {
  const out = buf(len);
  const n = pink(r);
  const lp = new Biquad('lowpass', opts.tone ?? 900, 0.6);
  const lp2 = new OnePole(300);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const env = perc(t, 0.012, len);
    lp.set((opts.tone ?? 900) * (1 - (t / len) * 0.6), 0.6);
    out[i] = (lp.run(n()) * 2.4 + lp2.run(n()) * 3) * env * (opts.gain ?? 1);
  }
  return out;
}

/** A crowd of insects: many detuned buzzing saws through a nasal formant. */
export function buzz(r: Rand, len: number, freq: number, opts: { voices?: number; gain?: number; env?: (t: number) => number } = {}): Float32Array {
  const out = buf(len);
  const voices = opts.voices ?? 10;
  const bp = new Biquad('bandpass', 1300, 1.5);
  const bp2 = new Biquad('bandpass', 2900, 2.5);
  const oscs = Array.from({ length: voices }, () => ({ o: new Osc(r()), f: freq * (0.75 + r() * 0.6), w: wander(r, 3 + r() * 6), a: wander(r, 9) }));
  const env = opts.env ?? ((t: number) => bell(t, len, 0.3));
  for (let i = 0; i < out.length; i++) {
    let x = 0;
    for (const v of oscs) x += v.o.saw(v.f * (1 + v.w() * 0.06)) * (0.5 + 0.5 * v.a());
    x /= voices;
    out[i] = (bp.run(x) * 2.5 + bp2.run(x) * 1.5 + x * 0.2) * env(i / RATE) * (opts.gain ?? 1);
  }
  return out;
}

/** A vowel through formant filters: shouts, howls, roars and choirs. */
export function vowel(
  r: Rand,
  len: number,
  pitch: (t: number) => number,
  formants: readonly [f: number, q: number, g: number][],
  opts: { gain?: number; env?: (t: number) => number; breath?: number; voices?: number; detune?: number; vibrato?: number; growl?: number } = {},
): Float32Array {
  const out = buf(len);
  const voices = opts.voices ?? 1;
  const fs = formants.map(([f, q, g]) => ({ b: new Biquad('bandpass', f, q), g }));
  const nz = white(r);
  const oscs = Array.from({ length: voices }, (_, k) => ({ o: new Osc(r()), d: 1 + (k === 0 ? 0 : (r() - 0.5) * (opts.detune ?? 0.02)), vp: r() * 6 }));
  const env = opts.env ?? ((t: number) => ahr(t, 0.05, len * 0.6, len * 0.35));
  const vib = opts.vibrato ?? 0.012;
  const growl = opts.growl ?? 0;
  const gw = wander(r, 40);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const p = pitch(t);
    let src = 0;
    for (const v of oscs) src += v.o.saw(p * v.d * (1 + Math.sin(t * 34 + v.vp) * vib) * (1 + gw() * growl));
    src = src / voices + nz() * (opts.breath ?? 0.08);
    let y = 0;
    for (const f of fs) y += f.b.run(src) * f.g;
    out[i] = drive(y * 2.5, 1.4) * env(t) * (opts.gain ?? 1);
  }
  return out;
}

export const VOWELS = {
  ah: [[750, 6, 1], [1150, 7, 0.6], [2600, 9, 0.25]] as [number, number, number][],
  oh: [[450, 6, 1], [800, 7, 0.5], [2830, 10, 0.15]] as [number, number, number][],
  oo: [[330, 6, 1], [700, 8, 0.35], [2500, 10, 0.1]] as [number, number, number][],
  eh: [[550, 6, 1], [1770, 8, 0.5], [2500, 10, 0.3]] as [number, number, number][],
};

/** Deep beast roar: a growling low vowel with grit and a noisy breath. */
export function roar(r: Rand, len: number, pitch: number, opts: { gain?: number; open?: number } = {}): Float32Array {
  const open = opts.open ?? 1;
  const v = vowel(
    r,
    len,
    (t) => pitch * (1 + 0.25 * bell(t, len, 0.25)) * glide(1, 0.7, t, len),
    [[380 * open, 4, 1], [820 * open, 5, 0.6], [1900, 6, 0.25]],
    { voices: 4, detune: 0.05, growl: 0.12, breath: 0.35, vibrato: 0.03, env: (t) => ahr(t, 0.12, len * 0.35, len * 0.55), gain: opts.gain },
  );
  const lp = new Biquad('lowpass', 220);
  const br = brown(r);
  fill(v, (t) => lp.run(br()) * ahr(t, 0.1, len * 0.3, len * 0.6) * 0.9 * (opts.gain ?? 1));
  return v;
}

/** Long low rumble with a sense of weight. */
export function rumble(r: Rand, len: number, opts: { tone?: number; gain?: number; attack?: number } = {}): Float32Array {
  const out = buf(len);
  const br = brown(r);
  const lp = new Biquad('lowpass', opts.tone ?? 160, 0.9);
  const wob = wander(r, 6);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = lp.run(br()) * 2.2 * ahr(t, opts.attack ?? 0.05, len * 0.15, len * 0.8) * (0.7 + 0.3 * wob()) * (opts.gain ?? 1);
  }
  return out;
}

/** Falling rubble: many small stone knocks scattered over time. */
export function debris(r: Rand, len: number, opts: { density?: number; gain?: number; tone?: number } = {}): Float32Array {
  const out = buf(len);
  const count = Math.round((opts.density ?? 25) * len);
  for (let k = 0; k < count; k++) {
    const at = Math.pow(r(), 1.6) * len * 0.85;
    const s = knock(r, 0.08 + r() * 0.1, (opts.tone ?? 900) * (0.5 + r()));
    const g = (0.2 + r() * 0.8) * (1 - at / len) * (opts.gain ?? 1);
    const o = Math.round(at * RATE);
    for (let i = 0; i < s.length && o + i < out.length; i++) out[o + i]! += s[i]! * g;
  }
  return out;
}

/** A stone knock: short resonant tap. */
export function knock(r: Rand, len: number, tone: number): Float32Array {
  const out = buf(len);
  const n = white(r);
  const bp = new Biquad('bandpass', tone, 3);
  const bp2 = new Biquad('bandpass', tone * 2.3, 4);
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const x = n() * perc(t, 0.0004, len * 0.5);
    out[i] = bp.run(x) * 3 + bp2.run(x) * 1.5;
  }
  return out;
}

/** A bright bell note. */
export function chime(_r: Rand, len: number, freq: number, opts: { gain?: number; at?: number; out?: Float32Array } = {}): Float32Array {
  const out = opts.out ?? buf(len);
  modal(out, freq, [[1, 1, len], [2.01, 0.5, len * 0.6], [3.0, 0.3, len * 0.4], [4.2, 0.2, len * 0.25], [5.43, 0.1, len * 0.15]], { start: opts.at, gain: (opts.gain ?? 1) * 0.4, attack: 0.002 });
  return out;
}

/** Crackling fire. */
export function fire(r: Rand, len: number, opts: { gain?: number; roar?: number } = {}): Float32Array {
  const out = buf(len);
  const n = pink(r);
  const lp = new Biquad('lowpass', 500, 0.7);
  const wob = wander(r, 4);
  for (let i = 0; i < out.length; i++) out[i] = lp.run(n()) * (opts.roar ?? 1.2) * (0.6 + 0.4 * wob());
  crackle(out, r, 60, () => 1, { tone: 2500, gain: 0.7, len: 0.003 });
  crackle(out, r, 12, () => 1, { tone: 900, gain: 0.8, len: 0.01 });
  for (let i = 0; i < out.length; i++) out[i]! *= opts.gain ?? 1;
  return out;
}

/** A bird call: quick sine chirps with frequency sweeps. */
export function chirp(r: Rand, kind: number): Float32Array {
  const notes = 2 + Math.floor(r() * 4);
  const len = notes * 0.13 + 0.2;
  const out = buf(len);
  const base = 2600 + r() * 2200;
  for (let k = 0; k < notes; k++) {
    const o = new Osc();
    const at = k * (0.09 + r() * 0.06);
    const dur = 0.05 + r() * 0.07;
    const f0 = base * (0.8 + r() * 0.5);
    const f1 = kind % 2 ? f0 * (1.3 + r() * 0.4) : f0 * (0.6 + r() * 0.2);
    fill(out, (t) => o.sine(lerp(f0, f1, t / dur) + Math.sin(t * 380) * 120) * Math.sin(Math.PI * Math.min(1, t / dur)) ** 2 * 0.5, at, at + dur);
  }
  return out;
}

/** A sung "ah" chord pad (used for holy and rune magic). */
export function choir(r: Rand, len: number, freq: number, opts: { gain?: number; env?: (t: number) => number; vowelName?: keyof typeof VOWELS } = {}): Float32Array {
  return vowel(r, len, () => freq, VOWELS[opts.vowelName ?? 'ah'], { voices: 5, detune: 0.018, breath: 0.05, vibrato: 0.008, gain: (opts.gain ?? 1) * 0.8, env: opts.env });
}

/** A short plucked twang (bowstrings, tension). */
export function twang(r: Rand, len: number, freq: number, gain = 1): Float32Array {
  const out = buf(len);
  pluck(out, freq, r, { damp: 0.992, bright: 0.8, gain });
  return out;
}

/** Shorthand: sum several layers into a new buffer as long as the longest. */
export function layer(...parts: (Float32Array | [Float32Array, number] | [Float32Array, number, number])[]): Float32Array {
  let len = 0;
  for (const p of parts) {
    const [b, , at] = Array.isArray(p) ? p : [p, 1, 0];
    len = Math.max(len, b.length + Math.round((at ?? 0) * RATE));
  }
  const out = new Float32Array(len);
  for (const p of parts) {
    const [b, g, at] = Array.isArray(p) ? p : [p, 1, 0];
    const o = Math.round((at ?? 0) * RATE);
    for (let i = 0; i < b.length; i++) out[o + i]! += b[i]! * (g ?? 1);
  }
  return out;
}

/** Apply a gain envelope in place. */
export function shape(b: Float32Array, env: (t: number) => number): Float32Array {
  for (let i = 0; i < b.length; i++) b[i]! *= env(i / RATE);
  return b;
}

/** Filter a buffer in place. */
export function filter(b: Float32Array, type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q = 0.707): Float32Array {
  const f = new Biquad(type, freq, q);
  for (let i = 0; i < b.length; i++) b[i] = f.run(b[i]!);
  return b;
}
