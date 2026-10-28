import { QUALITY_PRESETS, type QualityName } from '../render/Quality';

/** Minimal overlay: FPS, backend, quality picker, controls hint, loading screen. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly fps: HTMLSpanElement;
  private readonly stats: HTMLSpanElement;
  private readonly loading: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private frames = 0;
  private acc = 0;

  constructor(onQuality: (q: QualityName) => void) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-panel">
        <span class="hud-fps">-- fps</span>
        <span class="hud-stats"></span>
        <label>Quality
          <select class="hud-quality">
            ${Object.values(QUALITY_PRESETS).map((p) => `<option value="${p.name}">${p.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="hud-crosshair"></div>
      <div class="hud-hint">Click to play &middot; WASD move &middot; Mouse aim &middot; Left click attack &middot; 1-4, R skills &middot; B recall &middot; K skills &amp; trees &middot; Esc release mouse</div>
      <div class="hud-loading"><div class="hud-title">ASCENDANT</div><div class="hud-bar"><div></div></div><div class="hud-sub">Raising the temple&hellip;</div></div>
    `;
    document.body.appendChild(this.root);
    this.fps = this.root.querySelector('.hud-fps')!;
    this.stats = this.root.querySelector('.hud-stats')!;
    this.loading = this.root.querySelector('.hud-loading')!;
    this.bar = this.root.querySelector('.hud-bar > div')!;
    this.hint = this.root.querySelector('.hud-hint')!;
    const select = this.root.querySelector<HTMLSelectElement>('.hud-quality')!;
    select.addEventListener('change', () => {
      onQuality(select.value as QualityName);
      select.blur();
    });
    this.setQuality = (q) => (select.value = q);
  }

  setQuality: (q: QualityName) => void;

  progress(f: number, text?: string): void {
    this.bar.style.width = `${Math.round(f * 100)}%`;
    if (text) this.root.querySelector('.hud-sub')!.textContent = text;
  }

  ready(): void {
    this.loading.classList.add('done');
    setTimeout(() => this.loading.remove(), 1200);
  }

  setLocked(locked: boolean): void {
    this.hint.classList.toggle('hidden', locked);
  }

  setInfo(text: string): void {
    this.stats.textContent = text;
  }

  frame(dt: number): void {
    this.frames++;
    this.acc += dt;
    if (this.acc >= 0.5) {
      this.fps.textContent = `${Math.round(this.frames / this.acc)} fps`;
      this.frames = 0;
      this.acc = 0;
    }
  }

  error(message: string): void {
    this.loading.classList.remove('done');
    this.root.querySelector('.hud-sub')!.textContent = message;
  }
}
