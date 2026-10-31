// Renders the trailer's soundtrack (out/score.wav, 44.1 kHz stereo)
// from the game's own synthesized instruments and sound bank, laid on
// timeline.mjs, with the narration on top and the music ducked under it.
//
//   npx tsx tools/trailer/score.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { CHORDS, INST, INSTRUMENTS, SONGS } from '../../src/audio/music';
import { renderRecipe, SOUNDS } from '../../src/audio/sounds';
import { skillPart, jobs } from '../../src/audio/bank';
import { seeded, hashSeed, RATE } from '../../src/audio/dsp';
import { thunder, whoosh } from '../../src/audio/gestures';
import { GODS } from '../../src/game/gods';
// @ts-expect-error plain JS module shared with compose.html
import { FINALE, HEROES, LENGTH, TITLE, VOICE } from './timeline.mjs';

const here = new URL('./', import.meta.url);
const lengths: Record<string, number> = JSON.parse(readFileSync(new URL('out/voice/lengths.json', here), 'utf8'));
const N = Math.ceil(LENGTH * RATE);
const L = new Float32Array(N);
const R = new Float32Array(N);

// ---------------------------------------------------------------------------
// Samples

const cache = new Map<string, Float32Array>();
const recipes = new Map(jobs().map((j) => [j.name, j.recipe] as const));
function sample(name: string, variant = 0): Float32Array {
  const key = `${name}#${variant}`;
  let b = cache.get(key);
  if (!b) {
    const recipe = INSTRUMENTS[name] ?? SOUNDS[name] ?? recipes.get(name);
    if (!recipe) throw new Error(`no sound ${name}`);
    const all = renderRecipe(recipe, hashSeed(name));
    all.forEach((v, i) => cache.set(`${name}#${i}`, v));
    b = all[Math.min(variant, all.length - 1)]!;
  }
  return b;
}

/** Mixes a buffer in at `t` seconds, resampled by `rate`, with a gain envelope and pan. */
function put(b: Float32Array, t: number, gain: number, opts: { rate?: number; pan?: number; dur?: number; loop?: boolean; env?: (s: number) => number } = {}): void {
  const rate = opts.rate ?? 1;
  const start = Math.round(t * RATE);
  const len = opts.dur !== undefined ? Math.round(opts.dur * RATE) : Math.floor(b.length / rate);
  const pan = opts.pan ?? 0;
  const gl = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  for (let i = 0; i < len; i++) {
    const o = start + i;
    if (o < 0) continue;
    if (o >= N) break;
    let p = i * rate;
    if (opts.loop) p %= b.length - 1;
    const k = Math.floor(p);
    if (k + 1 >= b.length) break;
    const v = (b[k]! + (b[k + 1]! - b[k]!) * (p - k)) * gain * (opts.env ? opts.env(i / RATE) : 1);
    L[o]! += v * gl;
    R[o]! += v * gr;
  }
}

/** One musical note, as the game's sequencer plays it (sustained notes loop under an envelope). */
function note(inst: string, midi: number | undefined, t: number, dur: number, gain: number, pan = 0): void {
  const meta = INST[inst]!;
  const rate = midi !== undefined && meta.ref ? Math.pow(2, (midi - meta.ref) / 12) : 1;
  const b = sample(inst);
  if (!meta.sustain) return put(b, t, gain, { rate, pan });
  const attack = inst.startsWith('mus.horn') ? 0.06 : inst === 'mus.bass' ? 0.02 : 0.45;
  const release = inst.startsWith('mus.horn') ? 0.25 : inst === 'mus.bass' ? 0.15 : 1.4;
  const hold = Math.max(attack, dur);
  put(b, t, gain, {
    rate,
    pan,
    loop: true,
    dur: hold + release * 1.5,
    env: (s) => (s < attack ? s / attack : s < hold ? 1 : Math.exp(-(s - hold) / (release / 3))),
  });
}

// ---------------------------------------------------------------------------
// Music: a dark swell to the title, the battle theme under the gods and the
// game, quieter while the rules are explained, a held breath, and a last hit.

const music = { L: new Float32Array(N), R: new Float32Array(N) };
function intoMusic(fn: () => void): void {
  // render into the main bus, then move it to the music stem
  fn();
  for (let i = 0; i < N; i++) {
    music.L[i]! += L[i]!;
    music.R[i]! += R[i]!;
    L[i] = 0;
    R[i] = 0;
  }
}

intoMusic(() => {
  const dm = CHORDS.Dm!;
  for (const n of dm) note('mus.pad.lo', n - 12, 0.3, TITLE - 0.6, 0.32);
  note('mus.bass', dm[0]! - 24, 0.3, TITLE - 0.5, 0.4);
  for (const n of dm) note('mus.choir', n, 3.0, TITLE - 3.3, 0.2);
  for (const t of [0.6, 3.1, 5.1]) note('mus.taiko', undefined, t, 0, 0.8);
  for (const t of [6.1, 6.55, 6.85, 7.05, 7.2]) note('mus.taiko.hi', undefined, t, 0, 0.35 + (t - 6) * 0.3);
  note('mus.swell', undefined, TITLE - 1.8, 0, 0.7);
});

const battleGain = (t: number): number => {
  if (t < HEROES[0].at) return 0.55;
  if (t < VOICE.skills1 - 0.6) return 0.85;
  if (t < VOICE.conquest - 0.4) return 0.3;
  return 1;
};
const BATTLE_END = VOICE.close1 - 0.3;
intoMusic(() => {
  const song = SONGS.battle;
  const beat = 60 / song.bpm;
  for (let bar = 0, t = TITLE; t < BATTLE_END; bar++, t += song.beats * beat) {
    const notes: { inst: string; midi?: number; beat: number; dur?: number; gain: number; layer: string; pan?: number }[] = [];
    const i = bar % song.chords.length;
    song.write(i, Math.floor(bar / song.chords.length) + 1, CHORDS[song.chords[i]!]!, notes as never);
    for (const n of notes) {
      const at = t + n.beat * beat;
      if (at >= BATTLE_END) continue;
      const g = n.layer === 'battle' ? battleGain(at) : 1;
      note(n.inst, n.midi, at, Math.min((n.dur ?? 0) * beat, BATTLE_END - at), n.gain * g, n.pan ?? 0);
    }
  }
  note('mus.crash', undefined, TITLE, 0, 0.5);
});

intoMusic(() => {
  // the held breath before "Ascend", then the last chord
  for (const n of CHORDS.Bb!) note('mus.pad.hi', n + 12, VOICE.close1 - 0.3, FINALE - VOICE.close1, 0.26);
  for (const n of CHORDS.Bb!) note('mus.choir', n + 12, VOICE.close1, FINALE - VOICE.close1 - 0.2, 0.2);
  note('mus.swell', undefined, FINALE - 1.8, 0, 0.6);
  for (const n of CHORDS.D!) {
    note('mus.horn', n, FINALE, 3.2, 0.36);
    note('mus.pad.hi', n + 12, FINALE, 4, 0.3);
    note('mus.choir', n + 12, FINALE, 4, 0.28);
  }
  note('mus.bass', CHORDS.D![0]! - 24, FINALE, 4, 0.5);
  note('mus.taiko', undefined, FINALE, 0, 1);
  note('mus.crash', undefined, FINALE, 0, 0.6);
  for (const [k, m] of [86, 90, 93].entries()) note('mus.bell', m, FINALE + 0.4 + k * 0.25, 0, 0.25);
});

// ---------------------------------------------------------------------------
// Effects

const r = seeded(7);
const sfx = (name: string, t: number, gain = 1, pan = 0, variant = 0) => put(sample(name, variant), t, gain, { pan });
put(thunder(r, 3.2, { crack: 1.2, rumble: 1.3 }), 0.55, 0.75);
put(thunder(r, 3.5, { crack: 1.4, rumble: 1.5 }), TITLE - 0.02, 0.8);
sfx('sting.epic', TITLE, 0.75);
// a quick cut montage under "Now, they rise again"
for (const [k, t] of [5.2, 5.9, 6.6].entries()) sfx('hit.blunt', t + 0.25, 0.5, k % 2 ? 0.3 : -0.3, k);

// each hero clip: the ultimate at 0.15 s, the first skill at 1.25 s, a whoosh on the cut
for (const h of HEROES) {
  const def = GODS.find((g) => g.id === h.god)!;
  const ult = def.defaultLoadout[4]!;
  const first = def.defaultLoadout[0]!;
  put(whoosh(r, 0.5, 300, 2600, { q: 0.9, peak: 0.7 }), h.at - 0.3, 0.45);
  for (const [id, at] of [[ult, 0.15], [first, 1.25]] as const) {
    for (const part of ['cast', 'impact'] as const) {
      const name = skillPart(id, part);
      if (!recipes.has(name)) continue;
      sfx(name, h.at + at + (part === 'impact' ? 0.45 : 0), part === 'impact' ? 0.55 : 0.6);
    }
  }
}
// section changes
for (const t of [VOICE.skills1 - 0.4, VOICE.trees - 0.4, VOICE.conquest - 0.5, VOICE.jungle - 0.4, VOICE.bosses - 0.4, VOICE.multi - 0.4]) put(whoosh(r, 0.7, 250, 3000, { q: 0.8, peak: 0.65 }), t, 0.4);
sfx('ui.select', VOICE.skills1 + 1.6, 0.35);
sfx('ui.point', VOICE.trees + 2.0, 0.35);
sfx('ui.point', VOICE.trees + 4.0, 0.35);
sfx('wave.horn', VOICE.conquest - 0.2, 0.45);
sfx('tower.shot', VOICE.conquest + 5.2, 0.4);
sfx('structure.collapse', VOICE.conquest + 8.2, 0.45);
sfx('monster.aggro', VOICE.jungle + 0.8, 0.4);
sfx('wyrm.roar', VOICE.bosses + 0.3, 0.5);
sfx('colossus.stomp', VOICE.bosses + 3.2, 0.55);
sfx('kill.confirm', VOICE.multi + 3.4, 0.3);
put(thunder(r, 3.5, { crack: 1.2, rumble: 1.4 }), FINALE - 0.02, 0.7);

// ---------------------------------------------------------------------------
// Mix: music ducks under the voice, a little room on everything, a soft limiter

const voiceAt = (t: number): number => {
  for (const [id, at] of Object.entries(VOICE)) if (t > at - 0.15 && t < at + (lengths[id] ?? 0) + 0.2) return 1;
  return 0;
};
/** The narration (out/voice44: make.sh resamples the TTS output to 44.1 kHz). */
function readWav(path: URL): Float32Array {
  const b = readFileSync(path);
  let o = 12;
  while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  const n = b.readUInt32LE(o + 4) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
  return x;
}
const voice = new Float32Array(N);
for (const [id, at] of Object.entries(VOICE)) {
  const x = readWav(new URL(`out/voice44/${id}.wav`, here));
  const o = Math.round((at as number) * RATE);
  for (let i = 0; i < x.length && o + i < N; i++) voice[o + i]! += x[i]!;
}

let duck = 0;
const out = { L: new Float32Array(N), R: new Float32Array(N) };
for (let i = 0; i < N; i++) {
  const target = voiceAt(i / RATE);
  duck += (target - duck) * (target > duck ? 0.0006 : 0.00012);
  const m = 0.9 * (1 - 0.62 * duck);
  out.L[i] = music.L[i]! * m + L[i]! * 0.85 * (1 - 0.45 * duck) + voice[i]! * 2.6;
  out.R[i] = music.R[i]! * m + R[i]! * 0.85 * (1 - 0.45 * duck) + voice[i]! * 2.6;
}

// Schroeder reverb (4 combs, 2 allpasses per side)
function reverb(x: Float32Array, spread: number): Float32Array {
  const y = new Float32Array(x.length);
  for (const d of [1557, 1617, 1491, 1422]) {
    const len = d + spread;
    const buf = new Float32Array(len);
    let p = 0;
    let lp = 0;
    for (let i = 0; i < x.length; i++) {
      const o = buf[p]!;
      lp = o * 0.7 + lp * 0.3;
      buf[p] = x[i]! + lp * 0.8;
      y[i]! += o * 0.25;
      p = (p + 1) % len;
    }
  }
  for (const d of [225, 556]) {
    const buf = new Float32Array(d + spread);
    let p = 0;
    for (let i = 0; i < y.length; i++) {
      const b = buf[p]!;
      const v = y[i]! + b * 0.5;
      buf[p] = v;
      y[i] = b - v * 0.5;
      p = (p + 1) % buf.length;
    }
  }
  return y;
}
{
  // how far the narration sits above everything else while it speaks
  let v = 0, rest = 0;
  for (let i = 0; i < N; i++) {
    if (!voiceAt(i / RATE)) continue;
    v += (voice[i]! * 2.6) ** 2;
    rest += (out.L[i]! - voice[i]! * 2.6) ** 2;
  }
  console.log('voice over bed', (10 * Math.log10(v / rest)).toFixed(1), 'dB');
}
const wl = reverb(out.L, 0);
const wr = reverb(out.R, 23);
let peak = 0;
for (let i = 0; i < N; i++) {
  out.L[i] = out.L[i]! + wl[i]! * 0.22;
  out.R[i] = out.R[i]! + wr[i]! * 0.22;
  peak = Math.max(peak, Math.abs(out.L[i]!), Math.abs(out.R[i]!));
}
const norm = 0.8 / peak;
const fadeOut = (i: number) => Math.min(1, (N - i) / (RATE * 1.5));

const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + N * 4, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const f = fadeOut(i) * norm;
  wav.writeInt16LE(Math.round(Math.tanh(out.L[i]! * f * 1.1) * 32767 * 0.95), 44 + i * 4);
  wav.writeInt16LE(Math.round(Math.tanh(out.R[i]! * f * 1.1) * 32767 * 0.95), 46 + i * 4);
}
mkdirSync(new URL('out/', here), { recursive: true });
writeFileSync(new URL('out/score.wav', here), wav);
console.log('score.wav', LENGTH, 's, peak', peak.toFixed(2));
