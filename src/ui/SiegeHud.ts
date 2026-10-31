import { CHAMPION, SIEGE, type Siege } from '../sim/Siege';
import { scoreTable, type Scoreboard } from '../sim/Scoreboard';
import type { Unit } from '../sim/Unit';
import { addResult } from './records';
import { awardLine } from './ascension';
import './clash.css';

/** Temple Siege readout: the wave, what is left of it, the plaza's corruption, and the final tally. */
export class SiegeHud {
  private readonly root = document.createElement('div');
  private readonly wave: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly num: HTMLElement;
  private readonly state: HTMLElement;
  private readonly end: HTMLElement;
  private shownEnd = false;
  private lastText = '';
  private readonly curseEl: HTMLElement;
  private shownCurse: unknown = undefined;

  private readonly cards: HTMLElement;
  private shownOffer: unknown = null;

  constructor(
    private readonly siege: Siege,
    onPick: (i: number) => void,
    private readonly board?: Scoreboard,
    private readonly me?: Unit,
  ) {
    this.root.className = 'clash siege';
    this.root.innerHTML = `
      <div class="clash-bar">
        <div class="siege-wave"></div>
        <div class="clash-side foe"><div class="clash-track"><div class="clash-fill"></div></div><span class="clash-num"></span></div>
        <div class="clash-goal">CORRUPTION</div>
      </div>
      <div class="clash-state"></div>
      <div class="siege-curse"></div>
      <div class="siege-boons"></div>
      <div class="clash-end lost"><div class="clash-end-title">The temple falls</div><div class="clash-end-score"></div><div class="clash-end-table"></div><button class="clash-again">Play again</button></div>`;
    document.body.appendChild(this.root);
    this.wave = this.root.querySelector('.siege-wave')!;
    this.fill = this.root.querySelector('.clash-fill')!;
    this.num = this.root.querySelector('.clash-num')!;
    this.state = this.root.querySelector('.clash-state')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.cards = this.root.querySelector('.siege-boons')!;
    this.curseEl = this.root.querySelector('.siege-curse')!;
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
        : (s.onPlaza
          ? `${s.onPlaza} on the plaza! ${s.monsters.length} left`
          : `${s.monsters.length} monsters left`) + (s.spoils > 0 ? ` · Champion's spoils: +${Math.round(CHAMPION.damage * 100)}% damage ${Math.ceil(s.spoils)}` : s.champion?.alive ? ' · a Champion leads this wave' : '');
    if (text !== this.lastText) {
      this.lastText = text;
      this.state.textContent = text;
      this.state.dataset.state = s.phase === 'fight' && s.onPlaza ? 'chaos' : s.phase === 'break' ? 'order' : '';
    }
    const curse = s.phase === 'fallen' ? null : s.curse;
    if (curse !== this.shownCurse) {
      this.shownCurse = curse;
      this.curseEl.innerHTML = curse ? `<b>${curse.name}</b> ${curse.text}` : '';
      this.curseEl.classList.toggle('show', !!curse);
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
      const { best, award } = addResult('siege', { best: held });
      const record = held > best;
      this.end.querySelector('.clash-end-score')!.textContent =
        `You held ${held} ${held === 1 ? 'wave' : 'waves'} · ${s.kills} monsters slain · ${s.boons.length} boons · ${record ? 'new best!' : `best ${best}`}`;
      this.end.querySelector('.clash-end-score')!.insertAdjacentHTML('afterend', awardLine(award));
      if (this.board && this.me) this.end.querySelector('.clash-end-table')!.innerHTML = scoreTable(this.board, this.me, 'monsters');
      this.end.classList.add('show');
      document.exitPointerLock?.();
    }
  }
}
