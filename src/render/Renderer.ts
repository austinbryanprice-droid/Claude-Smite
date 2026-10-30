import * as THREE from 'three/webgpu';
import { compatibilityMode, showFatal } from '../ui/Fatal';
import { cardFromRenderer } from './gpuAdvice';

export interface RendererInfo {
  renderer: THREE.WebGPURenderer;
  /** True when running on the WebGPU backend, false on the WebGL2 fallback. */
  isWebGPU: boolean;
}

/**
 * Creates the renderer. WebGPU is preferred; three.js falls back to its WebGL2
 * backend automatically when WebGPU is missing. `?webgl` (or the title screen's
 * compatibility switch) forces the fallback.
 */
/** The slice of the WebGPU device we watch (the project doesn't pull in @webgpu/types). */
interface GpuDevice {
  lost: Promise<{ reason: string; message: string }>;
  addEventListener(type: 'uncapturederror', fn: (e: Event) => void): void;
}

export async function createRenderer(container: HTMLElement): Promise<RendererInfo> {
  const forceWebGL = compatibilityMode();
  const renderer = new THREE.WebGPURenderer({
    antialias: false, // anti-aliasing is done in post (TRAA / SMAA / FXAA)
    forceWebGL,
    powerPreference: 'high-performance',
  });
  await renderer.init();

  renderer.setSize(window.innerWidth, window.innerHeight);
  // ACES gives the punchy, saturated filmic response of UE's default tonemapper.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GpuDevice };
  // a GPU that rejects our pipelines would otherwise just draw black
  const device = backend.device;
  if (device) {
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') showFatal('The graphics device was lost (WebGPU).', info.message);
    });
    device.addEventListener('uncapturederror', (e) => showFatal('The graphics card rejected a draw (WebGPU).', (e as Event & { error: { message: string } }).error.message));
  }
  return { renderer, isWebGPU: backend.isWebGPUBackend === true };
}

/**
 * A short name for the graphics card in use, so a laptop running the game on
 * its integrated GPU instead of the dedicated one is easy to spot.
 */
export function gpuName(renderer: THREE.WebGPURenderer): string {
  const backend = renderer.backend as unknown as {
    device?: { adapterInfo?: { vendor?: string; architecture?: string; description?: string } };
    gl?: WebGL2RenderingContext;
  };
  const info = backend.device?.adapterInfo;
  if (info) {
    if (info.description) return info.description.trim();
    // Chrome only says "intel gen-12lp" here. Its WebGL runs on the same GPU and
    // names the card in full, so borrow that name when the vendor agrees.
    const full = cardName(probeGl());
    if (full && info.vendor && full.toLowerCase().includes(info.vendor.toLowerCase())) return full;
    return [info.vendor, info.architecture].filter(Boolean).join(' ').trim();
  }
  return cardName(backend.gl ?? null);
}

/** The card named by a WebGL context's renderer string. */
function cardName(gl: WebGL2RenderingContext | null): string {
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return cardFromRenderer(ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '');
}

/** A throwaway WebGL context, released as soon as it has been read. */
function probeGl(): WebGL2RenderingContext | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    queueMicrotask(() => gl?.getExtension('WEBGL_lose_context')?.loseContext());
    return gl;
  } catch {
    return null;
  }
}
