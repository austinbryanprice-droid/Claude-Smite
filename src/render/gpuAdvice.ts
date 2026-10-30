/**
 * The card in WebGL's renderer string:
 * "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "Intel(R) UHD Graphics".
 */
export function cardFromRenderer(renderer: string): string {
  return (/ANGLE \([^,]*, (.+?)(?: \(0x[0-9a-f]+\)| Direct3D| OpenGL|, |\)$)/i.exec(renderer)?.[1] ?? renderer).trim();
}

/** Advice for a player whose browser draws on a slow GPU, with text to copy. */
export interface GpuAdvice {
  text: string;
  copy?: string;
}

/**
 * Chrome on a laptop draws with the integrated GPU unless told otherwise (it
 * ignores the renderer's powerPreference on Windows), so a gaming laptop runs
 * the game on its slowest chip. Spots that, and software rendering, by name.
 */
export function gpuAdvice(name: string, userAgent = navigator.userAgent): GpuAdvice | null {
  const flags = `${/Edg\//.test(userAgent) ? 'edge' : 'chrome'}://flags/#force-high-performance-gpu`;
  if (/swiftshader|llvmpipe|basic render|software/i.test(name)) {
    return { text: `The browser is drawing without graphics acceleration (${name}), so the game will stutter. Turn on "Use graphics acceleration when available" in the browser's System settings and relaunch it.` };
  }
  // Intel's own cards carry a model number (Arc A770, B580); "Arc Graphics" and
  // "Arc 140V" are the integrated chips of newer laptops
  const intel = /intel/i.test(name) && !/\b[ab]\d{3}m?\b|hpg|gen-12hp/i.test(name);
  const amd = /radeon|vega/i.test(name) && /graphics|\d{3}m\b|vega/i.test(name) && !/\brx\b|\bpro\b/i.test(name);
  if (!intel && !amd) return null;
  return {
    text: `The game is running on ${name}, this computer's built-in graphics, so it will stutter. If it also has a gaming graphics card, open ${flags}, set it to Enabled and relaunch the browser.`,
    copy: flags,
  };
}
