import { QUALITY_PRESETS, type QualityName } from '../render/Quality';
import { controlsHtml } from './StartMenu';

const SENS_KEY = 'ascendant.sensitivity';

function loadSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(SENS_KEY));
    if (v >= 0.25 && v <= 3) return v;
  } catch {
    /* storage unavailable */
  }
  return 1;
}

/** Minimal overlay: FPS, backend, quality picker, controls hint, loading screen. */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly fps: HTMLSpanElement;
  private readonly stats: HTMLSpanElement;
  private readonly loading: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private frames = 0;
  private acc = 0;

  constructor(onQuality: (q: QualityName) => void, onSensitivity: (scale: number) => void = () => {}) {
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
      <div class="hud-hint"><b>Click to play</b><span>WASD move &middot; mouse aim &middot; left click attack &middot; 1&ndash;4, R skills</span><span>H controls &amp; settings &middot; Esc frees the mouse</span></div>
      <div class="hud-loading"><div class="hud-title">ASCENDANT</div><div class="hud-bar"><div></div></div><div class="hud-sub">Raising the temple&hellip;</div></div>
    `;
    document.body.appendChild(this.root);
    this.help = document.createElement('div');
    this.help.className = 'help';
    this.help.innerHTML = `<div class="help-panel"><h3>Controls</h3>${controlsHtml()}
      <h3 class="help-gap">Settings</h3>
      <label class="help-row">Mouse sensitivity <input class="help-sens" type="range" min="0.25" max="3" step="0.05"><span class="help-sens-val"></span></label>
      <div class="help-actions"><button class="help-resume">Resume</button><button class="help-quit">Quit to title</button></div>
      <div class="help-foot">Press H to close.</div></div>`;
    this.help.addEventListener('click', (e) => {
      if (e.target === this.help) this.toggleHelp(false);
    });
    this.help.addEventListener('mousedown', (e) => e.stopPropagation());
    this.help.querySelector('.help-resume')!.addEventListener('click', () => this.toggleHelp(false));
    this.help.querySelector('.help-quit')!.addEventListener('click', () => location.reload());
    const sens = this.help.querySelector<HTMLInputElement>('.help-sens')!;
    const sensVal = this.help.querySelector<HTMLSpanElement>('.help-sens-val')!;
    const applySens = (v: number) => {
      sens.value = String(v);
      sensVal.textContent = `${v.toFixed(2)}x`;
      onSensitivity(v);
    };
    applySens(loadSensitivity());
    sens.addEventListener('input', () => {
      const v = Number(sens.value);
      applySens(v);
      try {
        localStorage.setItem(SENS_KEY, String(v));
      } catch {
        /* storage unavailable */
      }
    });
    document.body.appendChild(this.help);
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

  get helpOpen(): boolean {
    return this.help.classList.contains('show');
  }

  toggleHelp(show = !this.helpOpen): void {
    this.help.classList.toggle('show', show);
    if (show) document.exitPointerLock?.();
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
