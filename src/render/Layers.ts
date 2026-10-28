/**
 * three.js layer channels used by the renderer. Objects default to WORLD.
 * Gameplay code puts its meshes on the layer that matches how they should be
 * drawn; the pipeline decides which passes see which layers.
 */
export const Layers = {
  /** Opaque static world and actors. Drawn in every pass. */
  WORLD: 0,
  /** Transparent / additive effects (fire, spell VFX). Skipped by the depth-normal pre-pass. */
  VFX: 1,
  /** Debug helpers, only visible when debug view is on. */
  DEBUG: 2,
} as const;
