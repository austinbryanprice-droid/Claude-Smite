/**
 * Original procedural score. A handful of instruments are synthesized once
 * (strings, choir, harp, horn, bass, drums) and a small sequencer plays them
 * at pitch from written parts: a slow hymn for the title screen and a
 * battle theme for the match whose drums and brass rise with the fighting.
 */

import type { AudioEngine } from './AudioEngine';
import { ahr, Biquad, buf, fill, Osc, perc, pink, pluck, RATE, tail, wander, white, type Rand } from './dsp';
import { choir, clang, filter, layer, thump } from './gestures';
import type { Recipe } from './sounds';

// ---------------------------------------------------------------------------
// Instruments: rendered at a reference pitch, transposed by playback rate

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function ensemble(r: Rand, len: number, freq: number, voices: number, cutoff: number, detune = 0.012): Float32Array {
  const out = buf(len);
  for (let v = 0; v < voices; v++) {
    const o = new Osc(r());
    const d = 1 + (v - (voices - 1) / 2) * detune / voices * 2;
    const vib = wander(r, 4 + r() * 2);
    const lp = new Biquad('lowpass', cutoff, 0.7);
    const g = 1 / voices;
    fill(out, () => lp.run(o.saw(freq * d * (1 + vib() * 0.0025))) * g);
  }
  // a gentle body resonance
  const pk = new Biquad('peak', freq * 3, 1, 3);
  for (let i = 0; i < out.length; i++) out[i] = pk.run(out[i]!);
  return out;
}

function hornTone(r: Rand, len: number, freq: number): Float32Array {
  const out = buf(len);
  for (let k = 0; k < 3; k++) {
    const o = new Osc(r());
    const d = 1 + (k - 1) * 0.003;
    const lp = new Biquad('lowpass', 900, 1);
    fill(out, (t, i) => {
      const swell = Math.min(1, t / 0.12);
      if ((i & 31) === 0) lp.set(500 + 1100 * swell, 1);
      return lp.run(o.saw(freq * d * (1 + Math.sin(t * 31 + k) * 0.003 * Math.min(1, t / 0.5)))) * 0.4;
    });
  }
  return out;
}

function taiko(r: Rand, len: number, pitch: number, skin: number): Float32Array {
  return layer(
    [thump(r, len, pitch * 2.2, pitch, { click: 0.25, noise: 0.5, drive: 1.8 }), 1],
    [filter(noiseHit(r, len * 0.5, 0.15), 'lowpass', 1200 * skin), 0.5],
  );
}

function noiseHit(r: Rand, len: number, decay: number): Float32Array {
  const out = buf(len);
  const n = white(r);
  fill(out, (t) => n() * perc(t, 0.001, decay));
  return out;
}

function shaker(r: Rand): Float32Array {
  const out = buf(0.12);
  const n = white(r);
  const hp = new Biquad('highpass', 6000, 0.7);
  fill(out, (t) => hp.run(n()) * perc(t, 0.008, 0.08));
  return out;
}

function swell(r: Rand, len: number): Float32Array {
  // a reversed cymbal: noise rising into the downbeat
  const out = buf(len);
  const n = pink(r);
  const hp = new Biquad('highpass', 2500, 0.6);
  fill(out, (t) => hp.run(n()) * Math.pow(t / len, 3));
  return out;
}

function crash(r: Rand): Float32Array {
  const out = buf(3);
  const n = white(r);
  const hp = new Biquad('highpass', 3500, 0.6);
  const bp = new Biquad('bandpass', 7000, 0.8);
  fill(out, (t) => {
    const x = n();
    return (hp.run(x) * 0.6 + bp.run(x) * 0.5) * perc(t, 0.002, 2.6);
  });
  return layer([out, 1], [clang(r, 2.5, 420, { decay: 2, gain: 0.25 }), 1]);
}

function bassTone(r: Rand, len: number, freq: number): Float32Array {
  const out = buf(len);
  const o = new Osc();
  const o2 = new Osc(r());
  const lp = new Biquad('lowpass', freq * 4, 0.9);
  fill(out, () => o.sine(freq) * 0.7 + lp.run(o2.saw(freq)) * 0.35);
  return out;
}

function harp(r: Rand, len: number, freq: number): Float32Array {
  const out = buf(len);
  pluck(out, freq, r, { damp: 0.9985, bright: 0.45 });
  pluck(out, freq * 2.003, r, { damp: 0.997, bright: 0.3, gain: 0.25 });
  return tail(out, 0.8, 0.2, 4000);
}

function bellTone(r: Rand, len: number, freq: number): Float32Array {
  const out = buf(len);
  const ratios: [number, number, number][] = [[1, 1, len], [2.0, 0.35, len * 0.6], [3.01, 0.2, len * 0.35], [4.16, 0.12, len * 0.2]];
  for (const [ratio, g, d] of ratios) {
    const o = new Osc(r());
    fill(out, (t) => o.sine(freq * ratio) * perc(t, 0.002, d) * g);
  }
  return out;
}

function stac(r: Rand, freq: number): Float32Array {
  const len = 0.32;
  const out = ensemble(r, len, freq, 5, freq * 6, 0.02);
  for (let i = 0; i < out.length; i++) out[i]! *= ahr(i / RATE, 0.008, 0.06, 0.24);
  return out;
}

/** Instrument sample, its reference MIDI note, and whether it sustains (held by envelope). */
interface Inst {
  ref: number;
  sustain: boolean;
}

const INST: Record<string, Inst> = {
  'mus.pad.lo': { ref: 45, sustain: true },
  'mus.pad.hi': { ref: 57, sustain: true },
  'mus.choir': { ref: 57, sustain: true },
  'mus.choir.hi': { ref: 69, sustain: true },
  'mus.horn': { ref: 57, sustain: true },
  'mus.horn.lo': { ref: 45, sustain: true },
  'mus.bass': { ref: 33, sustain: true },
  'mus.harp': { ref: 57, sustain: false },
  'mus.harp.hi': { ref: 69, sustain: false },
  'mus.stac': { ref: 50, sustain: false },
  'mus.stac.hi': { ref: 62, sustain: false },
  'mus.bell': { ref: 81, sustain: false },
  'mus.taiko': { ref: 0, sustain: false },
  'mus.taiko.hi': { ref: 0, sustain: false },
  'mus.frame': { ref: 0, sustain: false },
  'mus.shaker': { ref: 0, sustain: false },
  'mus.swell': { ref: 0, sustain: false },
  'mus.crash': { ref: 0, sustain: false },
};

export const INSTRUMENTS: Record<string, Recipe> = {
  'mus.pad.lo': { peak: 0.7, loop: true, make: (r) => ensemble(r, 7, midiHz(45), 7, 1400) },
  'mus.pad.hi': { peak: 0.7, loop: true, make: (r) => ensemble(r, 7, midiHz(57), 7, 2200) },
  'mus.choir': { peak: 0.7, loop: true, make: (r) => choir(r, 7, midiHz(57), { env: () => 1 }) },
  'mus.choir.hi': { peak: 0.7, loop: true, make: (r) => choir(r, 7, midiHz(69), { env: () => 1, vowelName: 'oh' }) },
  'mus.horn': { peak: 0.7, loop: true, make: (r) => hornTone(r, 5, midiHz(57)) },
  'mus.horn.lo': { peak: 0.7, loop: true, make: (r) => hornTone(r, 5, midiHz(45)) },
  'mus.bass': { peak: 0.7, loop: true, make: (r) => bassTone(r, 5, midiHz(33)) },
  'mus.harp': { peak: 0.7, make: (r) => harp(r, 3.5, midiHz(57)) },
  'mus.harp.hi': { peak: 0.7, make: (r) => harp(r, 3, midiHz(69)) },
  'mus.stac': { peak: 0.7, make: (r) => stac(r, midiHz(50)) },
  'mus.stac.hi': { peak: 0.7, make: (r) => stac(r, midiHz(62)) },
  'mus.bell': { peak: 0.6, make: (r) => bellTone(r, 2.5, midiHz(81)) },
  'mus.taiko': { peak: 0.95, make: (r) => taiko(r, 0.9, 55, 0.6) },
  'mus.taiko.hi': { peak: 0.8, make: (r) => taiko(r, 0.5, 110, 1.2) },
  'mus.frame': { peak: 0.6, make: (r) => layer([thump(r, 0.3, 200, 140, { click: 0.4, noise: 0.6, drive: 1.3 }), 1], [filter(noiseHit(r, 0.2, 0.06), 'bandpass', 2500), 0.5]) },
  'mus.shaker': { peak: 0.3, make: (r) => shaker(r) },
  'mus.swell': { peak: 0.5, make: (r) => swell(r, 1.8) },
  'mus.crash': { peak: 0.6, make: (r) => crash(r) },
};

// ---------------------------------------------------------------------------
// Harmony

/** Chords as MIDI notes, root first. D minor and friends. */
const CHORDS: Record<string, number[]> = {
  Dm: [50, 53, 57],
  Bb: [46, 50, 53],
  F: [41, 45, 48],
  C: [48, 52, 55],
  Gm: [43, 46, 50],
  A: [45, 49, 52],
  Asus: [45, 50, 52],
  Am: [45, 48, 52],
  Eb: [51, 55, 58],
  D: [50, 54, 57],
  G: [43, 47, 50],
};

interface Note {
  inst: string;
  midi?: number;
  /** Beat within the bar. */
  beat: number;
  /** Beats held (sustaining instruments). */
  dur?: number;
  gain: number;
  layer: 'base' | 'battle';
  pan?: number;
}

interface Song {
  bpm: number;
  beats: number;
  chords: string[];
  write(bar: number, loop: number, chord: number[], out: Note[]): void;
}

const up = (ns: number[], o: number) => ns.map((n) => n + o);

/** The title screen: a slow, noble hymn. */
const HYMN: Song = {
  bpm: 66,
  beats: 4,
  chords: ['Dm', 'Dm', 'Bb', 'Bb', 'F', 'F', 'C', 'C', 'Gm', 'Gm', 'Bb', 'Bb', 'Asus', 'A', 'Dm', 'Dm'],
  write(bar, loop, ch, out) {
    const pad = bar % 2 === 0;
    if (pad) for (const n of up(ch, 12)) out.push({ inst: 'mus.pad.hi', midi: n, beat: 0, dur: 8, gain: 0.32, layer: 'base' });
    if (bar === 13) for (const n of up(ch, 12)) out.push({ inst: 'mus.pad.hi', midi: n, beat: 0, dur: 4, gain: 0.32, layer: 'base' });
    if (pad || bar === 13) out.push({ inst: 'mus.bass', midi: ch[0]! - 12, beat: 0, dur: bar === 12 || bar === 13 ? 4 : 8, gain: 0.45, layer: 'base' });
    // harp: rolling arpeggio in eighths
    const arp = [ch[0]! + 12, ch[1]! + 12, ch[2]! + 12, ch[0]! + 24, ch[2]! + 12, ch[1]! + 12, ch[0]! + 12, ch[2]!];
    arp.forEach((n, i) => out.push({ inst: n >= 69 ? 'mus.harp.hi' : 'mus.harp', midi: n, beat: i * 0.5, gain: 0.3 + (i === 0 ? 0.1 : 0), layer: 'base', pan: (i % 2 ? 0.3 : -0.3) }));
    if (loop >= 1 && pad) for (const n of up(ch, 12)) out.push({ inst: 'mus.choir', midi: n, beat: 0, dur: 8, gain: 0.22, layer: 'base' });
    if (bar % 4 === 0) out.push({ inst: 'mus.taiko', beat: 0, gain: 0.5, layer: 'base' });
    if (bar % 4 === 3) out.push({ inst: 'mus.taiko.hi', beat: 3.5, gain: 0.3, layer: 'base' });
    // the horn's theme over the second half
    const theme: Record<number, [number, number, number][]> = {
      8: [[62, 0, 2], [65, 2, 1], [67, 3, 1]],
      9: [[69, 0, 4]],
      10: [[70, 0, 2], [69, 2, 1], [67, 3, 1]],
      11: [[65, 0, 4]],
      12: [[64, 0, 2], [65, 2, 1], [64, 3, 1]],
      13: [[61, 0, 4]],
      14: [[62, 0, 4]],
    };
    for (const [m, b, d] of theme[bar] ?? []) out.push({ inst: 'mus.horn', midi: m - 12, beat: b, dur: d, gain: 0.34, layer: 'base' });
    if (loop >= 1 && bar === 14) out.push({ inst: 'mus.bell', midi: 86, beat: 0, gain: 0.25, layer: 'base' }, { inst: 'mus.bell', midi: 81, beat: 1, gain: 0.2, layer: 'base' });
  },
};

/** The match: a driving battle theme. The `battle` layer rises with the fighting. */
const BATTLE: Song = {
  bpm: 96,
  beats: 4,
  chords: ['Dm', 'Dm', 'Bb', 'C', 'Dm', 'Dm', 'Gm', 'A', 'Dm', 'Bb', 'F', 'C', 'Gm', 'Bb', 'Asus', 'A'],
  write(bar, loop, ch, out) {
    // -- base: always playing, quiet when exploring
    if (bar % 2 === 0 || bar >= 14) for (const n of up(ch, 12)) out.push({ inst: 'mus.pad.hi', midi: n, beat: 0, dur: bar >= 14 ? 4 : 8, gain: 0.22, layer: 'base' });
    for (let b = 0; b < 4; b++) out.push({ inst: 'mus.bass', midi: ch[0]! - 12, beat: b, dur: 0.8, gain: b === 0 ? 0.45 : 0.3, layer: 'base' });
    const ost = [ch[0]! + 12, ch[2]! + 12, ch[1]! + 12, ch[2]! + 12];
    for (let i = 0; i < 8; i++) out.push({ inst: 'mus.harp', midi: ost[i % 4]!, beat: i * 0.5, gain: 0.2, layer: 'base', pan: i % 2 ? 0.25 : -0.25 });
    out.push({ inst: 'mus.frame', beat: 0, gain: 0.35, layer: 'base' }, { inst: 'mus.frame', beat: 2.5, gain: 0.25, layer: 'base' });
    if (loop % 2 === 1 && bar % 4 === 0) out.push({ inst: 'mus.bell', midi: ch[0]! + 36, beat: 0, gain: 0.15, layer: 'base' });

    // -- battle: taiko, string ostinato, brass and choir
    const taiko: [number, number, string][] = [[0, 0.9, 'mus.taiko'], [0.75, 0.4, 'mus.taiko.hi'], [1.5, 0.6, 'mus.taiko'], [2, 0.7, 'mus.taiko'], [2.75, 0.4, 'mus.taiko.hi'], [3, 0.5, 'mus.taiko.hi'], [3.5, 0.6, 'mus.taiko']];
    for (const [b, g, inst] of taiko) out.push({ inst, beat: b, gain: g, layer: 'battle' });
    if (bar % 4 === 3) for (const b of [3.25, 3.5, 3.75]) out.push({ inst: 'mus.taiko.hi', beat: b, gain: 0.45, layer: 'battle' });
    for (let i = 0; i < 16; i++) out.push({ inst: 'mus.shaker', beat: i * 0.25, gain: i % 4 === 2 ? 0.4 : 0.22, layer: 'battle', pan: 0.4 });
    const st = [ch[0]!, ch[0]!, ch[2]!, ch[0]!, ch[1]!, ch[0]!, ch[2]!, ch[0]! + 12];
    st.forEach((n, i) => out.push({ inst: n >= 60 ? 'mus.stac.hi' : 'mus.stac', midi: n, beat: i * 0.5, gain: i % 2 ? 0.28 : 0.38, layer: 'battle', pan: -0.2 }));
    if (bar % 2 === 0) {
      for (const n of up(ch, 0)) out.push({ inst: 'mus.horn.lo', midi: n, beat: 0, dur: 1.5, gain: 0.3, layer: 'battle' });
      for (const n of up(ch, 12)) out.push({ inst: 'mus.choir', midi: n, beat: 0, dur: 8, gain: 0.18, layer: 'battle' });
    }
    // a heroic horn line in the second half
    const theme: Record<number, [number, number, number][]> = {
      8: [[62, 0, 1.5], [64, 1.5, 0.5], [65, 2, 2]],
      9: [[62, 0, 1.5], [65, 1.5, 0.5], [70, 2, 2]],
      10: [[69, 0, 3], [67, 3, 1]],
      11: [[64, 0, 4]],
      12: [[62, 0, 1.5], [65, 1.5, 0.5], [67, 2, 2]],
      13: [[70, 0, 1.5], [69, 1.5, 0.5], [67, 2, 2]],
      14: [[69, 0, 4]],
      15: [[73, 0, 2], [76, 2, 2]],
    };
    for (const [m, b, d] of theme[bar] ?? []) out.push({ inst: 'mus.horn', midi: m - 12, beat: b, dur: d, gain: 0.32, layer: 'battle' });
    if (bar === 15) out.push({ inst: 'mus.swell', beat: 4 - (1.8 * BATTLE.bpm) / 60, gain: 0.5, layer: 'battle' });
    if (bar === 0) out.push({ inst: 'mus.crash', beat: 0, gain: 0.35, layer: 'battle' });
  },
};

const SONGS = { hymn: HYMN, battle: BATTLE } as const;
export type SongName = keyof typeof SONGS;

// ---------------------------------------------------------------------------
// Sequencer

interface Playing {
  song: Song;
  out: GainNode;
  layers: Record<Note['layer'], GainNode>;
  bar: number;
  loop: number;
  nextBar: number;
  stopped: boolean;
}

export class Music {
  private playing: Playing | null = null;
  private timer = 0;
  private intensity = 0;
  private want: SongName | null = null;

  constructor(private readonly engine: AudioEngine) {
    engine.onUnlock(() => {
      if (this.want) this.play(this.want);
    });
  }

  /** Switch to a song (crossfading); no-op if it is already playing. */
  play(name: SongName): void {
    this.want = name;
    const ctx = this.engine.ctx;
    const bus = this.engine.bus('music');
    if (!ctx || !bus || !this.engine.ready) return;
    const song = SONGS[name];
    if (this.playing?.song === song && !this.playing.stopped) return;
    this.fadeOut(2.5);
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(1, ctx.currentTime, 0.6);
    out.connect(bus);
    const mk = () => {
      const g = ctx.createGain();
      g.connect(out);
      return g;
    };
    const layers = { base: mk(), battle: mk() };
    layers.battle.gain.value = 0;
    this.playing = { song, out, layers, bar: 0, loop: 0, nextBar: ctx.currentTime + 0.3, stopped: false };
    if (!this.timer) this.timer = window.setInterval(() => this.schedule(), 40);
    this.schedule();
  }

  stop(fade = 2): void {
    this.want = null;
    this.fadeOut(fade);
  }

  private fadeOut(fade: number): void {
    const p = this.playing;
    const ctx = this.engine.ctx;
    if (!p || !ctx || p.stopped) return;
    p.stopped = true;
    p.out.gain.cancelScheduledValues(ctx.currentTime);
    p.out.gain.setTargetAtTime(0, ctx.currentTime, fade / 4);
    setTimeout(() => p.out.disconnect(), (fade + 1) * 1000);
    this.playing = null;
  }

  /** 0 = exploring, 1 = all-out fight. Smoothed here. */
  setIntensity(v: number, dt: number): void {
    const target = Math.max(0, Math.min(1, v));
    const k = target > this.intensity ? 1 - Math.exp(-dt * 2.5) : 1 - Math.exp(-dt * 0.25);
    this.intensity += (target - this.intensity) * k;
    const p = this.playing;
    const ctx = this.engine.ctx;
    if (!p || !ctx) return;
    p.layers.battle.gain.setTargetAtTime(Math.pow(this.intensity, 0.8), ctx.currentTime, 0.2);
    p.layers.base.gain.setTargetAtTime(1 - this.intensity * 0.3, ctx.currentTime, 0.2);
  }

  /** A short fanfare over everything (victory, defeat). */
  sting(kind: 'victory' | 'defeat'): void {
    const ctx = this.engine.ctx;
    const bus = this.engine.bus('music');
    if (!ctx || !bus) return;
    this.stop(1.5);
    const at = ctx.currentTime + 0.4;
    const g = ctx.createGain();
    g.connect(bus);
    const play = (inst: string, midi: number | undefined, t: number, dur: number, gain: number) => this.note(inst, midi, at + t, dur, gain, g);
    if (kind === 'victory') {
      for (const [t, ch] of [[0, CHORDS.D!], [1.1, CHORDS.G!], [2.2, CHORDS.D!]] as const) {
        for (const n of ch) {
          play('mus.horn', n + 12 - 12, t, t === 2.2 ? 4 : 1, 0.35);
          play('mus.pad.hi', n + 12, t, t === 2.2 ? 5 : 1.2, 0.3);
          play('mus.choir', n + 12, t, t === 2.2 ? 5 : 1.2, 0.25);
        }
        play('mus.taiko', undefined, t, 0, 0.9);
      }
      play('mus.crash', undefined, 2.2, 0, 0.5);
      play('mus.bell', 86, 2.4, 0, 0.3);
      play('mus.bell', 90, 2.6, 0, 0.25);
      play('mus.bell', 93, 2.8, 0, 0.25);
    } else {
      for (const [t, ch] of [[0, CHORDS.Dm!], [1.4, CHORDS.Bb!], [2.8, CHORDS.Gm!], [4.2, CHORDS.Dm!]] as const) {
        for (const n of ch) {
          play('mus.pad.lo', n, t, t === 4.2 ? 5 : 1.5, 0.35);
          play('mus.choir', n + 12, t, t === 4.2 ? 5 : 1.5, 0.2);
        }
        play('mus.horn.lo', ch[0]!, t, 1.2, 0.3);
        play('mus.taiko', undefined, t, 0, 0.6);
      }
    }
    setTimeout(() => g.disconnect(), 12000);
  }

  private schedule(): void {
    const p = this.playing;
    const ctx = this.engine.ctx;
    if (!p || !ctx) return;
    // background tabs throttle timers to ~1 Hz, so look further ahead there
    const ahead = document.hidden ? 1.6 : 0.35;
    const beatLen = 60 / p.song.bpm;
    const barLen = p.song.beats * beatLen;
    while (p.nextBar < ctx.currentTime + ahead) {
      // after a stall (a frozen tab, a long hitch) skip the bars that already went by
      const late = p.nextBar + barLen < ctx.currentTime;
      const notes: Note[] = [];
      const chord = CHORDS[p.song.chords[p.bar]!]!;
      if (!late) p.song.write(p.bar, p.loop, chord, notes);
      for (const n of notes) if (p.nextBar + n.beat * beatLen >= ctx.currentTime - 0.02) this.note(n.inst, n.midi, p.nextBar + n.beat * beatLen, (n.dur ?? 0) * beatLen, n.gain, p.layers[n.layer], n.pan);
      p.nextBar += p.song.beats * beatLen;
      p.bar++;
      if (p.bar >= p.song.chords.length) {
        p.bar = 0;
        p.loop++;
      }
    }
  }

  private note(inst: string, midi: number | undefined, when: number, dur: number, gain: number, dest: AudioNode, pan?: number): void {
    const ctx = this.engine.ctx!;
    const meta = INST[inst];
    const buffer = this.engine.buffer(inst);
    if (!meta || !buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (midi !== undefined && meta.ref) src.playbackRate.value = Math.pow(2, (midi - meta.ref) / 12);
    const g = ctx.createGain();
    let node: AudioNode = src.connect(g);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(dest);
    if (meta.sustain) {
      const attack = inst.startsWith('mus.horn') ? 0.06 : inst === 'mus.bass' ? 0.02 : 0.45;
      const release = inst.startsWith('mus.horn') ? 0.25 : inst === 'mus.bass' ? 0.15 : 1.4;
      const hold = Math.max(attack, dur);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(gain, when + attack);
      g.gain.setValueAtTime(gain, when + hold);
      g.gain.setTargetAtTime(0, when + hold, release / 3);
      const end = hold + release * 1.5;
      src.loop = true;
      src.start(when, Math.random() * buffer.duration * 0.5);
      src.stop(when + end);
    } else {
      g.gain.value = gain;
      src.start(when);
    }
    src.onended = () => g.disconnect();
  }
}

