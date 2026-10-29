/// <reference lib="webworker" />
// Renders the sound bank off the main thread and hands each sound back as it finishes.
import { jobs } from './bank';
import { hashSeed } from './dsp';
import { renderRecipe } from './sounds';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// worker k of n takes every n-th sound, so a few cores share the work
scope.onmessage = (e: MessageEvent<{ k: number; n: number }>) => {
  const { k, n } = e.data;
  jobs().forEach(({ name, recipe }, i) => {
    if (i % n !== k) return;
    try {
      const data = renderRecipe(recipe, hashSeed(name));
      scope.postMessage({ name, data, loop: !!recipe.loop }, data.map((d) => d.buffer));
    } catch (err) {
      console.warn(`sound ${name} failed to render`, err);
    }
  });
  scope.postMessage({ done: true });
};
