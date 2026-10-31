import type { Side } from '../game/combatant';
import { CLASH, type Clash } from '../sim/Clash';
import { scoreTable, type Scoreboard } from '../sim/Scoreboard';
import type { Unit } from '../sim/Unit';
import './clash.css';

const PLAZA_TEXT: Record<string, string> = {
  neutral: 'Plaza empty: stand on it to score',
  contested: 'Contested',
  order: 'Your team holds the plaza',
  chaos: 'Enemies hold the plaza',
};

/** Temple Clash scoreboard: both scores racing to the target, who holds the plaza, and the result. */
export class ClashHud {
  private readonly root = document.createElement('div');
  private readonly fill: Record<Side, HTMLElement>;
  private readonly num: Record<Side, HTMLElement>;
  private readonly state: HTMLElement;
  private readonly end: HTMLElement;
  private readonly bless: HTMLElement;
  private lastBless = '';
  private shownEnd = false;
  private lastPlaza = '';

  constructor(
    private readonly clash: Clash,
    private readonly mine: Side,
    private readonly board?: Scoreboard,
    private readonly me?: Unit,
  ) {
    this.root.className = 'clash';
    this.root.innerHTML = `
      <div class="clash-bar">
        <div class="clash-side ally"><span class="clash-num"></span><div class="clash-track"><div class="clash-fill"></div></div></div>
        <div class="clash-goal">${CLASH.target}</div>
        <div class="clash-side foe"><div class="clash-track"><div class="clash-fill"></div></div><span class="clash-num"></span></div>
      </div>
      <div class="clash-state"></div>
      <div class="clash-bless"></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><div class="clash-end-table"></div><button class="clash-again">Play again</button></div>`;
    document.body.appendChild(this.root);
    const ally = this.root.querySelector('.ally')!;
    const foe = this.root.querySelector('.foe')!;
    const enemy: Side = mine === 'order' ? 'chaos' : 'order';
    this.fill = { [mine]: ally.querySelector('.clash-fill')!, [enemy]: foe.querySelector('.clash-fill')! } as Record<Side, HTMLElement>;
    this.num = { [mine]: ally.querySelector('.clash-num')!, [enemy]: foe.querySelector('.clash-num')! } as Record<Side, HTMLElement>;
    this.state = this.root.querySelector('.clash-state')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.bless = this.root.querySelector('.clash-bless')!;
    this.root.querySelector('.clash-again')!.addEventListener('click', () => location.reload());
  }

  frame(): void {
    const c = this.clash;
    for (const side of ['order', 'chaos'] as const) {
      this.fill[side].style.width = `${(c.score[side] / CLASH.target) * 100}%`;
      this.num[side].textContent = String(Math.floor(c.score[side]));
    }
    const plaza = c.plaza === 'order' || c.plaza === 'chaos' ? (c.plaza === this.mine ? 'order' : 'chaos') : c.plaza;
    if (plaza !== this.lastPlaza) {
      this.lastPlaza = plaza;
      this.state.textContent = PLAZA_TEXT[plaza]!;
      this.state.dataset.state = plaza;
    }
    const b = c.blessing;
    const bless = b > 0 ? `Temple's blessing: double points · ${Math.ceil(b)}` : c.blessingIn <= 10 ? `Blessing in ${Math.ceil(c.blessingIn)}` : '';
    if (bless !== this.lastBless) {
      this.lastBless = bless;
      this.bless.textContent = bless;
      this.bless.classList.toggle('on', b > 0);
      this.bless.classList.toggle('show', bless !== '');
    }
    if (c.winner && !this.shownEnd) {
      this.shownEnd = true;
      const won = c.winner === this.mine;
      this.end.querySelector('.clash-end-title')!.textContent = won ? 'Victory' : 'Defeat';
      const enemy: Side = this.mine === 'order' ? 'chaos' : 'order';
      this.end.querySelector('.clash-end-score')!.textContent = `${Math.floor(c.score[this.mine])} – ${Math.floor(c.score[enemy])} · takedowns ${c.kills[this.mine]} – ${c.kills[enemy]}`;
      if (this.board && this.me) this.end.querySelector('.clash-end-table')!.innerHTML = scoreTable(this.board, this.me, 'gods');
      this.end.classList.add('show', won ? 'won' : 'lost');
      document.exitPointerLock?.();
    }
  }
}
