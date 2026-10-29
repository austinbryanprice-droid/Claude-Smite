/**
 * Every skill's own sounds: what it sounds like when cast, while it travels
 * or lingers, and when it lands. Each god has a sonic palette (Zeus crackles
 * and booms, Thor rings steel and thunder, Odin sings runes and war horns,
 * Loki whispers smoke and steel, Anubis hisses sand and wails like the dead)
 * and each skill is a distinct arrangement of it.
 */

import { ahr, bell, buf, fill, glide, Osc, perc, type Rand } from './dsp';
import {
  buzz, chime, choir, clang, debris, filter, fire, layer, puff, rumble, sand, shape, shimmer, thump, thunder, twang, vowel, VOWELS, whoosh, zap,
} from './gestures';
import type { Recipe } from './sounds';

export interface SkillSound {
  cast: Recipe['make'];
  /** Loop while the skill's projectile flies. */
  travel?: Recipe['make'];
  /** Where it lands: projectile hits, leap landings, or the area of an instant skill. */
  impact?: Recipe['make'];
  /** Loop while the skill's lingering area lasts. */
  zone?: Recipe['make'];
  /** Each damage tick of a lingering area. */
  tick?: Recipe['make'];
  /** Seconds after the cast that an instant area's impact plays (0 = with the cast). */
  impactDelay?: number;
}

// ---------------------------------------------------------------------------
// Shared pieces

const bolt = (r: Rand, len = 0.35, pitch = 1): Float32Array =>
  layer([zap(r, len, 260 * pitch, { chaos: 0.9, fall: 0.4, hiss: 1.2 }), 0.9], [thunder(r, len * 1.6, { crack: 1.2, rumble: 0.3 }), 0.8]);

const boom = (r: Rand, len = 1.6, crack = 1, rumbleAmt = 1): Float32Array =>
  layer([thunder(r, len, { crack, rumble: rumbleAmt }), 1], [thump(r, 0.7, 90, 30, { click: 0.5, noise: 0.8, drive: 2.5 }), 0.8]);

const hum = (r: Rand, len: number, f: number, crackle = 1): Float32Array =>
  layer([zap(r, len, f, { chaos: 0.3, fall: 1, hiss: 0.6 * crackle }), 0.6], [shimmer(r, len, f * 2, { rise: 1, peak: 0.5, voices: 4 }), 0.6]);

const metal = (r: Rand, base: number, len = 0.8): Float32Array => clang(r, len, base, { decay: len * 0.8 });

const swing = (r: Rand, len: number, lo: number, hi: number, gain = 1.3): Float32Array => whoosh(r, len, lo, hi, { q: 1.2, peak: 0.6, gain });

const runes = (r: Rand, len: number, root: number, rise = 1): Float32Array =>
  layer([choir(r, len, root, { env: (t) => ahr(t, len * 0.3, len * 0.3, len * 0.4) }), 0.7], [shimmer(r, len, root * 2, { rise, peak: 0.5 }), 0.6], [chime(r, len, root * 4), 0.35]);

const warHorn = (r: Rand, len: number, f: number): Float32Array => {
  const out = buf(len);
  for (const ratio of [1, 1.5, 2]) {
    const o = new Osc(r());
    fill(out, (t) => {
      const env = ahr(t, 0.18, len * 0.5, len * 0.35);
      return o.saw(f * ratio * (1 + Math.sin(t * 28) * 0.004)) * env * 0.3 * (ratio === 1 ? 1 : 0.5);
    });
  }
  return filter(out, 'lowpass', 1600, 0.9);
};

const dagger = (r: Rand, len = 0.16): Float32Array => layer([whoosh(r, len, 1600, 4200, { q: 2.2, peak: 0.55 }), 1], [clang(r, 0.18, 3300 + r() * 600, { decay: 0.1, gain: 0.25 }), 1]);

const smoke = (r: Rand, len = 0.6): Float32Array => layer([puff(r, len, { tone: 800 }), 1], [whoosh(r, len * 0.8, 1200, 400, { q: 0.7 }), 0.5]);

const sly = (r: Rand, len: number): Float32Array => {
  // a sucked-in, reversed shimmer: the trickster's tell
  const s = shimmer(r, len, 700, { rise: 0.6, peak: 0.85, voices: 5 });
  return layer([s, 1], [whoosh(r, len, 600, 2600, { q: 1, peak: 0.85 }), 0.5]);
};

const venom = (r: Rand, len: number): Float32Array => {
  const out = buf(len);
  const count = Math.round(len * 30);
  for (let k = 0; k < count; k++) {
    const at = r() * len * 0.9;
    const f = 250 + r() * 500;
    const d = 0.03 + r() * 0.06;
    const o = new Osc();
    fill(out, (t) => o.sine(f * (1 + t * 9)) * perc(t, 0.002, d) * 0.4, at, at + d * 1.5);
  }
  return layer([out, 1], [filter(sand(r, len, { tone: 1600, peak: 0.4 }), 'lowpass', 2500), 0.4]);
};

const wail = (r: Rand, len: number, f: number): Float32Array =>
  vowel(r, len, (t) => f * (1 + 0.2 * bell(t, len, 0.4)) * (1 + Math.sin(t * 5) * 0.02), VOWELS.oo, { voices: 3, detune: 0.03, breath: 0.25, vibrato: 0.02, env: (t) => ahr(t, len * 0.25, len * 0.3, len * 0.45) });

const gong = (r: Rand, len: number, f: number): Float32Array =>
  layer([clang(r, len, f, { decay: len, bright: 0.5, gain: 0.8 }), 1], [thump(r, 0.5, f * 1.2, f * 0.6, { click: 0.3, drive: 1.5 }), 0.6]);

const cloth = (r: Rand, len: number): Float32Array => layer([whoosh(r, len, 900, 2200, { q: 0.6, peak: 0.4, grit: 1.2 }), 1], [filter(puff(r, len, { tone: 2500 }), 'highpass', 600), 0.5]);

const loop = (b: Float32Array): Float32Array => b;

// ---------------------------------------------------------------------------
// The table

export const SKILL_SOUNDS: Record<string, SkillSound> = {
  // ===== Zeus: crackle, hum, thunder
  'zeus.arc-bolt': {
    cast: (r) => layer([bolt(r, 0.3, 1.2), 1], [whoosh(r, 0.2, 2500, 6000, { q: 1 }), 0.5]),
    travel: (r) => loop(hum(r, 1, 300, 1.4)),
    impact: (r) => layer([zap(r, 0.28, 600, { chaos: 1, hiss: 1.4 }), 1], [thunder(r, 0.5, { crack: 1, rumble: 0.2 }), 0.7]),
  },
  'zeus.storm-step': {
    cast: (r) => layer([thunder(r, 0.9, { crack: 1.4, rumble: 0.5 }), 1], [whoosh(r, 0.3, 6000, 800, { q: 0.8 }), 0.8], [zap(r, 0.4, 180, { chaos: 1.2, hiss: 1 }), 0.6]),
    impact: (r) => zap(r, 0.25, 420, { chaos: 0.8, hiss: 1 }),
  },
  'zeus.thundering-presence': {
    cast: (r) => layer([boom(r, 1.4, 1.2, 0.7), 1], [hum(r, 1.2, 140, 1.6), 0.6], [zap(r, 0.6, 90, { chaos: 0.6, fall: 3, hiss: 0.6 }), 0.5]),
  },
  'zeus.static-discharge': {
    cast: (r) => layer([zap(r, 0.6, 80, { chaos: 0.5, fall: 6, hiss: 1.4 }), 1], [shimmer(r, 0.6, 600, { rise: 3, peak: 0.9 }), 0.6]),
    impact: (r) => layer([bolt(r, 0.4, 0.8), 1], [thump(r, 0.4, 140, 50, { click: 0.6, drive: 2 }), 0.6]),
    impactDelay: 0.25,
  },
  'zeus.aegis-of-clouds': {
    cast: (r) => layer([filter(rumble(r, 1.6, { tone: 300, attack: 0.3 }), 'lowpass', 600), 0.8], [whoosh(r, 1.4, 300, 1200, { q: 0.6, peak: 0.4 }), 0.8], [hum(r, 1.4, 220, 0.6), 0.4], [chime(r, 1.2, 880), 0.3, 0.2]),
  },
  'zeus.ball-lightning': {
    cast: (r) => layer([zap(r, 0.5, 120, { chaos: 0.4, fall: 2.5, hiss: 0.8 }), 1], [whoosh(r, 0.5, 400, 2000, { q: 0.9 }), 0.6]),
    travel: (r) => layer([hum(r, 1.2, 110, 2), 1], [zap(r, 1.2, 55, { chaos: 0.2, fall: 1, hiss: 0.2 }), 0.5]),
    impact: (r) => zap(r, 0.2, 500, { chaos: 1, hiss: 1.2, gain: 0.8 }),
  },
  'zeus.wrath-mark': {
    cast: (r) => layer([zap(r, 0.25, 700, { chaos: 0.3, fall: 1.3, hiss: 0.6 }), 1], [whoosh(r, 0.2, 3000, 7000, { q: 1.4 }), 0.6]),
    travel: (r) => hum(r, 0.8, 660, 0.8),
    impact: (r) => layer([chime(r, 1, 1318.5), 0.7], [thunder(r, 0.6, { crack: 0.8, rumble: 0.2 }), 0.8], [zap(r, 0.2, 900, { chaos: 0.5 }), 0.5]),
  },
  'zeus.cyclone': {
    cast: (r) => layer([whoosh(r, 0.8, 200, 1400, { q: 0.8, peak: 0.7, gain: 1.4 }), 1], [zap(r, 0.4, 150, { chaos: 0.5 }), 0.4]),
    zone: (r) => layer([whoosh(r, 2.2, 400, 450, { q: 0.9, peak: 0.5, grit: 1.5 }), 1], [whoosh(r, 2.2, 900, 800, { q: 1.5, peak: 0.5, grit: 2 }), 0.7]),
    tick: (r) => zap(r, 0.18, 380, { chaos: 0.8, hiss: 1, gain: 0.7 }),
  },
  'zeus.skyfall-storm': {
    cast: (r) => layer([rumble(r, 1.5, { tone: 200, attack: 0.5 }), 1], [whoosh(r, 1.5, 200, 1500, { q: 0.6, peak: 0.9 }), 0.6], [zap(r, 1, 70, { chaos: 0.3, fall: 2 }), 0.4]),
    zone: (r) => layer([rumble(r, 2.5, { tone: 250 }), 0.8], [filter(sand(r, 2.5, { tone: 1500, peak: 0.5, grains: 300 }), 'lowpass', 3000), 0.5]),
    tick: (r) => boom(r, 1.4, 1.6, 0.7),
  },
  'zeus.olympian-spear': {
    cast: (r) => layer([zap(r, 0.7, 60, { chaos: 0.2, fall: 8, hiss: 1.2 }), 0.7], [boom(r, 2.4, 1.8, 1.2), 1, 0.35], [whoosh(r, 0.7, 6000, 300, { q: 0.7 }), 0.8, 0.3]),
    impact: (r) => zap(r, 0.3, 520, { chaos: 1, hiss: 1.4 }),
    impactDelay: 0.4,
  },
  'zeus.ascension': {
    cast: (r) => layer([whoosh(r, 1.4, 200, 6000, { q: 0.7, peak: 0.85, gain: 1.4 }), 1], [choir(r, 2, 293.7, { env: (t) => ahr(t, 0.6, 0.6, 0.8) }), 0.5], [zap(r, 1.2, 80, { chaos: 0.4, fall: 4 }), 0.4]),
    zone: (r) => layer([rumble(r, 3, { tone: 220 }), 0.7], [hum(r, 3, 160, 1.5), 0.6]),
    tick: (r) => bolt(r, 0.5, 0.9),
  },

  // ===== Thor: steel, weight, thunder
  'thor.hammer-throw': {
    cast: (r) => layer([swing(r, 0.4, 250, 900), 1], [zap(r, 0.25, 160, { hiss: 0.5, gain: 0.5 }), 1, 0.1]),
    travel: (r) => {
      // the hammer spinning end over end: pulsing low whoosh
      const w = whoosh(r, 1, 350, 350, { q: 0.9, peak: 0.5, grit: 0.5 });
      return shape(w, (t) => 0.4 + 0.6 * Math.abs(Math.sin(t * Math.PI * 9)));
    },
    impact: (r) => layer([metal(r, 520, 0.7), 0.7], [thump(r, 0.4, 130, 45, { click: 0.8, drive: 3 }), 1]),
  },
  'thor.tempest-leap': {
    cast: (r) => layer([whoosh(r, 0.6, 200, 1500, { q: 0.8, peak: 0.6, gain: 1.4 }), 1], [vowel(r, 0.4, (t) => glide(160, 130, t, 0.4), VOWELS.ah, { breath: 0.3, gain: 0.5 }), 0.5]),
    impact: (r) => layer([boom(r, 1.6, 1.2, 1), 1], [debris(r, 0.9, { density: 25, gain: 0.5 }), 0.8]),
  },
  'thor.mjolnir-slam': {
    cast: (r) => layer([swing(r, 0.32, 300, 700), 0.8], [thump(r, 0.8, 80, 28, { click: 1, noise: 1, drive: 3 }), 1, 0.2], [metal(r, 330, 1), 0.5, 0.2], [thunder(r, 1.2, { crack: 1, rumble: 0.7 }), 0.7, 0.2]),
  },
  'thor.berserker-spin': {
    cast: (r) => {
      const spin = whoosh(r, 1.2, 350, 900, { q: 1, peak: 0.5, gain: 1.4 });
      return layer([shape(spin, (t) => 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 2.6))), 1], [vowel(r, 0.6, (t) => glide(150, 190, t, 0.6), VOWELS.ah, { breath: 0.3, gain: 0.4 }), 0.5]);
    },
    impact: (r) => layer([metal(r, 600, 0.4), 0.6], [thump(r, 0.25, 140, 55, { click: 0.6 }), 0.8]),
  },
  'thor.lightning-dash': {
    cast: (r) => layer([whoosh(r, 0.45, 300, 2500, { q: 0.8, gain: 1.4 }), 1], [zap(r, 0.4, 140, { chaos: 0.8, hiss: 1 }), 0.7], [thunder(r, 0.8, { crack: 1, rumble: 0.4 }), 0.6]),
    impact: (r) => layer([thump(r, 0.35, 120, 45, { click: 0.9, drive: 3 }), 1], [zap(r, 0.2, 400), 0.5]),
  },
  'thor.thunder-guard': {
    cast: (r) => layer([metal(r, 260, 1.4), 0.7], [hum(r, 1.4, 120, 1.2), 0.7], [thump(r, 0.4, 100, 50, { drive: 2 }), 0.6]),
  },
  'thor.call-of-asgard': {
    cast: (r) => layer([vowel(r, 1, (t) => glide(130, 170, t, 0.4), VOWELS.ah, { voices: 3, detune: 0.03, breath: 0.25, growl: 0.05, gain: 0.8 }), 1], [thunder(r, 1.4, { crack: 0.5, rumble: 1 }), 0.6, 0.15], [warHorn(r, 1.2, 110), 0.4]),
  },
  'thor.storm-chain': {
    cast: (r) => layer([zap(r, 0.3, 240, { chaos: 0.8, hiss: 1 }), 1], [metal(r, 1400, 0.3), 0.3]),
    travel: (r) => layer([hum(r, 0.8, 240, 1.4), 1], [shape(debris(r, 0.8, { density: 50, gain: 0.4, tone: 3000 }), () => 1), 0.4]),
    impact: (r) => layer([metal(r, 900, 0.6), 0.6], [zap(r, 0.4, 330, { chaos: 0.9, hiss: 1.2 }), 0.8], [thump(r, 0.3, 120, 50), 0.6]),
  },
  'thor.anvil-of-dawn': {
    cast: (r) => layer([whoosh(r, 1, 150, 4000, { q: 0.7, peak: 0.7, gain: 1.4 }), 1], [vowel(r, 0.8, (t) => glide(140, 200, t, 0.8), VOWELS.ah, { voices: 3, breath: 0.3, gain: 0.6 }), 0.5]),
    impact: (r) => layer([boom(r, 2.6, 2, 1.4), 1], [metal(r, 220, 2), 0.5], [debris(r, 1.8, { density: 35, gain: 0.6 }), 0.9, 0.05]),
  },
  'thor.worldbreaker': {
    cast: (r) => layer([swing(r, 0.4, 200, 600), 0.7], [thump(r, 1.2, 60, 22, { click: 1, noise: 1, drive: 3 }), 1, 0.25], [rumble(r, 2.4, { tone: 170 }), 0.9, 0.25], [debris(r, 2, { density: 40, gain: 0.6, tone: 700 }), 1, 0.3]),
  },
  'thor.thunder-god': {
    cast: (r) => layer([boom(r, 2.6, 2, 1.5), 1], [vowel(r, 1.4, (t) => glide(120, 160, t, 1), VOWELS.ah, { voices: 4, detune: 0.03, breath: 0.25, growl: 0.06, gain: 0.7 }), 0.6], [hum(r, 2, 110, 2), 0.5]),
  },

  // ===== Odin: spear, ravens, runes, horns
  'odin.spear-thrust': {
    cast: (r) => layer([whoosh(r, 0.26, 600, 2400, { q: 2, peak: 0.6, gain: 1.4 }), 1], [metal(r, 1100, 0.4), 0.3, 0.12]),
    impact: (r) => layer([thump(r, 0.25, 160, 60, { click: 0.9 }), 1], [metal(r, 1500, 0.3), 0.35]),
    impactDelay: 0.1,
  },
  'odin.ravens': {
    cast: (r) => layer([ravens(r, 0.9, 3), 1], [whoosh(r, 0.6, 500, 1500, { q: 0.6, grit: 2 }), 0.6]),
    travel: (r) => {
      // wingbeats
      const w = whoosh(r, 1, 500, 500, { q: 0.6, peak: 0.5 });
      return layer([shape(w, (t) => Math.max(0, Math.sin(t * Math.PI * 12)) ** 2), 1], [ravens(r, 1, 1), 0.3]);
    },
    impact: (r) => layer([ravens(r, 0.5, 2), 0.7], [thump(r, 0.2, 200, 80, { click: 0.6, noise: 0.6 }), 0.8]),
  },
  'odin.war-cry': {
    cast: (r) => layer([vowel(r, 1.1, (t) => glide(110, 150, t, 0.5), VOWELS.ah, { voices: 4, detune: 0.03, breath: 0.25, growl: 0.06, gain: 0.9 }), 1], [warHorn(r, 1.4, 146.8), 0.5], [thump(r, 0.5, 70, 30, { drive: 2 }), 0.5]),
  },
  'odin.lunge': {
    cast: (r) => layer([whoosh(r, 0.4, 400, 2200, { q: 1.4, gain: 1.4 }), 1], [vowel(r, 0.3, (t) => glide(150, 120, t, 0.3), VOWELS.ah, { breath: 0.4, gain: 0.4 }), 0.5]),
    impact: (r) => layer([thump(r, 0.3, 150, 50, { click: 0.9, drive: 2.5 }), 1], [metal(r, 1250, 0.4), 0.35]),
  },
  'odin.gungnir-sweep': {
    cast: (r) => layer([whoosh(r, 0.5, 300, 1500, { q: 1.1, peak: 0.55, gain: 1.6 }), 1], [runes(r, 0.8, 220, 1.3), 0.4]),
    impact: (r) => layer([thump(r, 0.4, 120, 45, { click: 0.8, drive: 3 }), 1], [whoosh(r, 0.3, 1500, 500, { q: 0.8 }), 0.6]),
    impactDelay: 0.15,
  },
  'odin.wisdom': {
    cast: (r) => layer([runes(r, 1.6, 293.7, 1.5), 1], [waterPour(r, 1.2), 0.5]),
  },
  'odin.rune-ward': {
    cast: (r) => layer([runes(r, 1.6, 220, 1.2), 1], [metal(r, 440, 1.4), 0.4], [thump(r, 0.4, 90, 45, { drive: 1.5 }), 0.5]),
  },
  'odin.einherjar': {
    cast: (r) => layer([warHorn(r, 1.6, 98), 0.8], [choir(r, 1.8, 196, { vowelName: 'oh', env: (t) => ahr(t, 0.5, 0.6, 0.7) }), 0.6], [thump(r, 0.6, 80, 30, { drive: 2 }), 0.7, 0.4], [metal(r, 700, 0.5), 0.3, 0.45]),
    zone: (r) => layer([filter(debris(r, 2, { density: 18, gain: 0.5, tone: 1600 }), 'lowpass', 4000), 1], [choir(r, 2, 196, { vowelName: 'oh', env: () => 1, gain: 0.3 }), 0.4]),
    tick: (r) => layer([metal(r, 900 + r() * 400, 0.3), 0.6], [whoosh(r, 0.2, 700, 1800, { q: 1.4 }), 0.6]),
  },
  'odin.ring-of-spears': {
    cast: (r) => {
      // spears hammer into the ground all around, one after another
      const parts: [Float32Array, number, number][] = [];
      for (let k = 0; k < 8; k++) parts.push([layer([thump(r, 0.3, 140, 60, { click: 1 }), 1], [metal(r, 900 + k * 60, 0.3), 0.3]), 0.7, 0.15 + k * 0.06]);
      return layer([warHorn(r, 1.2, 110), 0.5], [runes(r, 1.4, 146.8, 1.2), 0.4], ...parts);
    },
    zone: (r) => runes(r, 2.5, 146.8, 1),
    tick: (r) => metal(r, 1200, 0.4),
  },
  'odin.valhallas-call': {
    cast: (r) => layer([warHorn(r, 2.4, 73.4), 1], [warHorn(r, 2.2, 110), 0.5, 0.25], [choir(r, 2.6, 293.7, { env: (t) => ahr(t, 0.8, 0.8, 1) }), 0.6], [boom(r, 1.8, 0.4, 1), 0.5]),
  },
  'odin.all-seeing-eye': {
    cast: (r) => layer([runes(r, 2.4, 110, 2), 1], [gong(r, 2.4, 82.4), 0.6], [whoosh(r, 2, 200, 3000, { q: 0.6, peak: 0.8 }), 0.4]),
  },

  // ===== Loki: steel, smoke, venom, tricks
  'loki.dagger-fan': {
    cast: (r) => layer([dagger(r, 0.18), 1], [dagger(r, 0.18), 0.8, 0.03], [dagger(r, 0.18), 0.8, 0.06], [dagger(r, 0.18), 0.7, 0.09], [dagger(r, 0.18), 0.7, 0.12]),
    impact: (r) => layer([thump(r, 0.15, 220, 90, { click: 0.6, noise: 0.5 }), 1, 0.12], [thump(r, 0.15, 200, 80, { click: 0.6, noise: 0.5 }), 0.8, 0.18], [metal(r, 2800, 0.15), 0.25, 0.12]),
    impactDelay: 0.1,
  },
  'loki.vanish': { cast: (r) => layer([smoke(r, 0.8), 1], [sly(r, 0.6), 0.7]) },
  'loki.decoy': {
    cast: (r) => layer([smoke(r, 0.6), 0.8], [laugh(r), 0.6, 0.1]),
    impact: (r) => layer([boom(r, 1.2, 0.6, 0.6), 1], [smoke(r, 0.8), 0.8]),
    impactDelay: 2,
  },
  'loki.poison-blade': {
    cast: (r) => layer([metal(r, 1800, 0.6), 0.5], [whoosh(r, 0.3, 1800, 3800, { q: 2 }), 0.7], [venom(r, 0.8), 0.8]),
  },
  'loki.backstab': {
    cast: (r) => layer([sly(r, 0.3), 1], [whoosh(r, 0.2, 5000, 1000, { q: 0.8 }), 0.6]),
    travel: (r) => filter(whoosh(r, 0.8, 1800, 1800, { q: 1.5, peak: 0.5 }), 'highpass', 800),
    impact: (r) => layer([thump(r, 0.3, 150, 55, { click: 1, noise: 0.6, drive: 2.5 }), 1], [metal(r, 2200, 0.5), 0.5], [whoosh(r, 0.15, 2000, 4500, { q: 2 }), 0.7]),
  },
  'loki.tricksters-mark': {
    cast: (r) => layer([dagger(r, 0.2), 1], [sly(r, 0.4), 0.5]),
    travel: (r) => whoosh(r, 0.8, 2600, 2600, { q: 3, peak: 0.5 }),
    impact: (r) => layer([thump(r, 0.2, 200, 80, { click: 0.7 }), 1], [chime(r, 0.8, 1108.7), 0.4], [laugh(r), 0.3, 0.05]),
  },
  'loki.smoke-bomb': {
    cast: (r) => layer([whoosh(r, 0.4, 800, 1600, { q: 1 }), 0.7], [twang(r, 0.3, 300, 0.4), 0.3]),
    impact: (r) => layer([thump(r, 0.6, 110, 40, { click: 0.6, noise: 0.8, drive: 2 }), 1], [smoke(r, 1.4), 1], [crackleHiss(r, 1.2), 0.4]),
    impactDelay: 0.35,
  },
  'loki.shapeshift': {
    cast: (r) => layer([smoke(r, 0.6), 0.8], [vowel(r, 0.45, (t) => glide(700, 1100, t, 0.45), VOWELS.eh, { breath: 0.4, gain: 0.5, env: (t) => perc(t, 0.02, 0.4) }), 0.6, 0.15], [sly(r, 0.5), 0.5]),
  },
  'loki.assassinate': {
    cast: (r) => layer([sly(r, 0.5), 1], [smoke(r, 0.6), 0.7], [vowel(r, 0.8, () => 82.4, VOWELS.oo, { voices: 3, detune: 0.04, breath: 0.4, gain: 0.5 }), 0.5]),
    travel: (r) => filter(whoosh(r, 0.8, 900, 900, { q: 1, peak: 0.5, grit: 1 }), 'lowpass', 2000),
    impact: (r) => layer([thump(r, 0.6, 110, 35, { click: 1, noise: 1, drive: 3 }), 1], [metal(r, 1700, 0.9), 0.6], [whoosh(r, 0.2, 2500, 5000, { q: 1.5 }), 0.7], [darkHit(r, 1.4), 0.6]),
  },
  'loki.mirror-legion': {
    cast: (r) => layer([smoke(r, 0.8), 0.7], [smoke(r, 0.8), 0.6, 0.12], [smoke(r, 0.8), 0.6, 0.24], [laugh(r), 0.6, 0.15], [sly(r, 0.8), 0.4]),
    tick: (r) => dagger(r, 0.14),
  },
  'loki.ragnarok-rift': {
    cast: (r) => layer([sly(r, 0.9), 0.6], [rumble(r, 1.6, { tone: 160, attack: 0.4 }), 1], [fire(r, 1.6, { gain: 0.6, roar: 2 }), 1, 0.4], [darkHit(r, 1.8), 0.6, 0.4]),
    zone: (r) => layer([fire(r, 2.5, { gain: 0.7, roar: 2 }), 1], [vowel(r, 2.5, (t) => 73.4 * (1 + Math.sin(t * 1.5) * 0.03), VOWELS.oo, { voices: 3, breath: 0.3, env: () => 1, gain: 0.3 }), 0.6]),
    tick: (r) => layer([fire(r, 0.4, { gain: 0.6 }), 1], [thump(r, 0.3, 110, 45, { noise: 0.6 }), 0.6]),
  },

  // ===== Anubis: sand, locusts, wraps, the dead
  'anubis.soul-shield': {
    cast: (r) => layer([wail(r, 1.2, 330), 0.6], [shimmer(r, 1.2, 440, { rise: 1.3, peak: 0.4 }), 0.7], [gong(r, 1.4, 164.8), 0.4]),
  },
  'anubis.locust-swarm': {
    cast: (r) => layer([buzz(r, 1.8, 190, { voices: 14, env: (t) => ahr(t, 0.12, 1, 0.6) }), 1], [sand(r, 0.8, { tone: 2600 }), 0.4]),
    impact: (r) => buzz(r, 0.6, 230, { voices: 8, env: (t) => perc(t, 0.02, 0.6), gain: 0.6 }),
    impactDelay: 0.25,
  },
  'anubis.mummify': {
    cast: (r) => layer([cloth(r, 0.5), 1], [wail(r, 0.7, 220), 0.4]),
    impact: (r) => layer([thump(r, 0.3, 140, 60, { click: 0.4, noise: 0.6 }), 1], [cloth(r, 0.3), 0.6], [gong(r, 1, 196), 0.35]),
    impactDelay: 0.15,
  },
  'anubis.scales-of-maat': {
    cast: (r) => layer([gong(r, 1.8, 130.8), 0.8], [chime(r, 1.4, 523.3), 0.5, 0.2], [sand(r, 1.2, { tone: 1800, peak: 0.6 }), 0.5]),
    impact: (r) => layer([fire(r, 0.8, { gain: 0.5 }), 0.6], [shimmer(r, 0.8, 660, { rise: 1.2, peak: 0.2 }), 0.6]),
    impactDelay: 0.3,
  },
  'anubis.grave-grasp': {
    cast: (r) => layer([wail(r, 0.6, 196), 0.6], [sand(r, 0.5, { tone: 1400, peak: 0.2 }), 0.7]),
    travel: (r) => layer([wail(r, 1, 165), 0.6], [sand(r, 1, { tone: 1400, peak: 0.5 }), 0.5]),
    impact: (r) => layer([thump(r, 0.35, 110, 45, { click: 0.6, noise: 0.6, drive: 2 }), 1], [cloth(r, 0.4), 0.6], [whoosh(r, 0.4, 2400, 400, { q: 0.8 }), 0.6, 0.05]),
  },
  'anubis.sand-step': {
    cast: (r) => layer([sand(r, 0.9, { tone: 2200, peak: 0.3, gain: 1.2 }), 1], [whoosh(r, 0.6, 400, 1800, { q: 0.8 }), 0.7]),
  },
  'anubis.jackal-howl': {
    cast: (r) =>
      layer(
        [vowel(r, 1.5, (t) => glide(300, 520, t, 0.5) * (t > 0.9 ? glide(1, 0.75, t - 0.9, 0.6) : 1), VOWELS.oo, { voices: 2, detune: 0.01, breath: 0.15, vibrato: 0.02, env: (t) => ahr(t, 0.15, 0.9, 0.45) }), 1],
        [vowel(r, 1.3, (t) => glide(450, 700, t, 0.5), VOWELS.oo, { breath: 0.1, vibrato: 0.025, env: (t) => ahr(t, 0.2, 0.7, 0.4) }), 0.4, 0.15],
      ),
  },
  'anubis.embalm': {
    cast: (r) => layer([cloth(r, 0.8), 0.7], [shimmer(r, 1.4, 392, { rise: 1.2, peak: 0.5 }), 0.7], [choir(r, 1.4, 196, { vowelName: 'oo', env: (t) => ahr(t, 0.4, 0.4, 0.6) }), 0.4]),
  },
  'anubis.death-gaze': {
    cast: (r) => layer([gong(r, 1.2, 98), 0.6], [wail(r, 1.2, 147), 0.6]),
    zone: (r) => layer([zap(r, 2, 73.4, { chaos: 0.1, fall: 1, hiss: 0.2 }), 0.5], [wail(r, 2, 110), 0.6], [sand(r, 2, { tone: 2600, peak: 0.5, grains: 1200 }), 0.6]),
    tick: (r) => layer([sand(r, 0.25, { tone: 3000, peak: 0.1 }), 1], [thump(r, 0.2, 130, 60), 0.6]),
  },
  'anubis.sandstorm': {
    cast: (r) => layer([whoosh(r, 1.6, 150, 1200, { q: 0.5, peak: 0.7, gain: 1.4 }), 1], [wail(r, 1.8, 110), 0.5], [gong(r, 2, 73.4), 0.4]),
    zone: (r) => layer([sand(r, 2.5, { tone: 1600, peak: 0.5, grains: 2000, gain: 1.4 }), 1], [whoosh(r, 2.5, 300, 320, { q: 0.5, peak: 0.5, grit: 2 }), 0.8]),
    tick: (r) => sand(r, 0.35, { tone: 2600, peak: 0.15 }),
  },
  'anubis.judgment': {
    cast: (r) => layer([gong(r, 3, 65.4), 1], [choir(r, 3, 196, { env: (t) => ahr(t, 0.8, 1, 1.2) }), 0.7], [choir(r, 3, 293.7, { vowelName: 'oh', env: (t) => ahr(t, 1, 0.8, 1.2) }), 0.4], [shimmer(r, 2.4, 587.3, { rise: 1.5, peak: 0.6 }), 0.5]),
  },
};

// ---------------------------------------------------------------------------
// Little extras used above

function ravens(r: Rand, len: number, count: number): Float32Array {
  const out = buf(len);
  for (let k = 0; k < count; k++) {
    const at = (k / Math.max(1, count)) * len * 0.7 + r() * 0.05;
    const f = 520 + r() * 160;
    const v = vowel(r, 0.22, (t) => glide(f, f * 0.8, t, 0.22), [[1150, 5, 1], [1750, 6, 0.6], [2800, 7, 0.3]], { breath: 0.45, growl: 0.18, voices: 2, detune: 0.03, env: (t) => ahr(t, 0.015, 0.07, 0.12) });
    const o = Math.round(at * 44100);
    for (let i = 0; i < v.length && o + i < out.length; i++) out[o + i]! += v[i]! * 0.7;
  }
  return out;
}

function laugh(r: Rand): Float32Array {
  // a short, breathy "heh-heh-heh"
  const out = buf(0.75);
  for (let k = 0; k < 3; k++) {
    const v = vowel(r, 0.14, (t) => glide(230 - k * 12, 190, t, 0.14), VOWELS.eh, { breath: 0.7, env: (t) => perc(t, 0.01, 0.12), gain: 0.8 });
    const o = Math.round(k * 0.16 * 44100);
    for (let i = 0; i < v.length && o + i < out.length; i++) out[o + i]! += v[i]!;
  }
  return out;
}

function darkHit(r: Rand, len: number): Float32Array {
  const out = buf(len);
  for (const f of [55, 58.3, 82.4]) {
    const o = new Osc(r());
    fill(out, (t) => o.saw(f) * perc(t, 0.01, len) * 0.3);
  }
  return filter(out, 'lowpass', 500, 0.9);
}

function waterPour(r: Rand, len: number): Float32Array {
  const out = buf(len);
  const count = Math.round(len * 40);
  for (let k = 0; k < count; k++) {
    const at = r() * len * 0.9;
    const f = 600 + r() * 1200;
    const d = 0.02 + r() * 0.04;
    const o = new Osc();
    fill(out, (t) => o.sine(f * (1 + t * 14)) * perc(t, 0.001, d) * 0.3, at, at + d * 1.5);
  }
  return out;
}

function crackleHiss(r: Rand, len: number): Float32Array {
  return filter(sand(r, len, { tone: 4000, peak: 0.2, grains: 500 }), 'highpass', 1500);
}

/** Generic fallbacks for a skill missing from the table (new skills added later). */
export function fallbackSkill(element: string | undefined, targeting: string): SkillSound {
  const cast: Recipe['make'] =
    element === 'lightning' ? (r) => bolt(r) : element === 'sand' ? (r) => sand(r, 0.6) : element === 'smoke' ? (r) => smoke(r) : element === 'runes' ? (r) => runes(r, 1, 220) : (r) => whoosh(r, 0.4, 400, 2000);
  return {
    cast,
    travel: targeting === 'projectile' ? (r) => shimmer(r, 1, 520, { rise: 1, peak: 0.5 }) : undefined,
    impact: (r) => thump(r, 0.4, 130, 45, { click: 0.7, drive: 2 }),
  };
}

