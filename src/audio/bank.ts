/**
 * Renders the whole sound bank in small slices between frames, so the game
 * keeps loading (and later keeps running) while thousands of seconds of DSP
 * happen. UI and menu sounds go first; skills and the battlefield follow.
 */

import { GODS } from '../game/gods';
import { paletteFor } from '../combat/palette';
import type { AudioEngine } from './AudioEngine';
import { hashSeed } from './dsp';
import { INSTRUMENTS } from './music';
import { fallbackSkill, SKILL_SOUNDS, type SkillSound } from './skillSounds';
import { renderRecipe, SOUNDS, type Recipe } from './sounds';

type Job = { name: string; recipe: Recipe };

const PARTS = ['cast', 'travel', 'impact', 'zone', 'tick'] as const;

export function skillSound(id: string): SkillSound {
  const known = SKILL_SOUNDS[id];
  if (known) return known;
  for (const g of GODS) {
    const s = g.skills.find((k) => k.id === id);
    if (s) return fallbackSkill(paletteFor(g.id).element, s.targeting.type);
  }
  return fallbackSkill(undefined, 'self');
}

/** The bank's name for one part of a skill's sound. */
export function skillPart(id: string, part: (typeof PARTS)[number]): string {
  return `skill:${id}:${part}`;
}

export function jobs(): Job[] {
  const first: Job[] = [];
  const rest: Job[] = [];
  for (const [name, recipe] of Object.entries(SOUNDS)) (name.startsWith('ui.') ? first : rest).push({ name, recipe });
  for (const [name, recipe] of Object.entries(INSTRUMENTS)) first.push({ name, recipe });
  for (const g of GODS) {
    for (const s of g.skills) {
      const ss = skillSound(s.id);
      for (const part of PARTS) {
        const make = ss[part];
        if (!make) continue;
        const loop = part === 'travel' || part === 'zone';
        rest.push({ name: skillPart(s.id, part), recipe: { make, loop, variants: part === 'tick' || part === 'impact' ? 2 : 1, peak: part === 'zone' ? 0.6 : part === 'travel' ? 0.5 : 0.9 } });
      }
    }
  }
  return [...first, ...rest];
}

/**
 * Render everything into the engine, on a worker thread when the browser
 * allows (no frame drops at all), otherwise in small slices on this thread.
 */
export function bakeAll(engine: AudioEngine): Promise<void> {
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 2) - 1));
  return Promise.all(Array.from({ length: n }, (_, k) => bakeInWorker(engine, k, n))).then(() => undefined).catch((err) => {
    console.warn('audio worker unavailable, rendering sounds on the main thread', err);
    return bakeHere(engine);
  });
}

function bakeInWorker(engine: AudioEngine, k: number, n: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    let got = 0;
    worker.postMessage({ k, n });
    worker.onmessage = (e: MessageEvent<{ name: string; data: Float32Array[]; loop: boolean } | { done: true }>) => {
      const m = e.data;
      if ('done' in m) {
        worker.terminate();
        resolve();
        return;
      }
      got++;
      engine.register(m.name, m.data, m.loop);
    };
    worker.onerror = (e) => {
      worker.terminate();
      // nothing arrived: fall back; otherwise keep what we have and finish the rest here
      if (got === 0) reject(e);
      else void bakeHere(engine, true).then(resolve);
    };
  });
}

async function bakeHere(engine: AudioEngine, skipKnown = false, budgetMs = 10): Promise<void> {
  const list = jobs().filter((j) => !skipKnown || !engine.has(j.name));
  let i = 0;
  while (i < list.length) {
    const start = performance.now();
    while (i < list.length && performance.now() - start < budgetMs) {
      const { name, recipe } = list[i]!;
      try {
        engine.register(name, renderRecipe(recipe, hashSeed(name)), !!recipe.loop);
      } catch (err) {
        console.warn(`sound ${name} failed to render`, err);
      }
      i++;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
