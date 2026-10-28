import * as THREE from 'three/webgpu';

export interface RendererInfo {
  renderer: THREE.WebGPURenderer;
  /** True when running on the WebGPU backend, false on the WebGL2 fallback. */
  isWebGPU: boolean;
}

// Held for the page's lifetime: some Chromium builds drop the device when its
// adapter is garbage collected, which shows up as a random "device lost".
let keepAdapter: unknown = null;

/** Creates the WebGPU device ourselves so we can keep the adapter alive and ask for the limits we need. */
async function requestDevice(): Promise<GPUDeviceLike | undefined> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o: object): Promise<AdapterLike | null> } }).gpu;
  if (!gpu) return undefined;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance', featureLevel: 'compatibility' });
  if (!adapter) return undefined;
  keepAdapter = adapter;
  const requiredFeatures = [...adapter.features];
  const want = ['maxSampledTexturesPerShaderStage', 'maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize', 'maxColorAttachments', 'maxColorAttachmentBytesPerSample'];
  const requiredLimits: Record<string, number> = {};
  for (const k of want) {
    const v = adapter.limits[k];
    if (typeof v === 'number') requiredLimits[k] = v;
  }
  return adapter.requestDevice({ requiredFeatures, requiredLimits });
}

interface AdapterLike {
  features: Set<string>;
  limits: Record<string, number>;
  requestDevice(d: object): Promise<GPUDeviceLike>;
}
type GPUDeviceLike = object;

/**
 * Creates the renderer. WebGPU is preferred; three.js falls back to its WebGL2
 * backend automatically when WebGPU is missing. `?webgl` forces the fallback,
 * which is handy for testing.
 */
export async function createRenderer(container: HTMLElement): Promise<RendererInfo> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  let device: GPUDeviceLike | undefined;
  if (!forceWebGL) {
    try {
      device = await requestDevice();
    } catch (err) {
      console.warn('WebGPU device request failed, falling back to WebGL 2', err);
    }
  }
  const renderer = new THREE.WebGPURenderer({
    antialias: false, // anti-aliasing is done in post (TRAA / SMAA / FXAA)
    forceWebGL: forceWebGL || !device,
    powerPreference: 'high-performance',
    ...(device ? { device } : {}),
  } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
  await renderer.init();
  void keepAdapter;

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return { renderer, isWebGPU: backend.isWebGPUBackend === true };
}
