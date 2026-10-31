import { SIEGE, type Siege } from '../sim/Siege';
import './clash.css';

const BEST_KEY = 'ascendant.siegeBest';

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Temple Siege readout: the wave, what is left of it, the plaza's corruption, and the final tally. */
export class SiegeHud {
  private readonly root = document.createElement('div');
  private readonly wave: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly num: HTMLElement;
  private readonly state: HTMLElement;
  private readonly end: HTMLElement;
  private readonly best = loadBest();
  private shownEnd = false;
  private lastText = '';

  private readonly cards: HTMLElement;
  private shownOffer: unknown = null;

  constructor(
    private readonly siege: Siege,
    onPick: (i: number) => void,
  ) {
    this.root.className = 'clash siege';
    this.root.innerHTML = `
      <div class="clash-bar">
        <div class="siege-wave"></div>
        <div class="clash-side foe"><div class="clash-track"><div class="clash-fill"></div></div><span class="clash-num"></span></div>
        <div class="clash-goal">CORRUPTION</div>
      </div>
      <div class="clash-state"></div>
      <div class="siege-boons"></div>
      <div class="clash-end lost"><div class="clash-end-title">The temple falls</div><div class="clash-end-score"></div><button class="clash-again">Play again</button></div>`;
    document.body.appendChild(this.root);
    this.wave = this.root.querySelector('.siege-wave')!;
    this.fill = this.root.querySelector('.clash-fill')!;
    this.num = this.root.querySelector('.clash-num')!;
    this.state = this.root.querySelector('.clash-state')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.cards = this.root.querySelector('.siege-boons')!;
    this.cards.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.siege-boon');
      if (card) onPick(Number(card.dataset.i));
    });
    this.root.querySelector('.clash-again')!.addEventListener('click', () => location.reload());
  }

  frame(): void {
    const s = this.siege;
    this.wave.textContent = s.wave ? `Wave ${s.wave}` : 'Prepare';
    this.fill.style.width = `${(s.corruption / SIEGE.max) * 100}%`;
    this.num.textContent = `${Math.floor(s.corruption)}%`;
    const text =
      s.phase === 'break'
        ? `Wave ${s.wave + 1}${(s.wave + 1) % 5 === 0 ? ' brings a boss' : ''} in ${Math.ceil(s.timer)}`
        : s.onPlaza
          ? `${s.onPlaza} on the plaza! ${s.monsters.length} left`
          : `${s.monsters.length} monsters left`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.state.textContent = text;
      this.state.dataset.state = s.phase === 'fight' && s.onPlaza ? 'chaos' : s.phase === 'break' ? 'order' : '';
    }
    if (s.offer !== this.shownOffer) {
      this.shownOffer = s.offer;
      this.cards.innerHTML = s.offer
        ? `<div class="siege-boons-title">Choose a boon for your team</div>` +
          s.offer
            .map((b, i) => `<div class="siege-boon" data-i="${i}"><kbd>${'ZXC'[i]}</kbd><b>${b.name}</b><span>${b.text}</span></div>`)
            .join('')
        : '';
      this.cards.classList.toggle('show', !!s.offer);
    }
    if (s.phase === 'fallen' && !this.shownEnd) {
      this.shownEnd = true;
      const held = s.held;
      const record = held > this.best;
      if (record) {
        try {
          localStorage.setItem(BEST_KEY, String(held));
        } catch {
          /* storage unavailable */
        }
      }
      this.end.querySelector('.clash-end-score')!.textContent =
        `You held ${held} ${held === 1 ? 'wave' : 'waves'} · ${s.kills} monsters slain · ${s.boons.length} boons · ${record ? 'new best!' : `best ${this.best}`}`;
      this.end.classList.add('show');
      document.exitPointerLock?.();
    }
  }
}
