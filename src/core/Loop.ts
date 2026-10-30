/** Anything that advances with simulation time. */
export interface Updatable {
  /** `dt` is seconds since last update, `time` is total elapsed seconds. */
  update(dt: number, time: number): void;
}

/**
 * Frame clock. Simulation systems run on a fixed 60 Hz step (so gameplay stays
 * deterministic regardless of frame rate) and per-frame systems (camera, VFX,
 * animation blending) run once per rendered frame with the real delta.
 */
export class Loop {
  static readonly FIXED_DT = 1 / 60;

  private readonly fixed: Updatable[] = [];
  private readonly frame: Updatable[] = [];
  private accumulator = 0;
  private last = -1;
  time = 0;
  /** Interpolation factor between the last two fixed steps, for smoothing. */
  alpha = 0;

  addFixed(u: Updatable): void {
    this.fixed.push(u);
  }

  addFrame(u: Updatable): void {
    this.frame.push(u);
  }

  remove(u: Updatable): void {
    for (const list of [this.fixed, this.frame]) {
      const i = list.indexOf(u);
      if (i >= 0) list.splice(i, 1);
    }
  }

  /** Call once per animation frame with a millisecond timestamp. Returns frame dt. */
  tick(nowMs: number): number {
    if (this.last < 0) this.last = nowMs;
    // Clamp long stalls (tab switches) so the simulation doesn't spiral.
    const dt = Math.min(Math.max(nowMs - this.last, 0) / 1000, 0.1);
    this.last = nowMs;
    this.accumulator += dt;
    while (this.accumulator >= Loop.FIXED_DT) {
      this.time += Loop.FIXED_DT;
      for (const u of this.fixed) u.update(Loop.FIXED_DT, this.time);
      this.accumulator -= Loop.FIXED_DT;
    }
    this.alpha = this.accumulator / Loop.FIXED_DT;
    for (const u of this.frame) u.update(dt, this.time);
    return dt;
  }
}
