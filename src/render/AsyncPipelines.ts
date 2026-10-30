import type * as THREE from 'three/webgpu';

/** Pipelines compileAsync keeps compiling at once (the driver spreads them over its threads). */
const MAX_IN_FLIGHT = 8;

/** The slice of three's internal pipeline cache this module hooks. */
interface PipelineCache {
  getForRender(renderObject: unknown, promises?: Promise<void>[] | null): unknown;
}

/**
 * Makes every GPU pipeline compile in the background, all at once.
 *
 * three normally builds a pipeline synchronously the first time something is
 * drawn (a freeze that can last seconds per shader on some Windows drivers), and
 * `compileAsync` waits for each pipeline in turn before starting the next. Here
 * every new pipeline goes to the driver's async path straight away and three
 * simply skips drawing an object until its pipeline is ready (`Pipelines.isReady`),
 * so the driver compiles them in parallel and nothing ever blocks a frame.
 */
export class AsyncPipelines {
  /** Pipelines still compiling. */
  pending = 0;
  /** Pipelines finished since start. */
  done = 0;
  private idle: (() => void)[] = [];
  private slots: (() => void)[] = [];

  constructor(renderer: THREE.WebGPURenderer) {
    const cache = (renderer as unknown as { _pipelines?: PipelineCache })._pipelines;
    if (!cache || typeof cache.getForRender !== 'function') return; // three changed: keep its default behaviour
    const original = cache.getForRender.bind(cache);
    // compileAsync passes its own array and would await each pipeline before the
    // next. It gets a free slot to wait for instead, so a few compile at once:
    // hundreds at once exhaust GPU memory and starve the page of frames.
    cache.getForRender = (renderObject, promises) => {
      const started: Promise<void>[] = [];
      const result = original(renderObject, started);
      for (const p of started) this.track(p);
      if (promises && this.pending >= MAX_IN_FLIGHT) promises.push(new Promise((r) => this.slots.push(r)));
      return result;
    };
  }

  private track(p: Promise<void>): void {
    this.pending++;
    const finish = () => {
      this.pending--;
      this.done++;
      this.slots.shift()?.();
      if (this.pending === 0) for (const fn of this.idle.splice(0)) fn();
    };
    p.then(finish, finish);
  }

  /**
   * Resolves once nothing is compiling, or after `timeoutMs` (whatever is left
   * then keeps compiling and pops in when ready). Reports progress as it goes.
   */
  settle(timeoutMs: number, onProgress?: (done: number, total: number) => void): Promise<boolean> {
    return new Promise((resolve) => {
      const start = this.done;
      const report = () => onProgress?.(this.done - start, this.done - start + this.pending);
      const tick = setInterval(report, 250);
      const end = (settled: boolean) => {
        clearInterval(tick);
        clearTimeout(timer);
        report();
        resolve(settled);
      };
      const timer = setTimeout(() => end(false), timeoutMs);
      if (this.pending === 0) end(true);
      else this.idle.push(() => end(true));
    });
  }
}
