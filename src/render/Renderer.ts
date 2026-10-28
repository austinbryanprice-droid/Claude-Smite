import * as THREE from 'three/webgpu';

export interface RendererInfo {
  renderer: THREE.WebGPURenderer;
  /** True when running on the WebGPU backend, false on the WebGL2 fallback. */
  isWebGPU: boolean;
}

/**
 * Creates the renderer. WebGPU is preferred; three.js falls back to its WebGL2
 * backend automatically when WebGPU is missing. `?webgl` forces the fallback,
 * which is handy for testing.
 */
export async function createRenderer(container: HTMLElement): Promise<RendererInfo> {
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  const renderer = new THREE.WebGPURenderer({
    antialias: false, // anti-aliasing is done in post (TRAA / SMAA / FXAA)
    forceWebGL,
    powerPreference: 'high-performance',
  });
  await renderer.init();

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  return { renderer, isWebGPU: backend.isWebGPUBackend === true };
}
