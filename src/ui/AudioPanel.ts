import type { AudioEngine, AudioSettings } from '../audio/AudioEngine';
import './audio.css';

const SLIDERS: [keyof AudioSettings, string][] = [
  ['master', 'Master'],
  ['music', 'Music'],
  ['sfx', 'Effects'],
  ['voice', 'Herald'],
  ['ambience', 'Ambience'],
];

const ICON_ON = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`;
const ICON_OFF = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

/**
 * The sound button and its mixer: volume sliders for each part of the mix
 * and a mute switch (also on M). Shown on the title screen and in game.
 */
export function mountAudioPanel(engine: AudioEngine): void {
  const root = document.createElement('div');
  root.className = 'snd';
  root.innerHTML = `
    <button class="snd-btn" title="Sound (M to mute)"></button>
    <div class="snd-pop">
      <div class="snd-head">Sound</div>
      ${SLIDERS.map(([k, label]) => `<label class="snd-row"><span>${label}</span><input type="range" min="0" max="100" step="1" data-k="${k}"><b></b></label>`).join('')}
      <label class="snd-row snd-mute"><span>Mute all</span><input type="checkbox" data-k="muted"></label>
      <div class="snd-foot">All sound and music is original and made in code. M mutes.</div>
    </div>`;
  document.body.appendChild(root);
  const btn = root.querySelector<HTMLButtonElement>('.snd-btn')!;
  const sync = () => {
    const s = engine.settings;
    btn.innerHTML = s.muted || s.master <= 0 ? ICON_OFF : ICON_ON;
    btn.classList.toggle('off', s.muted);
    root.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((i) => {
      const v = s[i.dataset.k as keyof AudioSettings] as number;
      i.value = String(Math.round(v * 100));
      i.nextElementSibling!.textContent = String(Math.round(v * 100));
    });
    root.querySelector<HTMLInputElement>('input[data-k=muted]')!.checked = s.muted;
  };
  sync();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    root.classList.toggle('open');
    document.exitPointerLock?.();
  });
  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.addEventListener('pointerdown', () => root.classList.remove('open'));
  root.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((i) =>
    i.addEventListener('input', () => {
      engine.setSettings({ [i.dataset.k!]: Number(i.value) / 100 });
      sync();
    }),
  );
  root.querySelector<HTMLInputElement>('input[data-k=muted]')!.addEventListener('change', (e) => {
    engine.setSettings({ muted: (e.target as HTMLInputElement).checked });
    sync();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat) return;
    engine.setSettings({ muted: !engine.settings.muted });
    sync();
  });
}

/** Clicks and hovers on every button in the menus. */
export function installUiSounds(engine: AudioEngine): void {
  const target = (e: Event) => (e.target as HTMLElement | null)?.closest?.('button, select, input, .lm-node, .lm-skill, [data-sound]') as HTMLElement | null;
  document.addEventListener(
    'click',
    (e) => {
      const el = target(e);
      if (!el) return;
      const name = el.classList.contains('sm-play') ? 'ui.play' : el.matches('.sm-god, .sm-mode') ? 'ui.select' : 'ui.click';
      engine.play(name, { bus: 'ui', gain: name === 'ui.play' ? 0.9 : 0.8 }, 6, 0.03);
    },
    true,
  );
  let last: HTMLElement | null = null;
  document.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el === last) return;
    last = el;
    if (el && !el.matches('input')) engine.play('ui.hover', { bus: 'ui', gain: 0.6 }, 1, 0.04);
  });
}
