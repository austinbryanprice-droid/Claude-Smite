import { SLOT_KEYS } from '../game/loadout';
import type { GodDef } from '../game/types';
import { compatibilityMode, setCompatibilityMode } from './Fatal';
import type { GpuAdvice } from '../render/gpuAdvice';
import { skillIcon } from './icons';
import { mountLobby } from '../net/LobbyPanel';
import type { NetSession } from '../net/Session';
import './start.css';

export type GameMode = 'conquest' | 'arena';

export interface StartChoice {
  mode: GameMode;
  god: string;
  /** A multiplayer Conquest match (the lobby's players and connections). */
  net?: NetSession;
}

const STORAGE_KEY = 'ascendant.start';

const MODES: { id: GameMode; name: string; text: string }[] = [
  { id: 'conquest', name: 'Conquest', text: '5v5 against bots. Destroy the enemy Titan to win. About 15–20 minutes.' },
  { id: 'arena', name: 'Training ground', text: 'Training posts and one enemy Thor. Swap gods and levels freely with K.' },
];

const ROLE_NAMES: Record<string, string> = { solo: 'Solo', jungle: 'Jungle', mid: 'Mid', carry: 'Carry', support: 'Support' };

/** The controls, shared by the start screen and the in-game help (H). */
export const CONTROLS: [string, string][] = [
  ['Click', 'Capture the mouse and play'],
  ['W A S D', 'Move'],
  ['Mouse', 'Aim (the camera follows)'],
  ['Left click', 'Basic attack'],
  ['1  2  3', 'Skills: press to aim, press again or click to cast, right click cancels'],
  ['4 or R', 'Ultimate (unlocks at level 5)'],
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

/** The mode the title screen opens with: the last one played, Conquest at first. */
export function savedMode(): GameMode {
  return load().mode === 'arena' ? 'arena' : 'conquest';
}

function save(c: StartChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable */
  }
}

/** A warning under the title, where it can't be missed. */
function showWarning(root: HTMLElement, content: string | HTMLElement): HTMLDivElement {
  const warn = document.createElement('div');
  warn.className = 'sm-warn';
  warn.append(content);
  root.querySelector('.sm-title')!.after(warn);
  return warn;
}

/** The slow-GPU warning: what's wrong, then numbered steps to fix it. */
function gpuWarning(advice: GpuAdvice): HTMLElement {
  const box = document.createElement('div');
  const text = document.createElement('div');
  text.textContent = advice.text;
  const steps = document.createElement('ol');
  for (const step of advice.steps) steps.appendChild(document.createElement('li')).textContent = step;
  box.append(text, steps);
  if (advice.copy) {
    // browsers refuse links to their own settings pages, so offer the text instead
    const copy = document.createElement('button');
    copy.className = 'sm-compat';
    copy.textContent = 'Copy flag address';
    copy.addEventListener('click', () => {
      // (a refused clipboard leaves the address in the steps to copy by hand)
      navigator.clipboard?.writeText(advice.copy!).then(() => (copy.textContent = 'Copied: paste it in the address bar'), () => (copy.textContent = 'Copy it from the steps above'));
    });
    box.appendChild(copy);
  }
  return box;
}

interface BatteryManager extends EventTarget {
  readonly charging: boolean;
}

/** Calls `then` if this is a laptop running on battery (Chromium reports it; other browsers don't). */
async function onBattery(then: (battery: BatteryManager) => void): Promise<void> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
  try {
    const battery = await nav.getBattery?.();
    if (battery && !battery.charging) then(battery);
  } catch {
    /* not allowed here */
  }
}

/**
 * The title screen: pick a mode and a god, read the controls, press Play.
 * Shown over the loading screen while textures and models load behind it.
 */
/** What the title screen says about the graphics setup. */
export interface GraphicsInfo {
  webgpu: boolean;
  advice: GpuAdvice | null;
}

export function showStartMenu(gods: readonly GodDef[], graphics: Promise<GraphicsInfo>): Promise<StartChoice> {
  const prev = load();
  let mode = savedMode();
  let god = gods.some((g) => g.id === prev.god) ? prev.god! : gods[0]!.id;

  const root = document.createElement('div');
  root.className = 'sm';
  root.innerHTML = `
    <div class="sm-panel">
      <div class="sm-title">ASCENDANT</div>
      <div class="sm-gods">${gods.map((g) => `<button class="sm-god" data-god="${g.id}"><img src="${import.meta.env.BASE_URL}portraits/${g.id}.jpg" alt="" onerror="this.remove()"><span class="sm-face"><b>${g.name}</b><span>${ROLE_NAMES[g.role] ?? g.role} &middot; ${g.attackRange}</span></span></button>`).join('')}</div>
      <div class="sm-cols">
        <div class="sm-col">
          <h3>Mode</h3>
          <div class="sm-modes">${MODES.map((m) => `<button class="sm-mode" data-mode="${m.id}"><b>${m.name}</b><span>${m.text}</span></button>`).join('')}</div>
          <div class="sm-detail"></div>
          <h3 class="help-gap">Play with friends</h3>
          <div class="sm-net"></div>
        </div>
        <div class="sm-col">
          <h3>Controls</h3>
          ${controlsHtml()}
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
    const keys = SLOT_KEYS;
    detail.innerHTML = `
      <div class="sm-name">${def.name} <span>${def.title} &middot; ${def.pantheon}</span></div>
      <div class="sm-passive"><b>${def.passive.name}</b> (passive): ${def.passive.description}</div>
      <div class="sm-skills">${skills
        .map((s, i) => `<div class="sm-skill" title="${s.description.replace(/"/g, '&quot;')}"><div class="sm-ico">${skillIcon(def.id, s)}</div><div class="sm-k">${keys[i]}</div><div class="sm-sn">${s.name}</div></div>`)
        .join('')}</div>
      <div class="sm-tip">${mode === 'conquest' ? 'You start mid with four allied bots in the other lanes. Go wherever you like.' : 'Swap gods and jump levels with K at the fountain.'} Press K at your fountain to swap skills and spend tree points.</div>`;
  };
  render();

  root.querySelectorAll<HTMLButtonElement>('.sm-mode').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as GameMode;
      render();
    }),
  );
  const play = root.querySelector<HTMLButtonElement>('.sm-play')!;
  let started: ((c: StartChoice) => void) | null = null;
  const lobby = mountLobby(root.querySelector<HTMLDivElement>('.sm-net')!, {
    god: () => god,
    inLobby: (on) => play.classList.toggle('held', on),
    onStart: (net) => started?.({ mode: 'conquest', god: net.self()?.god ?? god, net }),
  });
  root.querySelectorAll<HTMLButtonElement>('.sm-god').forEach((b) =>
    b.addEventListener('click', () => {
      god = b.dataset.god!;
      render();
      lobby.godChanged();
    }),
  );

  const note = root.querySelector<HTMLSpanElement>('.sm-note')!;
  void graphics.then(({ webgpu, advice }) => {
    const forced = compatibilityMode();
    note.innerHTML = webgpu
      ? 'Running on WebGPU. Black screen or glitches? <button class="sm-compat">Use compatibility mode</button>'
      : forced
        ? 'Compatibility mode (WebGL 2). <button class="sm-compat">Switch to WebGPU</button>'
        : 'WebGPU is unavailable, so the game uses WebGL 2. Chrome or Edge on a recent GPU runs best.';
    note.querySelector('.sm-compat')?.addEventListener('click', () => setCompatibilityMode(!forced));
    if (advice) showWarning(root, gpuWarning(advice));
  });
  void onBattery((battery) => {
    const warn = showWarning(root, 'Your laptop is on battery. Plug it in for a smooth game: on battery Windows and the browser slow the graphics card down.');
    battery.addEventListener('chargingchange', () => warn.classList.toggle('gone', battery.charging));
  });

  return new Promise((resolve) => {
    const finish = (choice: StartChoice) => {
      save({ mode: choice.mode, god: choice.god });
      root.classList.add('done');
      setTimeout(() => root.remove(), 400);
      resolve(choice);
    };
    started = finish;
    play.addEventListener('click', () => finish({ mode, god }));
  });
}
