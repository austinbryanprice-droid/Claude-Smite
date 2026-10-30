import type { QualityName } from './Quality';

const ORDER: QualityName[] = ['low', 'medium', 'high', 'ultra'];
/** Below this average, a step down in quality is worth the looks it costs. */
const MIN_FPS = 45;
/** Seconds of play averaged per check. */
const WINDOW = 4;
/** Seconds to wait after the match starts or quality changes (shaders still settling). */
const SETTLE = 6;

/**
 * Steps the quality preset down while the frame rate stays low, so a slower
 * machine ends up smooth without the player hunting for the setting. It only
 * ever lowers, and stops for good once the player picks a quality themselves.
 */
export class AutoQuality {
  private wait = SETTLE;
  private time = 0;
  private frames = 0;
  private stopped = false;

  constructor(
    private readonly current: () => QualityName,
    private readonly lower: (to: QualityName) => void,
  ) {}

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
    const i = ORDER.indexOf(this.current());
    if (i <= 0) {
      this.stopped = true;
      return;
    }
    this.wait = SETTLE;
    this.lower(ORDER[i - 1]!);
  }
}
