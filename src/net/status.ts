let el: HTMLDivElement | null = null;

/**
 * A banner over the game for the network's state: waiting for players, or
 * the host leaving (with a button). `null` hides it.
 */
export function showNetStatus(text: string | null, action?: { label: string; run: () => void }): void {
  if (typeof document === 'undefined') return;
  if (text === null) {
    el?.remove();
    el = null;
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = 'net-status';
    document.body.appendChild(el);
  }
  el.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    el.appendChild(b);
  }
}
