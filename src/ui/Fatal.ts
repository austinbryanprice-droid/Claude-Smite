import './start.css';

/**
 * Renamed when WebGPU's missing god bodies were fixed (#114): players who
 * switched to WebGL 2 because of that bug get WebGPU again, and the error card
 * still offers the switch if WebGPU really fails on their machine.
 */
const COMPAT_KEY = 'ascendant.webgl.v2';

/** True when the player asked for the WebGL 2 renderer (URL `?webgl` or the saved compatibility switch). */
export function compatibilityMode(): boolean {
  if (new URLSearchParams(location.search).has('webgl')) return true;
  try {
    return localStorage.getItem(COMPAT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Saves the renderer choice and reloads the page with it. */
export function setCompatibilityMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(COMPAT_KEY, '1');
    else localStorage.removeItem(COMPAT_KEY);
  } catch {
    /* storage unavailable: the URL flag still carries it */
  }
  const url = new URL(location.href);
  if (on) url.searchParams.set('webgl', '');
  else url.searchParams.delete('webgl');
  location.href = url.toString().replace('webgl=', 'webgl');
}

let shown = false;

/**
 * A visible error card, so a failed start or a lost GPU never leaves a silent
 * black screen. Offers the WebGL 2 renderer when WebGPU was in use.
 */
export function showFatal(message: string, detail = ''): void {
  console.error(message, detail);
  if (shown) return;
  shown = true;
  const compat = compatibilityMode();
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = `
    <div class="fatal-panel">
      <h3>Something went wrong</h3>
      <p class="fatal-msg"></p>
      <pre class="fatal-detail"></pre>
      <div class="fatal-actions">
        ${compat ? '' : '<button class="fatal-compat">Restart in compatibility mode (WebGL 2)</button>'}
        <button class="fatal-reload">Reload</button>
        <button class="fatal-close">Continue anyway</button>
      </div>
    </div>`;
  el.querySelector('.fatal-msg')!.textContent = message;
  el.querySelector('.fatal-detail')!.textContent = detail.slice(0, 1200);
  el.querySelector('.fatal-compat')?.addEventListener('click', () => setCompatibilityMode(true));
  el.querySelector('.fatal-reload')!.addEventListener('click', () => location.reload());
  el.querySelector('.fatal-close')!.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  document.exitPointerLock?.();
}

const describe = (e: unknown): string => (e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));

/** Turns uncaught errors and rejected promises into the error card. */
export function installErrorHandlers(): void {
  window.addEventListener('error', (e) => showFatal('The game hit an error.', describe(e.error ?? e.message)));
  window.addEventListener('unhandledrejection', (e) => showFatal('The game hit an error.', describe(e.reason)));
}
