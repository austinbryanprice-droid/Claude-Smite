/** Render-resolution steps tried in turn while the frame rate stays low. */
const SCALES = [1, 0.85, 0.7, 0.55];
/** Below this average, a step down in resolution is worth the sharpness it costs. */
const MIN_FPS = 45;
/** Seconds of play averaged per check. */
const WINDOW = 4;
/** Seconds to wait after the match starts or the resolution changes (shaders still settling). */
const SETTLE = 6;
/**
 * Share of each frame spent in the game's own frame code above which the
 * frame rate is limited by the CPU, where a lower resolution only blurs the
 * picture without making it any faster.
 */
const CPU_BOUND = 0.7;
/**
 * Share of each frame the GPU must be busy for it to be the limit. Below this
 * the frames are held back elsewhere (the browser, the driver, a stall), and a
 * lower resolution would not help either.
 */
const GPU_BOUND = 0.6;

/**
 * Lowers the render resolution while the frame rate stays low, so a slower
 * machine ends up smooth without the player hunting for the setting. Only the
 * resolution changes: switching presets mid-match would rebuild shadows and
 * shaders, a hitch of its own. It only ever lowers, and stops for good once the
 * player picks a quality themselves. When the game's own code fills most of each
 * frame, the CPU is the limit and the resolution stays where it is; the same
 * goes when the GPU's measured time shows it idle for much of each frame.
 */
export class AutoQuality {
  private wait = SETTLE;
  private time = 0;
  private frames = 0;
  private cpu = 0;
  private step = 0;
  private stopped = false;

  /** `gpuMs`: average GPU time per frame over the last few seconds, null where it can't be measured. */
  constructor(
    private readonly setScale: (scale: number) => void,
    private readonly gpuMs: () => number | null = () => null,
  ) {}

  /** The player chose a quality: leave it alone from now on. */
  stop(): void {
    this.stopped = true;
  }

  /** `cpuMs`: time the frame's own code took on the main thread (simulation, scene updates, draw submission). */
  frame(dt: number, cpuMs = 0): void {
    // a hidden tab or a stall says nothing about the steady frame rate
    if (this.stopped || dt <= 0 || dt > 0.25) return;
    if ((this.wait -= dt) > 0) return;
    this.time += dt;
    this.cpu += cpuMs / 1000;
    this.frames++;
    if (this.time < WINDOW) return;
    const fps = this.frames / this.time;
    const cpuBound = this.cpu / this.time > CPU_BOUND;
    const gpu = this.gpuMs();
    // (near-zero readings are a driver that doesn't really time passes, not a fast GPU)
    const gpuIdle = gpu !== null && gpu > 0.5 && gpu < (1000 / fps) * GPU_BOUND;
    this.time = this.frames = this.cpu = 0;
    if (fps >= MIN_FPS || cpuBound || gpuIdle) return;
    if (this.step >= SCALES.length - 1) {
      this.stopped = true;
      return;
    }
    this.wait = SETTLE;
    this.setScale(SCALES[++this.step]!);
  }
}
