import type { GodDef } from '../game/types';
import { compatibilityMode, setCompatibilityMode } from './Fatal';
import { skillIcon } from './icons';
import './start.css';

export type GameMode = 'conquest' | 'arena';

export interface StartChoice {
  mode: GameMode;
  god: string;
}

const STORAGE_KEY = 'ascendant.start';

const MODES: { id: GameMode; name: string; text: string }[] = [
  { id: 'conquest', name: 'Conquest', text: '5v5 against bots on the three-lane map. Destroy the enemy Titan to win. About 15–20 minutes.' },
  { id: 'arena', name: 'Training ground', text: 'The temple with training posts and one enemy Thor. Free god swaps and level shortcuts in the K menu.' },
];

const ROLE_NAMES: Record<string, string> = { solo: 'Solo', jungle: 'Jungle', mid: 'Mid', carry: 'Carry', support: 'Support' };

/** The controls, shared by the start screen and the in-game help (H). */
export const CONTROLS: [string, string][] = [
  ['Click', 'Capture the mouse and play'],
  ['W A S D', 'Move'],
  ['Mouse', 'Aim (the camera follows)'],
  ['Left click', 'Basic attack'],
  ['1  2  3  4', 'Skills: press to aim, press again or click to cast, right click cancels'],
  ['R', 'Ultimate (unlocks at level 5)'],
  ['B', 'Recall to the fountain'],
  ['K', 'Skills & trees: spend points; swap skills at the fountain'],
  ['Tab (hold)', 'Scoreboard'],
  ['Wheel', 'Camera zoom'],
  ['H', 'Show or hide this help'],
  ['M', 'Mute or unmute sound'],
  ['Esc', 'Release the mouse'],
];

export function controlsHtml(): string {
  return `<div class="sm-controls">${CONTROLS.map(([k, v]) => `<div class="sm-key">${k}</div><div>${v}</div>`).join('')}</div>`;
}

function load(): Partial<StartChoice> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<StartChoice>;
  } catch {
    return {};
  }
}

function save(c: StartChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

/**
 * The title screen: pick a mode and a god, read the controls, press Play.
 * Shown over the loading screen while textures and models load behind it.
 */
export function showStartMenu(gods: readonly GodDef[], webgpu: Promise<boolean>): Promise<StartChoice> {
  const prev = load();
  let mode: GameMode = prev.mode === 'arena' ? 'arena' : 'conquest';
  let god = gods.some((g) => g.id === prev.god) ? prev.god! : gods[0]!.id;

  const root = document.createElement('div');
  root.className = 'sm';
  root.innerHTML = `
    <div class="sm-panel">
      <div class="sm-title">ASCENDANT</div>
      <div class="sm-cols">
        <div class="sm-col">
          <h3>Mode</h3>
          <div class="sm-modes">${MODES.map((m) => `<button class="sm-mode" data-mode="${m.id}"><b>${m.name}</b><span>${m.text}</span></button>`).join('')}</div>
          <h3>Controls</h3>
          ${controlsHtml()}
        </div>
        <div class="sm-col">
          <h3>God</h3>
          <div class="sm-gods">${gods.map((g) => `<button class="sm-god" data-god="${g.id}"><b>${g.name}</b><span>${ROLE_NAMES[g.role] ?? g.role} &middot; ${g.attackRange}</span></button>`).join('')}</div>
          <div class="sm-detail"></div>
        </div>
      </div>
      <div class="sm-foot">
        <span class="sm-note"></span>
        <button class="sm-play">Play</button>
      </div>
    </div>`;
  document.body.appendChild(root);

  const detail = root.querySelector<HTMLDivElement>('.sm-detail')!;
  const render = () => {
    root.querySelectorAll<HTMLButtonElement>('.sm-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    root.querySelectorAll<HTMLButtonElement>('.sm-god').forEach((b) => b.classList.toggle('on', b.dataset.god === god));
    const def = gods.find((g) => g.id === god)!;
    const skills = def.defaultLoadout.map((id) => def.skills.find((s) => s.id === id)!);
    const keys = ['1', '2', '3', '4', 'R'];
    detail.innerHTML = `
      <div class="sm-name">${def.name} <span>${def.title} &middot; ${def.pantheon}</span></div>
      <div class="sm-passive"><b>${def.passive.name}</b> (passive): ${def.passive.description}</div>
      <div class="sm-skills">${skills
        .map((s, i) => `<div class="sm-skill" title="${s.description.replace(/"/g, '&quot;')}"><div class="sm-ico">${skillIcon(def.id, s)}</div><div class="sm-k">${keys[i]}</div><div class="sm-sn">${s.name}</div></div>`)
        .join('')}</div>
      <div class="sm-tip">${mode === 'conquest' ? 'You start in mid lane with four allied bots; the other four gods fill solo, duo and jungle. Go wherever you like.' : 'Swap gods and jump levels from the K menu while standing at the fountain.'} Swap skills from the pool and spend tree points with K at your fountain.</div>`;
  };
  render();

  root.querySelectorAll<HTMLButtonElement>('.sm-mode').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as GameMode;
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('.sm-god').forEach((b) =>
    b.addEventListener('click', () => {
      god = b.dataset.god!;
      render();
    }),
  );

  const note = root.querySelector<HTMLSpanElement>('.sm-note')!;
  void webgpu.then((gpu) => {
    const forced = compatibilityMode();
    note.innerHTML = gpu
      ? 'Running on WebGPU. Black screen or glitches? <button class="sm-compat">Use compatibility mode</button>'
      : forced
        ? 'Compatibility mode (WebGL 2). <button class="sm-compat">Switch to WebGPU</button>'
        : 'WebGPU is unavailable, so the game uses WebGL 2. Chrome or Edge on a recent GPU runs best.';
    note.querySelector('.sm-compat')?.addEventListener('click', () => setCompatibilityMode(!forced));
  });

  return new Promise((resolve) => {
    const play = root.querySelector<HTMLButtonElement>('.sm-play')!;
    play.addEventListener('click', () => {
      const choice = { mode, god };
      save(choice);
      root.classList.add('done');
      setTimeout(() => root.remove(), 400);
      resolve(choice);
    });
  });
}
