/**
 * three.js layer channels used by the renderer. Objects default to WORLD.
 * Gameplay code puts its meshes on the layer that matches how they should be
 * drawn; the pipeline decides which passes see which layers.
 */
export const Layers = {
  /** Opaque static world and actors. Drawn in every pass. */
  WORLD: 0,
  /** Transparent / additive effects (fire, spell VFX). */
  VFX: 1,
  /** Debug helpers, only visible when debug view is on. */
  DEBUG: 2,
  /**
   * Shadow casters too fine to make out in the far shadow cascades (grass): drawn by
   * the camera and the near cascades only. The camera enables this layer.
   */
  NEAR_SHADOW: 3,
  /**
   * On no object: marks the far cascades' cameras, which three would otherwise
   * give the main camera's layers (it does for a camera on layer 0 alone).
   */
  FAR_SHADOW: 4,
} as const;
