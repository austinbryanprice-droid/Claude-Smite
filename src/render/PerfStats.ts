import type * as THREE from 'three/webgpu';

/** Seconds of play the report covers. */
const WINDOW = 60;
/** Frames the rings hold: a minute at up to 270 fps. */
const SIZE = 16384;
/** GPU time is read back every this many frames (the readback is batched). */
const GPU_EVERY = 8;
/** A frame this long is a visible hitch. */
const HITCH_MS = 50;

/** The parts of a frame timed separately, in the order the game loop marks them. */
export const PHASES = ['sim', 'views', 'world', 'render'] as const;

/** What the game knows about its own setup, for the report's header. */
export interface ReportInfo {
  gpu: string;
  backend: string;
  quality: string;
  /** The automatic resolution scale, 1 when untouched. */
  renderScale: number;
  /** Times the automatic quality lowered the resolution. */
  autoDrops: number;
  canvas: { width: number; height: number };
  mode: string;
  /** Pipelines started since play began (each one a possible hitch). */
  shaders: number;
}

interface Hitch {
  /** Seconds since the game started. */
  t: number;
  ms: number;
  /** The code time and new shaders of the frame before the gap. */
  cpu: number;
  shaders: number;
}

interface LongFrame {
  t: number;
  ms: number;
  blocking: number;
  script: string;
}

/** The value below which `p` of the sorted values fall. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

const ms = (x: number) => (x < 100 ? x.toFixed(1) : String(Math.round(x)));

/**
 * Keeps the last minute of frame timings (the interval between frames, the time
 * the game's own code took in each phase, and GPU time where the browser can
 * measure it) plus the worst stalls since load, for the performance report a
 * player can copy from the H menu. Recording costs a few timer reads a frame.
 */
export class PerfStats {
  private readonly at = new Float64Array(SIZE);
  private readonly interval = new Float32Array(SIZE);
  private readonly cpu = new Float32Array(SIZE);
  private readonly phase = PHASES.map(() => new Float32Array(SIZE));
  private readonly gpuAt = new Float64Array(SIZE);
  private readonly gpu = new Float32Array(SIZE);
  private n = 0;
  private gpuN = 0;
  private lastNow = -1;
  private t0 = 0;
  private mark0 = 0;
  private shadersSeen = 0;
  /** The previous frame's code time and new shaders, which a long gap after it is down to. */
  private lastCpu = 0;
  private lastBuilt = 0;
  /** The first frame back from a hidden tab measures the time away, not a stall. */
  private skip = true;
  private readonly startedAt = performance.now();
  private readonly hitches: Hitch[] = [];
  private readonly counts = { over50: 0, over100: 0, over250: 0, over1000: 0 };
  private readonly longFrames: LongFrame[] = [];
  private longFrameCount = 0;
  private timer: { pool: () => GpuPool | undefined; frames: number } | null = null;
  private battery: { charging: boolean; level: number } | null = null;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.skip = true;
    });
    // Chrome's long-animation-frame entries say which script held a slow frame
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longFrame(e as LoafEntry);
      }).observe({ type: 'long-animation-frame', buffered: false });
    } catch {
      /* not offered by this browser */
    }
    // laptops on battery often cap the GPU (NVIDIA Battery Boost holds 30 fps)
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; level: number }> };
    nav.getBattery?.().then((b) => (this.battery = b), () => {});
  }

  /**
   * Measures GPU time per frame with WebGPU timestamp queries, where the
   * browser offers them (Chrome rounds them to 0.1 ms, plenty for this).
   */
  watchGpu(renderer: THREE.WebGPURenderer): void {
    const backend = renderer.backend as unknown as { trackTimestamp?: boolean; timestampQueryPool?: { render?: GpuPool } };
    let supported = false;
    try {
      supported = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true && renderer.hasFeature('timestamp-query');
    } catch {
      /* not initialized */
    }
    if (!supported) return;
    backend.trackTimestamp = true;
    this.timer = { pool: () => backend.timestampQueryPool?.render, frames: 0 };
  }

  /** Average GPU time per frame over the last `seconds`, or null when there are no samples. */
  gpuAverage(seconds: number): number | null {
    const from = performance.now() - seconds * 1000;
    let sum = 0;
    let count = 0;
    for (let k = this.gpuN - 1; k >= Math.max(0, this.gpuN - SIZE); k--) {
      const j = k % SIZE;
      if (this.gpuAt[j]! < from) break;
      sum += this.gpu[j]!;
      count++;
    }
    return count ? sum / count : null;
  }

  /** Milliseconds since the previous frame, unclamped; 0 after a hidden tab or on the first frame. */
  gap = 0;

  /** Call first thing in a frame, with the animation frame's timestamp. */
  begin(now: number): void {
    const i = this.n % SIZE;
    const gap = this.skip || this.lastNow < 0 ? 0 : now - this.lastNow;
    this.gap = gap;
    this.interval[i] = gap;
    this.skip = false;
    this.lastNow = now;
    this.t0 = this.mark0 = performance.now();
    this.at[i] = this.t0;
    if (gap > HITCH_MS) this.hitch(gap);
  }

  /** Ends phase `i` of `PHASES`. */
  mark(i: number): void {
    const now = performance.now();
    this.phase[i]![this.n % SIZE] = now - this.mark0;
    this.mark0 = now;
  }

  /**
   * Call last thing in a frame with the running count of shaders started;
   * returns the milliseconds the frame's code took.
   */
  end(shaders: number): number {
    const i = this.n % SIZE;
    const cpu = performance.now() - this.t0;
    this.cpu[i] = cpu;
    this.lastCpu = cpu;
    this.lastBuilt = shaders - this.shadersSeen;
    this.shadersSeen = shaders;
    this.n++;
    if (this.timer && ++this.timer.frames % GPU_EVERY === 0) this.readGpu(this.timer.pool());
    return cpu;
  }

  private hitch(gap: number): void {
    this.counts.over50++;
    if (gap > 100) this.counts.over100++;
    if (gap > 250) this.counts.over250++;
    if (gap > 1000) this.counts.over1000++;
    this.hitches.push({ t: (this.t0 - this.startedAt) / 1000, ms: gap, cpu: this.lastCpu, shaders: this.lastBuilt });
    this.hitches.sort((a, b) => b.ms - a.ms);
    if (this.hitches.length > 6) this.hitches.length = 6;
  }

  private readGpu(pool: GpuPool | undefined): void {
    if (!pool || pool.pendingResolve) return;
    const at = performance.now();
    void pool.resolveQueriesAsync().then(() => {
      // three sums the passes of the batch's last frame only: add up every frame
      const frames = new Map<string, number>();
      for (const [uid, d] of pool.timestamps) {
        const f = uid.slice(uid.lastIndexOf(':f') + 2);
        frames.set(f, (frames.get(f) ?? 0) + d);
      }
      // a resolve with nothing new leaves the old batch in place: never count it twice
      pool.timestamps.clear();
      for (const d of frames.values()) {
        const j = this.gpuN++ % SIZE;
        this.gpu[j] = d;
        this.gpuAt[j] = at;
      }
    }, () => {});
  }

  private longFrame(e: LoafEntry): void {
    this.longFrameCount++;
    const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0];
    const file = top?.sourceURL ? top.sourceURL.slice(top.sourceURL.lastIndexOf('/') + 1) : '';
    const scripts = (e.scripts ?? []).reduce((sum, x) => sum + x.duration, 0);
    // the frame's own style, layout and paint run from styleAndLayoutStart to its end
    const layout = e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0;
    const where = top
      ? `, most in ${top.invoker || top.invokerType || 'script'}${file ? ` ${file}:${top.sourceCharPosition}` : ''}${top.sourceFunctionName ? ` ${top.sourceFunctionName}()` : ''} ${Math.round(top.duration)} ms`
      : '';
    const script = `scripts ${Math.round(scripts)} ms${where}; style and layout ${Math.round(layout)} ms`;
    this.longFrames.push({ t: Math.max(0, e.startTime - this.startedAt) / 1000, ms: e.duration, blocking: e.blockingDuration ?? 0, script });
    this.longFrames.sort((a, b) => b.ms - a.ms);
    if (this.longFrames.length > 4) this.longFrames.length = 4;
  }

  /** Values of `ring` for the frames recorded in the last minute, sorted. */
  private recent(ring: Float32Array, times: Float64Array, count: number, skipZero = false): Float32Array {
    const from = performance.now() - WINDOW * 1000;
    const out: number[] = [];
    for (let k = Math.max(0, count - SIZE); k < count; k++) {
      const j = k % SIZE;
      if (times[j]! < from || (skipZero && ring[j] === 0)) continue;
      out.push(ring[j]!);
    }
    return Float32Array.from(out).sort();
  }

  /** The plain-text report: setup, then the last minute's timings, then the worst stalls since load. */
  report(info: ReportInfo): string {
    const frames = this.recent(this.interval, this.at, this.n, true);
    const cpu = this.recent(this.cpu, this.at, this.n);
    const gpu = this.recent(this.gpu, this.gpuAt, this.gpuN);
    const span = frames.reduce((s, x) => s + x, 0) / 1000;
    const dist = (v: Float32Array) => `p50 ${ms(percentile(v, 0.5))} · p90 ${ms(percentile(v, 0.9))} · p99 ${ms(percentile(v, 0.99))} · max ${ms(v[v.length - 1] ?? 0)}`;
    const ua = navigator.userAgent;
    const browser = /(Edg|OPR|Chrome|Firefox|Version)\/(\d+)/.exec(ua);
    const os = /Windows NT [\d.]+|Mac OS X [\d_]+|Android [\d.]+|CrOS|Linux/.exec(ua)?.[0] ?? '?';
    const nav = navigator as Navigator & { deviceMemory?: number };
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const lines = [
      `Ascendant performance report · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${buildId()}`,
      `GPU: ${info.gpu || 'unknown'} · ${info.backend}${this.timer ? '' : ' · no GPU timing'}`,
      `System: ${browser ? `${browser[1] === 'Edg' ? 'Edge' : browser[1] === 'Version' ? 'Safari' : browser[1]} ${browser[2]}` : '?'} · ${os} · ${navigator.hardwareConcurrency ?? '?'} threads${nav.deviceMemory ? ` · ${nav.deviceMemory}+ GB` : ''}${this.battery ? ` · ${this.battery.charging ? 'plugged in' : 'ON BATTERY'} ${Math.round(this.battery.level * 100)}%` : ''}${heap ? ` · JS heap ${Math.round(heap / 1048576)} MB` : ''}`,
      `Display: ${screen.width}×${screen.height} at ${devicePixelRatio}x · canvas ${info.canvas.width}×${info.canvas.height} · quality ${info.quality} · render scale ${Math.round(info.renderScale * 100)}%${info.autoDrops ? ` (lowered ${info.autoDrops}x)` : ''}`,
      `Window: last ${Math.round(span)} s of ${info.mode}, ${frames.length} frames, ${span > 0 ? Math.round(frames.length / span) : 0} fps average`,
      `Frame interval ms: ${dist(frames)}`,
      `Game code ms/frame: ${dist(cpu)}`,
      `  by phase (avg / p99): ${PHASES.map((name, k) => {
        const v = this.recent(this.phase[k]!, this.at, this.n);
        return `${name} ${ms(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length))} / ${ms(percentile(v, 0.99))}`;
      }).join(' · ')}`,
      gpu.length ? `GPU ms/frame: ${dist(gpu)}` : 'GPU ms/frame: not measurable in this browser',
      `Stalls since load: ${this.counts.over50} over 50 ms · ${this.counts.over100} over 100 ms · ${this.counts.over250} over 250 ms · ${this.counts.over1000} over 1 s`,
      ...this.hitches.map((h) => `  ${ms(h.ms)} ms at ${h.t.toFixed(1)} s: the frame before ran ${ms(h.cpu)} ms of game code${h.shaders ? ` and started ${h.shaders} shaders` : ''}`),
      `Shaders built during play: ${info.shaders}`,
      `Long frames flagged by the browser: ${this.longFrameCount}`,
      ...this.longFrames.map((f) => `  ${Math.round(f.ms)} ms at ${f.t.toFixed(1)} s (blocking ${Math.round(f.blocking)} ms): ${f.script}`),
      `UA: ${ua}`,
    ];
    return lines.join('\n');
  }
}

/** The slice of three's WebGPU timestamp pool this reads. */
interface GpuPool {
  pendingResolve: Promise<number> | null;
  timestamps: Map<string, number>;
  resolveQueriesAsync(): Promise<number>;
}

/** Chrome's long-animation-frame timing entry (not in TypeScript's DOM types yet). */
interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
  styleAndLayoutStart?: number;
  scripts?: { duration: number; invoker?: string; invokerType?: string; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number }[];
}

/** The bundle's file name, which changes with every deploy. */
function buildId(): string {
  try {
    const path = new URL(import.meta.url).pathname;
    return path.slice(path.lastIndexOf('/') + 1);
  } catch {
    return 'dev';
  }
}
