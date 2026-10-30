/**
 * Sound gestures: whooshes, thumps, impacts, zaps, thunder, metal, sand, smoke and
 * voices, each a small parametric generator. The SFX bank and the per-skill
 * sounds are layered from these.
 */

import {
  ahr, bell, Biquad, brown, buf, crackle, drive, fill, glide, lerp, modal, OnePole, Osc, perc, pink, pluck, RATE, tail, wander, white, type Rand,
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

/**
 * Electric arc: a ragged train of sparks at roughly `freq` a second (never
 * quite regular, so it crackles instead of buzzing like a synth), each a sharp
 * click ringing through the air, over the hiss of ionised air.
 */
export function zap(r: Rand, len: number, freq: number, opts: { chaos?: number; fall?: number; gain?: number; hiss?: number } = {}): Float32Array {
  const out = buf(len);
  const nz = white(r);
  const hp = new Biquad('highpass', 2500, 0.7);
  const snap = new Biquad('bandpass', 3200, 0.8);
  const body = new Biquad('bandpass', Math.min(1400, freq * 3), 1.1);
  const chaos = opts.chaos ?? 0.5;
  let phase = 0;
  let jitter = 1;
  let burst = 0;
  let amp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const f = freq * glide(1, opts.fall ?? 0.5, t, len) * jitter;
    phase += f / RATE;
    if (phase >= 1) {
      phase -= 1;
      jitter = Math.max(0.25, 1 + (r() * 2 - 1) * chaos);
      // now and then a fat spark pops louder than the rest
      amp = (0.35 + r() * 0.65) * (r() < 0.08 ? 2.2 : 1) * (r() < 0.5 ? -1 : 1);
      burst = 18 + Math.floor(r() * 30);
    }
    let x = 0;
    if (burst > 0) {
      x = (amp + nz() * 0.6) * (burst / 48);
      burst--;
    }
    const s = hp.run(nz()) * (opts.hiss ?? 0.5) * perc(t, 0.001, len * 0.7) * 0.6;
    const env = perc(t, 0.001, len);
    out[i] = drive(snap.run(x) * 2.2 + body.run(x) * 1.6 + x * 0.35 + s, 1.8) * env * (opts.gain ?? 1);
  }
  return out;
}

/**
 * Thunder, modelled the way the real thing happens: the bolt's channel is a
 * crooked path kilometres long, and every kink of it sends out its own shock
 * wave. The kinks near you arrive first as short, sharp shocks (the ripping
 * crack); the far ones arrive later, stretched long and low by the air (the
 * rolling rumble), bunching up where the channel runs across your line of
 * sight. `crack` is how close the strike is; `rumble` how long it rolls.
 * Rings on past `len` by up to a second as the roll dies away.
 */
export function thunder(r: Rand, len: number, opts: { crack?: number; rumble?: number; gain?: number; delay?: number } = {}): Float32Array {
  const crack = opts.crack ?? 1;
  const rumble = opts.rumble ?? 1;
  const d = opts.delay ?? 0.02;
  const total = len + Math.min(1, 0.7 * rumble);
  const out = buf(total);
  // the channel: a random walk from the ground strike up into the cloud, and a few branches
  const ground = 260 / Math.max(0.3, crack) ** 1.5;
  const pts: [number, number, number, number][] = [];
  const walk = (x: number, y: number, z: number, steps: number, energy: number): void => {
    let dx = 0;
    let dz = 0;
    for (let k = 0; k < steps; k++) {
      dx = dx * 0.6 + (r() * 2 - 1) * 14;
      dz = dz * 0.6 + (r() * 2 - 1) * 14;
      const dy = 4 + r() * 12;
      x += dx;
      y += dy;
      z += dz;
      // the return stroke is fiercest near the ground
      pts.push([x, y, z, energy * Math.hypot(dx, dy, dz) * (1 + 3 * Math.exp(-y / 220))]);
      if (energy > 0.5 && r() < 0.025) walk(x, y, z, 20 + Math.floor(r() * 50), energy * 0.35);
    }
  };
  walk(ground, 0, 0, Math.round(140 + 160 * Math.min(2, len)), 1);
  let near = Infinity;
  let far = 0;
  for (const p of pts) {
    const dist = Math.hypot(p[0], p[1], p[2]);
    near = Math.min(near, dist);
    far = Math.max(far, dist);
    p[1] = dist;
  }
  const rip = buf(total);
  // squeeze kilometres of sound travel into the sound's length; the near end stays in real time
  const span = (len - d) * 0.9;
  for (const p of pts) {
    const k = (p[1] - near) / Math.max(1, far - near);
    const at = d + span * k ** 0.85;
    // shocks stretch as they travel: a few milliseconds up close, tens far away
    const dur = 0.0012 + 0.016 * k ** 0.7 + 0.003 / crack;
    const n = Math.max(4, Math.round(dur * RATE));
    const a = (p[3] / (1 + (p[1] - near) / 1200)) * (r() < 0.5 ? 1 : -0.8) * (k < 0.15 ? crack : rumble * 1.8 + 0.3);
    const o = Math.round(at * RATE);
    for (let i = 0; i < n && o + i < out.length; i++) out[o + i]! += a * (1 - (2 * i) / n);
    // up close each shock front tears the air: a burst of hiss that the darkening never touches
    if (k < 0.2) {
      const m = Math.round((0.002 + r() * 0.004) * RATE);
      const ta = Math.abs(a) * crack * (1 - k / 0.2);
      for (let i = 0; i < m && o + i < out.length; i++) rip[o + i]! += (r() * 2 - 1) * ta * (1 - i / m);
    }
  }
  // the air takes the treble first: brightness falls away as the roll goes on
  const lp1 = new OnePole(9000);
  const lp2 = new OnePole(9000);
  const hi = Math.min(12000, 3500 + 5000 * crack);
  const ripHp = new Biquad('highpass', 900, 0.7);
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    if ((i & 31) === 0) {
      // the crack keeps its bite for its first fifth of a second, then the roll darkens
      const t = i / RATE - d - 0.18;
      const f = t < 0 ? hi : glide(hi * 0.5, 320 + 120 / Math.max(0.3, rumble), t, total * 0.6);
      lp1.set(f);
      lp2.set(f * 1.4);
    }
    out[i] = lp2.run(lp1.run(out[i]!)) + ripHp.run(rip[i]!) * 1.4;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  // a low rolling bed under the shocks, swelling where they bunch up, and the hills echoing it back
  const br = brown(r);
  const bed = new Biquad('lowpass', 170, 0.8);
  const follow = new OnePole(6);
  const wob = wander(r, 4);
  const scale = 1 / Math.max(1e-6, peak);
  for (let i = 0; i < out.length; i++) {
    const x = out[i]! * scale;
    const env = follow.run(Math.abs(x));
    out[i] = x + bed.run(br()) * env * 2 * rumble * (0.7 + 0.3 * wob());
  }
  const wet = tail(out, 1.8, 0.35, 1400);
  const g = opts.gain ?? 1;
  // the crack saturates the way a close strike overloads your ears, which lets the roll sit closer to it
  const fade = total * 0.7;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = drive(wet[i]! * 2.2, 2.2) * g * (t < fade ? 1 : Math.cos(((t - fade) / (total - fade)) * Math.PI * 0.5) ** 2);
  }
  return out;
}

/**
 * A blow that lands with weight: a sharp snap, a saturated punch whose
 * overtones carry even on laptop speakers, a meaty thwack, a crunch, a low
 * sub drop you feel on headphones and a short room tail. `weight` runs from
 * 0.5 (a jab) to 2 (a hammer from the sky); `tone` sets the body's pitch.
 */
export function impact(r: Rand, weight = 1, opts: { tone?: number; snap?: number; crunch?: number; sub?: number; room?: number; gain?: number } = {}): Float32Array {
  const len = 0.3 + 0.25 * weight;
  const out = buf(len);
  const tone = opts.tone ?? 150;
  const snap = opts.snap ?? 1;
  const crunch = opts.crunch ?? 0.7;
  const sub = opts.sub ?? 1;
  const o = new Osc();
  const so = new Osc();
  const nz = white(r);
  const hp = new Biquad('highpass', 2200, 0.7);
  const thwack = new Biquad('bandpass', tone * 2.6, 1.6);
  const crackBody = new Biquad('bandpass', tone * 5.5, 2);
  const cr = new Biquad('bandpass', 1700 + r() * 600, 0.8);
  let grain = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const n = nz();
    const s = hp.run(n) * perc(t, 0.0002, 0.01) * snap * 1.4 + (i === 0 ? snap : 0);
    const punch = drive(o.sine(glide(tone * 2.4, tone * 0.6, t, 0.05 + 0.03 * weight)) * 3, 5) * perc(t, 0.001, 0.18 + 0.14 * weight);
    const w = thwack.run(n) * perc(t, 0.0008, 0.08 + 0.05 * weight) * 4.5 + crackBody.run(n) * perc(t, 0.0005, 0.03 + 0.02 * weight) * 2.5;
    if ((i & 63) === 0) grain = r() < 0.6 ? r() : 0;
    const c = cr.run(n) * grain * perc(t, 0.002, 0.07 + 0.03 * weight) * crunch * 2.2;
    const low = so.sine(glide(75, 38, t, 0.12 * weight)) * perc(t, 0.004, 0.22 * weight) * sub;
    out[i] = drive(s + punch * 0.8 + w + c + low * 0.55, 1.5);
  }
  const wet = tail(out, 0.5, opts.room ?? 0.25, 3000);
  const g = opts.gain ?? 1;
  for (let i = 0; i < out.length; i++) out[i] = wet[i]! * g;
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
