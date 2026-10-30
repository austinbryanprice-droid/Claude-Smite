/**
 * The game's sound bank: every non-skill sound, as a recipe built from the
 * gestures. Each recipe renders a few variants so repeated sounds (steps,
 * hits, swings) never sound like one sample on repeat.
 */

import { ahr, Biquad, buf, crackle, dcBlock, declick, fill, glide, loopable, normalize, Osc, perc, pink, RATE, seeded as rngFor, tail, wander, white, type Rand } from './dsp';
import {
  chime, chirp, choir, clang, debris, filter, fire, impact, knock, layer, puff, roar, rumble, sand, shape, shimmer, thump, thunder, twang, vowel, VOWELS, whoosh, zap,
} from './gestures';
import { CREATURE_SOUNDS } from './creatures';
import { VOICE_SOUNDS } from './voices';

export interface Recipe {
  make: (r: Rand, variant: number) => Float32Array;
  /** How many variants to render (default 1). */
  variants?: number;
  /** Rendered as a seamless loop. */
  loop?: boolean;
  /** Peak level after normalizing (default 0.9). */
  peak?: number;
}

const step = (r: Rand, tone: number, soft: number, weight: number): Float32Array => {
  // heel then toe: two close taps, a low body thud and a gritty scuff
  const scuff = filter(whoosh(r, 0.09 + soft * 0.06, tone * 1.3, tone * 0.7, { q: 0.7 }), 'highpass', 400);
  return layer(
    [knock(r, 0.05, tone * (0.9 + r() * 0.2)), 0.5 * (1 - soft)],
    [knock(r, 0.05, tone * 1.4), 0.3 * (1 - soft), 0.025 + r() * 0.02],
    [thump(r, 0.12, 120 * weight, 55, { click: 0.1, noise: 0.2 }), 0.55 * weight],
    [scuff, 0.4 + soft * 0.5],
  );
};

const hitFlesh = (r: Rand, weight: number): Float32Array =>
  layer([impact(r, weight, { tone: 140 + r() * 30, crunch: 0.6 }), 1], [filter(puff(r, 0.12, { tone: 1600 }), 'highpass', 300), 0.35]);

export const SOUNDS: Record<string, Recipe> = {
  // -- footsteps
  'step.stone': { variants: 6, peak: 0.5, make: (r) => step(r, 1700, 0.1, 1) },
  'step.grass': { variants: 6, peak: 0.45, make: (r) => step(r, 1000, 0.85, 0.8) },
  'step.dirt': { variants: 6, peak: 0.45, make: (r) => step(r, 1250, 0.5, 0.9) },
  'step.minion': { variants: 4, peak: 0.35, make: (r) => layer([step(r, 1300, 0.5, 0.6), 1], [clang(r, 0.12, 1900 + r() * 400, { decay: 0.08 }), 0.15]) },
  // the Wyrm's pit is strewn with its hoard; the Colossus stands on cooled lava and ash
  'step.coins': { variants: 4, peak: 0.45, make: (r) => layer([step(r, 1500, 0.2, 0.7), 1], [clang(r, 0.25, 2600 + r() * 1400, { decay: 0.12, gain: 0.35 }), 0.8, 0.01], [clang(r, 0.2, 3400 + r() * 1600, { decay: 0.08, gain: 0.25 }), 0.6, 0.04]) },
  'step.ash': { variants: 4, peak: 0.45, make: (r) => layer([step(r, 900, 0.6, 0.9), 1], [debris(r, 0.18, { density: 60, gain: 0.3, tone: 2200 }), 0.7]) },
  // landing from a leap, a jump or a knock-up: a thud and a little dust
  'land': { variants: 3, peak: 0.7, make: (r) => layer([thump(r, 0.35, 120, 45, { click: 0.3, noise: 0.5, drive: 1.6 }), 1], [debris(r, 0.35, { density: 18, gain: 0.3, tone: 900 }), 0.6, 0.02], [puff(r, 0.4, { tone: 700, gain: 0.5 }), 0.4]) },
  'step.heavy': { variants: 3, peak: 0.9, make: (r) => layer([thump(r, 0.6, 70, 28, { click: 0.3, noise: 0.6, drive: 2 }), 1], [debris(r, 0.5, { density: 10, gain: 0.4, tone: 500 }), 0.6]) },

  // -- god basic attacks (cast side)
  'basic.zeus': { variants: 3, make: (r) => layer([zap(r, 0.22, 340 + r() * 60, { chaos: 0.4, fall: 1.6 }), 0.8], [whoosh(r, 0.18, 2000, 5000, { q: 1 }), 0.5]) },
  'basic.thor': { variants: 3, make: (r) => layer([whoosh(r, 0.32, 300, 900, { q: 1.1, peak: 0.6, gain: 1.4 }), 1], [zap(r, 0.1, 220, { hiss: 0.3, gain: 0.3 }), 1, 0.15]) },
  'basic.odin': { variants: 3, make: (r) => whoosh(r, 0.26, 500, 1600, { q: 1.6, peak: 0.55, gain: 1.3 }) },
  'basic.loki': { variants: 3, make: (r) => layer([whoosh(r, 0.16, 1400, 3800, { q: 2, peak: 0.6 }), 1], [clang(r, 0.2, 3100, { decay: 0.12, gain: 0.2 }), 1]) },
  'basic.anubis': { variants: 3, make: (r) => layer([sand(r, 0.3, { tone: 2600, peak: 0.25 }), 1], [vowel(r, 0.25, (t) => glide(180, 120, t, 0.25), [[600, 5, 1], [1300, 6, 0.4]], { breath: 0.6, gain: 0.4 }), 1]) },
  'basic.minion.melee': { variants: 3, peak: 0.55, make: (r) => whoosh(r, 0.2, 700, 1900, { q: 1.6, peak: 0.6 }) },
  'basic.minion.archer': { variants: 3, peak: 0.55, make: (r) => layer([twang(r, 0.35, 180 + r() * 40), 0.8], [whoosh(r, 0.15, 2500, 1500, { q: 2 }), 0.4, 0.02]) },
  'basic.minion.brute': { variants: 2, peak: 0.75, make: (r) => whoosh(r, 0.42, 220, 600, { q: 1, peak: 0.7, gain: 1.4 }) },
  'basic.monster': { variants: 3, peak: 0.6, make: (r) => layer([whoosh(r, 0.22, 500, 1200, { q: 1 }), 1], [vowel(r, 0.25, (t) => glide(220, 150, t, 0.25), VOWELS.ah, { breath: 0.5, growl: 0.2, gain: 0.5 }), 1]) },
  'basic.warden': { variants: 2, peak: 0.85, make: (r) => layer([whoosh(r, 0.45, 160, 500, { q: 0.8, peak: 0.75, gain: 1.4 }), 1], [roar(r, 0.5, 90), 0.5]) },
  'basic.wyrm': { variants: 2, peak: 0.9, make: (r) => layer([roar(r, 0.7, 120, { open: 1.2 }), 0.8], [whoosh(r, 0.5, 200, 700, { q: 0.8, peak: 0.7, gain: 1.2 }), 1]) },
  'basic.colossus': { variants: 2, peak: 0.95, make: (r) => layer([thump(r, 0.9, 60, 25, { click: 0.4, noise: 0.8, drive: 2.5 }), 1, 0.35], [whoosh(r, 0.5, 120, 400, { q: 0.8, peak: 0.8, gain: 1.2 }), 0.8], [fire(r, 0.9, { gain: 0.4 }), 1, 0.3]) },

  // -- projectile loops in flight
  'travel.zeus': { loop: true, peak: 0.5, make: (r) => layer([zap(r, 1.2, 180, { chaos: 0.8, fall: 1, hiss: 0.8 }), 0.5], [shape(crackleBed(r, 1.2, 5000, 220), () => 1), 1]) },
  'travel.anubis': { loop: true, peak: 0.45, make: (r) => shape(sand(r, 1.2, { tone: 2200, peak: 0.5, grains: 1400 }), () => 1) },
  'travel.arrow': { loop: true, peak: 0.25, make: (r) => shape(whoosh(r, 0.8, 2200, 2200, { q: 3, peak: 0.5 }), () => 1) },
  'travel.tower': { loop: true, peak: 0.45, make: (r) => towerHum(r, 1) },
  'travel.magic': { loop: true, peak: 0.35, make: (r) => shimmer(r, 1.2, 520, { rise: 1, peak: 0.5 }) },

  // -- hits
  'hit.flesh': { variants: 4, peak: 0.8, make: (r) => hitFlesh(r, 1) },
  'hit.blade': { variants: 4, peak: 0.8, make: (r) => layer([hitFlesh(r, 0.85), 1], [clang(r, 0.35, 2400 + r() * 900, { decay: 0.2, gain: 0.35 }), 0.8], [whoosh(r, 0.08, 4000, 2000, { q: 1 }), 0.5]) },
  'hit.blunt': { variants: 4, peak: 0.9, make: (r) => layer([impact(r, 1.4, { tone: 115 + r() * 20, crunch: 0.5, sub: 1.2 }), 1], [clang(r, 0.35, 700 + r() * 200, { decay: 0.25, gain: 0.3, bright: 0.4 }), 0.7], [debris(r, 0.3, { density: 12, gain: 0.25, tone: 900 }), 0.5, 0.02]) },
  // Zeus's basic is a small bolt: the blow, the arc's sparks and a bark of thunder
  'hit.zap': { variants: 4, peak: 0.85, make: (r) => layer([impact(r, 0.9, { tone: 160, crunch: 0.4 }), 0.9], [zap(r, 0.18, 420 + r() * 200, { chaos: 0.8, hiss: 1 }), 0.7], [thunder(r, 0.3, { crack: 1.4, rumble: 0.15 }), 0.55]) },
  'hit.sand': { variants: 3, peak: 0.8, make: (r) => layer([impact(r, 0.9, { tone: 135, crunch: 0.3, snap: 0.6 }), 1], [sand(r, 0.3, { tone: 3000, peak: 0.1 }), 0.8]) },
  'hit.structure': { variants: 4, peak: 0.75, make: (r) => layer([impact(r, 1.1, { tone: 95, crunch: 0.9, sub: 0.8 }), 0.8], [knock(r, 0.2, 500 + r() * 300), 1], [knock(r, 0.12, 1400), 0.5, 0.01], [debris(r, 0.4, { density: 15, gain: 0.25, tone: 1300 }), 1]) },
  'hit.crit': { variants: 2, peak: 0.85, make: (r) => layer([impact(r, 1.7, { tone: 120, crunch: 1, sub: 1.3, room: 0.25 }), 1], [clang(r, 0.6, 1500, { decay: 0.4, gain: 0.6 }), 0.6], [whoosh(r, 0.15, 6000, 3000, { q: 0.8 }), 0.5]) },
  'hit.monster': { variants: 3, peak: 0.8, make: (r) => layer([hitFlesh(r, 1.2), 1], [vowel(r, 0.2, (t) => glide(300, 200, t, 0.2), VOWELS.eh, { breath: 0.5, growl: 0.2, gain: 0.3 }), 1]) },
  // your skill connecting with an enemy god: a tight, bright thwack that cuts through a fight
  'hit.confirm': { variants: 3, peak: 0.7, make: (r) => layer([impact(r, 0.7, { tone: 190 + r() * 20, crunch: 0.8, snap: 1.4, sub: 0.6, room: 0.1 }), 1], [knock(r, 0.05, 2900 + r() * 300), 0.4]) },

  // -- minions
  'minion.death': { variants: 4, peak: 0.6, make: (r) => layer([vowel(r, 0.32, (t) => glide(190 + r() * 40, 110, t, 0.3), VOWELS.oh, { breath: 0.3, gain: 0.7, env: (t) => perc(t, 0.01, 0.3) }), 0.8], [debris(r, 0.5, { density: 12, gain: 0.5, tone: 1900 }), 1, 0.12], [thump(r, 0.2, 110, 50), 0.5, 0.25]) },
  'wave.horn': { peak: 0.8, make: (r) => horn(r, 2.6, [146.8, 220]) },

  // -- structures
  'tower.shot': { variants: 2, peak: 0.85, make: (r) => towerShot(r) },
  'tower.hit': { variants: 3, peak: 0.9, make: (r) => layer([impact(r, 1.6, { tone: 105, crunch: 0.6, sub: 1.3, room: 0.25 }), 1], [zap(r, 0.25, 420, { chaos: 0.6, hiss: 1, gain: 0.5 }), 1], [filter(whoosh(r, 0.4, 3000, 600, { q: 0.6 }), 'highpass', 500), 0.5]) },
  'titan.slam': { peak: 0.95, make: (r) => layer([thump(r, 1.4, 55, 22, { click: 0.6, noise: 1, drive: 3 }), 1], [rumble(r, 2.2, { tone: 120 }), 0.8], [debris(r, 1.6, { density: 30, gain: 0.5, tone: 700 }), 1, 0.05]) },
  'titan.windup': { peak: 0.8, make: (r) => layer([roar(r, 1.2, 55, { open: 0.7 }), 1], [rumble(r, 1.2, { tone: 90, attack: 0.6 }), 0.8]) },
  'structure.collapse': { peak: 0.95, make: (r) => layer([thump(r, 1.2, 60, 25, { click: 0.4, noise: 1, drive: 2.5 }), 1], [rumble(r, 4, { tone: 180 }), 1], [debris(r, 3.6, { density: 45, gain: 0.7, tone: 800 }), 1, 0.1], [clang(r, 2.5, 180, { decay: 1.8, gain: 0.25, bright: 0.4 }), 1, 0.05]) },
  'phoenix.collapse': { peak: 0.95, make: (r) => layer([roarBird(r, 1.6), 0.8], [fire(r, 3, { gain: 0.7, roar: 2 }), 1, 0.2], [rumble(r, 3.5, { tone: 200 }), 0.9, 0.3], [debris(r, 3, { density: 35, gain: 0.6 }), 1, 0.4]) },
  'phoenix.rise': { peak: 0.85, make: (r) => layer([roarBird(r, 1.4), 0.7], [fire(r, 2.2, { gain: 0.6, roar: 2 }), 1], [shimmer(r, 2, 330, { rise: 2, peak: 0.6 }), 0.8]) },

  // -- jungle
  'monster.death': { variants: 3, peak: 0.7, make: (r) => layer([vowel(r, 0.7, (t) => glide(260, 90, t, 0.7), VOWELS.oh, { breath: 0.5, growl: 0.25, gain: 0.8, env: (t) => perc(t, 0.02, 0.7) }), 1], [thump(r, 0.4, 90, 40, { noise: 0.6 }), 0.8, 0.3]) },
  'monster.aggro': { variants: 3, peak: 0.6, make: (r) => vowel(r, 0.5, (t) => glide(320 + r() * 80, 200, t, 0.5), VOWELS.eh, { breath: 0.6, growl: 0.35, voices: 2, detune: 0.05, env: (t) => ahr(t, 0.03, 0.15, 0.3) }) },
  'warden.slam': { variants: 2, peak: 0.9, make: (r) => layer([thump(r, 0.8, 70, 28, { click: 0.5, noise: 0.8, drive: 2.5 }), 1], [debris(r, 0.8, { density: 25, gain: 0.5 }), 1, 0.03]) },
  'wyrm.roar': { peak: 0.9, make: (r) => layer([roar(r, 2.2, 95, { open: 1.2 }), 1], [roar(r, 2, 140, { open: 1.4 }), 0.5, 0.1], [sand(r, 1.6, { tone: 1800, gain: 0.25 }), 1, 0.3]) },
  'wyrm.sweep': { peak: 0.95, make: (r) => layer([whoosh(r, 0.9, 150, 600, { q: 0.7, peak: 0.6, gain: 1.6 }), 1], [thump(r, 0.9, 65, 25, { click: 0.5, noise: 0.9, drive: 2.5 }), 1, 0.45], [debris(r, 1, { density: 30, gain: 0.5 }), 1, 0.5]) },
  'colossus.roar': { peak: 0.95, make: (r) => layer([roar(r, 2.6, 60, { open: 0.8 }), 1], [fire(r, 2.6, { gain: 0.5, roar: 2.5 }), 1], [rumble(r, 2.6, { tone: 100 }), 0.8]) },
  'colossus.stomp': { peak: 1, make: (r) => layer([thump(r, 1.6, 50, 20, { click: 0.6, noise: 1, drive: 3 }), 1], [fire(r, 1.8, { gain: 0.7, roar: 2.5 }), 1, 0.05], [rumble(r, 2.6, { tone: 140 }), 0.9], [debris(r, 2, { density: 35, gain: 0.6, tone: 600 }), 1, 0.1]) },
  'boss.windup': { variants: 2, peak: 0.8, make: (r) => layer([roar(r, 1, 75, { open: 0.9 }), 1], [rumble(r, 1, { tone: 110, attack: 0.5 }), 0.7]) },

  // -- gods
  'god.death': { variants: 2, peak: 0.85, make: (r) => layer([thump(r, 0.5, 90, 40, { noise: 0.7, drive: 2 }), 1, 0.2], [darkChord(r, 2.4), 0.8], [whoosh(r, 0.6, 1500, 200, { q: 0.8 }), 0.6]) },
  'god.respawn': { peak: 0.75, make: (r) => layer([shimmer(r, 1.6, 392, { rise: 2, peak: 0.6 }), 1], [choir(r, 1.8, 392, { env: (t) => ahr(t, 0.4, 0.6, 0.8) }), 0.5], [whoosh(r, 1.2, 300, 3000, { q: 0.8, peak: 0.8 }), 0.4]) },
  'god.levelup': { peak: 0.7, make: (r) => levelUp(r) },
  'god.ultready': { peak: 0.7, make: (r) => layer([levelUp(r), 0.7], [choir(r, 2, 293.7, { env: (t) => ahr(t, 0.3, 0.8, 0.9) }), 0.6]) },
  'recall.loop': { loop: true, peak: 0.45, make: (r) => layer([shimmer(r, 2, 660, { rise: 1, peak: 0.5, voices: 6 }), 1], [choir(r, 2, 330, { vowelName: 'oo', env: () => 1 }), 0.4]) },
  'recall.done': { peak: 0.8, make: (r) => layer([whoosh(r, 0.9, 400, 5000, { q: 0.8, peak: 0.75, gain: 1.2 }), 1], [shimmer(r, 1.2, 880, { rise: 1.5, peak: 0.2 }), 0.8]) },
  'teleport': { peak: 0.7, make: (r) => layer([whoosh(r, 0.4, 3000, 400, { q: 1 }), 1], [shimmer(r, 0.5, 1200, { rise: 0.5, peak: 0.1 }), 0.6]) },
  'heal': { variants: 2, peak: 0.45, make: (r) => layer([shimmer(r, 0.8, 784, { rise: 1.25, peak: 0.25 }), 1], [chime(r, 0.8, 1568, { gain: 0.5 }), 0.6]) },
  'favor': { variants: 3, peak: 0.4, make: (r) => coin(r) },
  'kill.confirm': { peak: 0.8, make: (r) => layer([clang(r, 1.4, 523, { decay: 1, gain: 0.7 }), 1], [thump(r, 0.4, 100, 40, { drive: 2 }), 0.8], [chime(r, 1.2, 1046.5), 0.5, 0.05]) },

  // -- herald stings and player feedback
  'sting.good': { peak: 0.75, make: (r) => layer([horn(r, 1.6, [146.8, 185, 220, 293.7]), 1], [thump(r, 0.9, 70, 30, { click: 0.3, drive: 2 }), 0.8]) },
  'sting.bad': { peak: 0.75, make: (r) => layer([horn(r, 1.8, [73.4, 87.3, 110]), 1], [thump(r, 1.1, 55, 25, { click: 0.2, drive: 2 }), 0.9], [darkChord(r, 1.8), 0.5]) },
  'sting.neutral': { peak: 0.6, make: (r) => layer([clang(r, 2.2, 220, { decay: 1.8, bright: 0.5, gain: 0.7 }), 1], [thump(r, 0.6, 90, 40, { click: 0.2 }), 0.6]) },
  'sting.epic': { peak: 0.85, make: (r) => layer([horn(r, 2.4, [73.4, 110, 146.8, 220]), 1], [thump(r, 1.4, 50, 22, { click: 0.4, noise: 0.6, drive: 2.5 }), 1], [clang(r, 2.6, 110, { decay: 2.2, bright: 0.4, gain: 0.6 }), 0.7]) },
  'heartbeat': { loop: true, peak: 0.7, make: (r) => heartbeat(r) },

  // -- UI (played flat, not positioned)
  // a few slightly different takes, so clicking around a menu doesn't sound like a metronome
  'ui.hover': { variants: 3, peak: 0.18, make: (r) => { const k = 0.94 + r() * 0.12; return layer([knock(r, 0.03, 3200 * k), 1], [sine(0.04, 2400 * k, 0.3), 1]); } },
  'ui.click': { variants: 3, peak: 0.38, make: (r) => { const k = 0.95 + r() * 0.1; return layer([knock(r, 0.04, 2600 * k), 1], [sine(0.07, 1320 * k, 0.6), 1], [knock(r, 0.05, 900 * k), 0.6]); } },
  'ui.select': { peak: 0.45, make: (r) => layer([chime(r, 0.4, 1046.5), 1], [chime(r, 0.4, 1568, { at: 0.05 }), 0.6], [knock(r, 0.04, 2600), 0.6]) },
  'ui.play': { peak: 0.8, make: (r) => layer([horn(r, 1.8, [146.8, 220, 293.7]), 1], [thump(r, 0.8, 80, 35, { click: 0.4, drive: 2 }), 0.9], [whoosh(r, 1.2, 200, 4000, { q: 0.8, peak: 0.6 }), 0.4]) },
  'ui.open': { peak: 0.45, make: (r) => layer([whoosh(r, 0.25, 600, 2400, { q: 1 }), 0.8], [chime(r, 0.5, 880), 0.5, 0.06]) },
  'ui.close': { peak: 0.4, make: (r) => whoosh(r, 0.22, 2200, 600, { q: 1 }) },
  'ui.deny': { peak: 0.45, make: () => layer([sine(0.12, 220, 1), 1], [sine(0.14, 165, 1), 1, 0.09]) },
  'ui.point': { peak: 0.5, make: (r) => layer([chime(r, 0.6, 1318.5), 1], [chime(r, 0.6, 1975.5, { at: 0.04 }), 0.5]) },
  'ui.toast': { peak: 0.3, make: (r) => chime(r, 0.4, 987.8) },

  // -- ambience
  'amb.wind': { loop: true, peak: 0.5, make: (r) => windBed(r, 12) },
  'amb.leaves': { loop: true, peak: 0.4, make: (r) => leavesBed(r, 9) },
  'amb.bird': { variants: 8, peak: 0.35, make: (r, v) => tail(chirp(r, v), 0.7, 0.3) },
  'amb.crow': { variants: 2, peak: 0.35, make: (r) => tail(crow(r), 0.9, 0.35) },
  'amb.fountain': { loop: true, peak: 0.5, make: (r) => water(r, 6) },
  'amb.fire': { loop: true, peak: 0.45, make: (r) => fire(r, 5) },
  'amb.jungle': { loop: true, peak: 0.3, make: (r) => insects(r, 8) },

  // -- the gods' own voices (voices.ts)
  ...VOICE_SOUNDS,

  // -- camps, bosses and minion waves (creatures.ts)
  ...CREATURE_SOUNDS,
};

// ---------------------------------------------------------------------------
// Helpers for the recipes above

function sine(len: number, f: number, g: number): Float32Array {
  const out = buf(len);
  const o = new Osc();
  fill(out, (t) => o.sine(f) * perc(t, 0.002, len) * g);
  return out;
}

function crackleBed(r: Rand, len: number, tone: number, density: number): Float32Array {
  const out = buf(len);
  crackle(out, r, density, () => 1, { tone, gain: 0.8, len: 0.003 });
  return out;
}

/** A brass horn call: stacked saws with a filter that opens as it swells. */
export function horn(r: Rand, len: number, notes: readonly number[]): Float32Array {
  const out = buf(len);
  for (const f of notes) {
    for (let k = 0; k < 3; k++) {
      const o = new Osc(r());
      const lp = new Biquad('lowpass', 400, 1.2);
      const d = 1 + (k - 1) * 0.004;
      const vib = r() * 6;
      fill(out, (t, i) => {
        const env = ahr(t, 0.25, len * 0.45, len * 0.4);
        if ((i & 31) === 0) lp.set(300 + env * 1700, 1.1);
        return lp.run(o.saw(f * d * (1 + Math.sin(t * 30 + vib) * 0.004 * Math.min(1, t)))) * env * 0.4;
      });
    }
  }
  return tail(out, 0.9, 0.3, 2500);
}

function towerHum(r: Rand, len: number): Float32Array {
  const out = buf(len);
  const o = new Osc();
  const o2 = new Osc(0.2);
  const m = new Osc();
  const n = white(r);
  const bp = new Biquad('bandpass', 1800, 2);
  fill(out, (t) => {
    const fm = m.sine(31) * 60;
    return o.sine(220 + fm) * 0.5 + o2.saw(110.5) * 0.15 + bp.run(n()) * 0.25 * (0.6 + 0.4 * Math.sin(t * 60));
  });
  return out;
}

function towerShot(r: Rand): Float32Array {
  const len = 0.7;
  const out = buf(len);
  const o = new Osc();
  const mod = new Osc();
  const lp = new Biquad('lowpass', 4000, 0.9);
  fill(out, (t) => {
    const f = glide(1400, 140, t, 0.35);
    const m = mod.sine(f * 1.5) * f * 2.5 * perc(t, 0.001, 0.3);
    return lp.run(o.sine(f + m)) * perc(t, 0.004, 0.5);
  });
  return layer([out, 0.8], [thump(r, 0.45, 160, 50, { click: 0.4, drive: 2.5 }), 0.8], [whoosh(r, 0.4, 3500, 900, { q: 0.8 }), 0.5]);
}

function roarBird(r: Rand, len: number): Float32Array {
  // a fiery bird cry: a bright, screeching vowel gliding down
  return vowel(r, len, (t) => glide(820, 420, t, len) * (1 + Math.sin(t * 40) * 0.03), [[1400, 6, 1], [2600, 7, 0.6], [3800, 8, 0.3]], {
    voices: 3,
    detune: 0.03,
    breath: 0.4,
    growl: 0.06,
    env: (t) => ahr(t, 0.05, len * 0.3, len * 0.6),
  });
}

function darkChord(r: Rand, len: number): Float32Array {
  const out = buf(len);
  for (const f of [73.4, 87.3, 110, 103.8]) {
    const o = new Osc(r());
    const o2 = new Osc(r());
    const lp = new Biquad('lowpass', 700, 0.8);
    fill(out, (t) => lp.run(o.saw(f) + o2.saw(f * 1.006)) * ahr(t, 0.06, 0.3, len - 0.4) * 0.25);
  }
  return tail(out, 0.9, 0.35, 2000);
}

function levelUp(r: Rand): Float32Array {
  const out = buf(1.6);
  const notes = [587.3, 740, 880, 1174.7];
  notes.forEach((f, k) => chime(r, 1.6 - k * 0.08, f, { at: k * 0.08, out, gain: 0.8 }));
  return layer([out, 1], [shimmer(r, 1.4, 1174.7, { rise: 1.2, peak: 0.3 }), 0.4, 0.2]);
}

function heartbeat(r: Rand): Float32Array {
  const out = buf(0.92);
  const lub = thump(r, 0.2, 70, 40, { click: 0.05, noise: 0.1, drive: 1.5 });
  const dub = thump(r, 0.18, 62, 38, { click: 0.05, noise: 0.1, drive: 1.5 });
  for (let i = 0; i < lub.length; i++) out[i]! += lub[i]!;
  const o = Math.round(0.24 * RATE);
  for (let i = 0; i < dub.length; i++) out[o + i]! += dub[i]! * 0.7;
  return filter(out, 'lowpass', 300);
}

function coin(r: Rand): Float32Array {
  const out = buf(0.5);
  const f = 1900 + r() * 200;
  chime(r, 0.4, f, { out, gain: 0.7 });
  chime(r, 0.45, f * 1.335, { out, at: 0.06, gain: 0.8 });
  return out;
}

function windBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const n = pink(r);
  const bp = new Biquad('bandpass', 500, 0.6);
  const lp = new Biquad('lowpass', 300, 0.6);
  const gust = wander(r, 0.18);
  const tone = wander(r, 0.35);
  for (let i = 0; i < out.length; i++) {
    const g = 0.45 + 0.55 * Math.max(0, gust());
    if ((i & 63) === 0) bp.set(350 + 500 * (0.5 + 0.5 * tone()) * g, 0.8);
    const x = n();
    out[i] = (bp.run(x) * 1.6 * g + lp.run(x) * 0.9) * (0.5 + 0.5 * g);
  }
  return loopable(out, 1);
}

function leavesBed(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  const n = white(r);
  const hp = new Biquad('highpass', 2500, 0.6);
  const lp = new Biquad('lowpass', 7000, 0.6);
  const gust = wander(r, 0.3);
  const flutter = wander(r, 14);
  for (let i = 0; i < out.length; i++) {
    const g = Math.max(0, gust()) ** 1.5;
    out[i] = lp.run(hp.run(n())) * g * (0.5 + 0.5 * Math.abs(flutter()));
  }
  crackle(out, r, 25, (t) => Math.max(0, Math.sin(t * 0.7)) ** 2, { tone: 4500, gain: 0.3, len: 0.003 });
  return loopable(out, 1);
}

function water(r: Rand, len: number): Float32Array {
  const out = buf(len + 0.5);
  const n = white(r);
  const bp = new Biquad('bandpass', 900, 0.5);
  const hp = new Biquad('highpass', 3000);
  for (let i = 0; i < out.length; i++) out[i] = bp.run(n()) * 0.5 + hp.run(n()) * 0.15;
  // bubbles: short rising sine chirps
  const count = Math.round(len * 55);
  for (let k = 0; k < count; k++) {
    const at = r() * len;
    const f = 400 + r() * 1400;
    const d = 0.02 + r() * 0.05;
    const o = new Osc();
    const g = 0.05 + r() * 0.15;
    fill(out, (t) => o.sine(f * (1 + t * 12)) * perc(t, 0.001, d) * g, at, at + d * 1.5);
  }
  return loopable(out, 0.5);
}

function insects(r: Rand, len: number): Float32Array {
  const out = buf(len + 1);
  // a few cicada-like trills that wax and wane
  for (let k = 0; k < 4; k++) {
    const o = new Osc();
    const am = new Osc(r());
    const f = 4200 + r() * 2400;
    const rate = 30 + r() * 40;
    const sw = wander(r, 0.2 + r() * 0.2);
    fill(out, () => o.sine(f) * Math.max(0, am.sine(rate)) ** 3 * Math.max(0, sw()) * 0.25);
  }
  return loopable(out, 1);
}

function crow(r: Rand): Float32Array {
  const out = buf(1.1);
  const calls = 2 + Math.floor(r() * 2);
  for (let k = 0; k < calls; k++) {
    const v = vowel(r, 0.28, (t) => glide(560, 470, t, 0.28), [[1100, 5, 1], [1700, 6, 0.6], [2700, 7, 0.3]], { breath: 0.4, growl: 0.15, voices: 2, detune: 0.03, env: (t) => ahr(t, 0.02, 0.1, 0.15) });
    const o = Math.round(k * 0.32 * RATE);
    for (let i = 0; i < v.length && o + i < out.length; i++) out[o + i]! += v[i]! * 0.6;
  }
  return out;
}

/** Renders a recipe's variants. */
export function renderRecipe(recipe: Recipe, seed: number): Float32Array[] {
  const out: Float32Array[] = [];
  const n = recipe.variants ?? 1;
  for (let v = 0; v < n; v++) {
    const r = rngFor(seed + v * 7919);
    let b = recipe.make(r, v);
    b = normalize(dcBlock(b), recipe.peak ?? 0.9);
    // loops get a crossfaded seam so they never click when they wrap
    b = recipe.loop ? loopable(b, 0.2) : declick(b, 0.5, 12);
    out.push(b);
  }
  return out;
}

