/** Render-resolution steps tried in turn while the frame rate stays low. */
const SCALES = [1, 0.85, 0.7, 0.55];
/** Below this average, a step down in resolution is worth the sharpness it costs. */
const MIN_FPS = 45;
/** Seconds of play averaged per check. */
const WINDOW = 4;
/** Seconds to wait after the match starts or the resolution changes (shaders still settling). */
const SETTLE = 6;

/**
 * Lowers the render resolution while the frame rate stays low, so a slower
 * machine ends up smooth without the player hunting for the setting. Only the
 * resolution changes: switching presets mid-match would rebuild shadows and
 * shaders, a hitch of its own. It only ever lowers, and stops for good once the
 * player picks a quality themselves.
 */
export class AutoQuality {
  private wait = SETTLE;
  private time = 0;
  private frames = 0;
  private step = 0;
  private stopped = false;

  constructor(private readonly setScale: (scale: number) => void) {}

  /** The player chose a quality: leave it alone from now on. */
  stop(): void {
    this.stopped = true;
  }

  frame(dt: number): void {
    // a hidden tab or a stall says nothing about the steady frame rate
    if (this.stopped || dt <= 0 || dt > 0.25) return;
    if ((this.wait -= dt) > 0) return;
    this.time += dt;
    this.frames++;
    if (this.time < WINDOW) return;
    const fps = this.frames / this.time;
    this.time = this.frames = 0;
    if (fps >= MIN_FPS) return;
    if (this.step >= SCALES.length - 1) {
      this.stopped = true;
      return;
    }
    this.wait = SETTLE;
    this.setScale(SCALES[++this.step]!);
  }
}
