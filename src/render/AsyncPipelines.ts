import type * as THREE from 'three/webgpu';

/** Pipelines compileAsync keeps compiling at once (the driver spreads them over its threads). */
const MAX_IN_FLIGHT = 8;

/** The slice of three's internal pipeline cache this module hooks. */
interface PipelineCache {
  getForRender(renderObject: unknown, promises?: Promise<void>[] | null): unknown;
}

/** The slice of three's renderer internals `limitShaderBuilds` hooks. */
interface DrawInternals {
  _renderObjectDirect?: (...args: unknown[]) => void;
  _nodes?: {
    needsRefresh(renderObject: unknown): unknown;
    get(renderObject: unknown): { nodeBuilderState?: unknown };
    getForRenderCacheKey?(renderObject: unknown): unknown;
    nodeBuilderCache?: Map<unknown, unknown>;
    nodeFrame: { frameId: number };
  };
}

interface RenderObjectLike {
  _nodeBuilderState: unknown;
  object: { isQuadMesh?: boolean };
}

/** What three hands its node-builder hook: a render object, or a compute node. */
interface BuiltFor {
  object?: THREE.Object3D;
  material?: THREE.Material;
  camera?: THREE.Camera;
}

/** "nearest named ancestor/material", and "(shadow)" in the light's pass. */
function describe(ro: BuiltFor): string {
  const o = ro.object;
  if (!o) return 'compute';
  let name = '';
  for (let x: THREE.Object3D | null = o; x && !name; x = x.parent) name = x.name;
  const m = ro.material;
  const shadow = (ro.camera as THREE.OrthographicCamera | undefined)?.isOrthographicCamera ? ' (shadow)' : '';
  return `${name || o.type}/${m?.name || m?.type || '?'}${shadow}`;
}

/** Thrown out of a draw whose shader is still being generated, and caught right there. */
const NOT_READY = Object.freeze({ notReady: true });

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
  /**
   * Shaders generated since start: the node graph built into WGSL/GLSL on the
   * main thread, the part of a new material that can't run in the background.
   */
  built = 0;
  /** What each of those shaders was for (see `describe`), with counts. */
  readonly builtFor = new Map<string, number>();
  /** Draws put off to a later frame because the frame's shader budget was spent. */
  deferred = 0;
  private idle: (() => void)[] = [];
  /** Milliseconds of shader generation a frame may spend, once `limitShaderBuilds` is on. */
  private shaderBudget: number | null = null;
  /**
   * While true, frames prepare each scene object (shader, pipeline, buffers)
   * but send no draws, so a loading frame of everything costs no GPU time.
   */
  preparing = false;
  private slots: (() => void)[] = [];

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    const backend = renderer.backend as unknown as { draw?: (renderObject: RenderObjectLike, info: unknown) => void };
    (renderer.debug as { onNodeBuilderCreated?: ((builder: unknown, ro: BuiltFor) => void) | null }).onNodeBuilderCreated = (_, ro) => {
      this.built++;
      const what = describe(ro);
      this.builtFor.set(what, (this.builtFor.get(what) ?? 0) + 1);
    };
    if (typeof backend.draw === 'function') {
      const draw = backend.draw.bind(backend);
      // full-screen passes still run, on the empty scene
      backend.draw = (renderObject, info) => {
        if (!this.preparing || renderObject.object.isQuadMesh) draw(renderObject, info);
      };
    }
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

  /**
   * From now on each frame spends at most `budgetMs` generating new shaders
   * (and always generates one): an object whose shader would start after that
   * is left out of the frame and drawn a frame or so later, instead of the
   * frame freezing until every new shader is done. Generating happens inside
   * the draw, where it reads the pass's render target and outputs; three's own
   * `getForRenderDeferred` generates between frames, without them. Measured
   * walking a fresh Conquest match: up to 79 new shaders in one frame, about
   * 10-70 ms each. Call again to change the budget (Infinity lifts it).
   */
  limitShaderBuilds(budgetMs: number): void {
    const installed = this.shaderBudget !== null;
    this.shaderBudget = budgetMs;
    if (installed) return;
    const r = this.renderer as unknown as DrawInternals;
    const nodes = r._nodes;
    const direct = r._renderObjectDirect;
    // three changed: keep drawing the way it does
    if (!nodes || typeof nodes.getForRenderCacheKey !== 'function' || !(nodes.nodeBuilderCache instanceof Map) || typeof direct !== 'function') return;
    const cache = nodes.nodeBuilderCache;
    const needsRefresh = nodes.needsRefresh.bind(nodes);
    let drawing = false;
    let frame = -1;
    let spent = 0;
    // three generates a render object's shader in needsRefresh (through its
    // monitor) unless another object already has the same one
    nodes.needsRefresh = (renderObject) => {
      const ro = renderObject as RenderObjectLike;
      if (!drawing || ro._nodeBuilderState !== null || ro.object.isQuadMesh) return needsRefresh(ro);
      if (nodes.get(ro).nodeBuilderState !== undefined || cache.has(nodes.getForRenderCacheKey!(ro))) return needsRefresh(ro);
      if (nodes.nodeFrame.frameId !== frame) {
        frame = nodes.nodeFrame.frameId;
        spent = 0;
      } else if (spent >= this.shaderBudget!) {
        this.deferred++;
        throw NOT_READY;
      }
      const start = performance.now();
      try {
        return needsRefresh(ro);
      } finally {
        spent += performance.now() - start;
      }
    };
    r._renderObjectDirect = function (this: unknown, ...args: unknown[]) {
      drawing = true;
      try {
        direct.apply(this, args);
      } catch (e) {
        if (e !== NOT_READY) throw e;
      } finally {
        drawing = false;
      }
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
