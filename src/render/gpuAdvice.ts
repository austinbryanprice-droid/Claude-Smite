/**
 * The card in WebGL's renderer string:
 * "ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "Intel(R) UHD Graphics".
 */
export function cardFromRenderer(renderer: string): string {
  return (/ANGLE \([^,]*, (.+?)(?: \(0x[0-9a-f]+\)| Direct3D| OpenGL|, |\)$)/i.exec(renderer)?.[1] ?? renderer).trim();
}

/** Advice for a player whose browser draws on a slow GPU, with text to copy. */
export interface GpuAdvice {
  /** The problem in a sentence or two (the in-match notice shows only this). */
  text: string;
  /** How to fix it, one action per step, for the title screen. */
  steps: string[];
  /** A settings address to copy (browsers refuse links to their own settings pages). */
  copy?: string;
}

/**
 * Chrome on a laptop draws with the integrated GPU unless told otherwise (it
 * ignores the renderer's powerPreference on Windows), so a gaming laptop runs
 * the game on its slowest chip. Spots that, and software rendering, by name.
 */
export function gpuAdvice(name: string, userAgent = navigator.userAgent): GpuAdvice | null {
  const edge = /Edg\//.test(userAgent);
  const browser = edge ? 'Microsoft Edge' : 'Google Chrome';
  const flags = `${edge ? 'edge' : 'chrome'}://flags/#force-high-performance-gpu`;
  if (/swiftshader|llvmpipe|basic render|software/i.test(name)) {
    return {
      text: `The browser is drawing without graphics acceleration (${name}), so the game will stutter.`,
      steps: ['Open the browser\'s Settings and go to System.', 'Turn on "Use graphics acceleration when available".', 'Relaunch the browser and come back here.'],
    };
  }
  // Intel's own cards carry a model number (Arc A770, B580); "Arc Graphics" and
  // "Arc 140V" are the integrated chips of newer laptops
  const intel = /intel/i.test(name) && !/\b[ab]\d{3}m?\b|hpg|gen-12hp/i.test(name);
  const amd = /radeon|vega/i.test(name) && /graphics|\d{3}m\b|vega/i.test(name) && !/\brx\b|\bpro\b/i.test(name);
  if (!intel && !amd) return null;
  const text = `The game is running on ${name}, this computer's built-in graphics, so it will stutter. If it also has a gaming graphics card, switch the browser to it.`;
  // the flag is Chromium's; other browsers and systems pick the GPU in the OS settings
  if (!/Chrome\//.test(userAgent) || !/Windows/.test(userAgent)) {
    return { text, steps: ['Set the browser to use the dedicated graphics card in the system\'s graphics settings.', 'Quit the browser completely, reopen it and come back here.'] };
  }
  return {
    text,
    steps: [
      'Open Windows Settings > System > Display > Graphics.',
      `Find ${browser} in the list (or add it with Browse), choose Options, pick High performance and Save.`,
      `Close every ${browser} window, reopen it and come back here.`,
      `If it still says this, open ${flags} instead, set it to Enabled and press Relaunch.`,
    ],
    copy: flags,
  };
}
