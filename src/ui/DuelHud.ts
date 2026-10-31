import type { Side } from '../game/combatant';
import { DUEL, type Duel } from '../sim/Duel';
import type { Boon } from '../sim/Siege';
import type { Unit } from '../sim/Unit';
import { addResult } from './records';
import { awardLine } from './ascension';
import './clash.css';

/** Temple Duel readout: round wins as pips, the round's state and the ring, and the result. */
export class DuelHud {
  private readonly root = document.createElement('div');
  private readonly pips: Record<Side, HTMLElement>;
  private readonly state: HTMLElement;
  private readonly big: HTMLElement;
  private readonly end: HTMLElement;
  private lastText = '';
  private lastBig = '';
  private lastPips = '';
  private shownEnd = false;
  private readonly foe: Side;
  private readonly cards: HTMLElement;
  private shownOffer: Duel['offer'] = null;
  private rivalBoons = 0;
  /** The rival's latest boon, called out in the round line for a few seconds. */
  private rivalNews = '';

  constructor(
    private readonly duel: Duel,
    private readonly me: Unit,
    private readonly rival: Unit,
    onPick: (i: number) => void = (i) => duel.choose(i),
  ) {
    this.foe = me.team === 'order' ? 'chaos' : 'order';
    this.root.className = 'clash duel';
    this.root.innerHTML = `
      <div class="clash-bar">
        <div class="clash-side ally"><span class="duel-name">You</span><div class="duel-pips"></div></div>
        <div class="clash-goal">FIRST TO ${DUEL.rounds}</div>
        <div class="clash-side foe"><div class="duel-pips"></div><span class="duel-name">${rival.name}</span></div>
      </div>
      <div class="clash-state"></div>
      <div class="duel-big"></div>
      <div class="siege-boons"></div>
      <div class="clash-end"><div class="clash-end-title"></div><div class="clash-end-score"></div><button class="clash-again">Play again</button></div>`;
    document.body.appendChild(this.root);
    this.pips = {
      [me.team]: this.root.querySelector('.ally .duel-pips')!,
      [this.foe]: this.root.querySelector('.foe .duel-pips')!,
    } as Record<Side, HTMLElement>;
    this.state = this.root.querySelector('.clash-state')!;
    this.big = this.root.querySelector('.duel-big')!;
    this.end = this.root.querySelector('.clash-end')!;
    this.cards = this.root.querySelector('.siege-boons')!;
    this.cards.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.siege-boon');
      if (card) onPick(Number(card.dataset.i));
    });
    this.root.querySelector('.clash-again')!.addEventListener('click', () => location.reload());
  }

  private boonCards(boons: readonly Boon[]): string {
    return (
      `<div class="siege-boons-title">You lost the round: choose a boon for the rest of the duel</div>` +
      boons.map((b, i) => `<div class="siege-boon" data-i="${i}"><kbd>${'ZXC'[i]}</kbd><b>${b.name}</b><span>${b.text}</span></div>`).join('')
    );
  }

  frame(): void {
    const d = this.duel;
    const mine = this.me.team as Side;
    const pips = `${d.wins.order}:${d.wins.chaos}`;
    if (pips !== this.lastPips) {
      this.lastPips = pips;
      for (const side of ['order', 'chaos'] as const) {
        this.pips[side].innerHTML = Array.from({ length: DUEL.rounds }, (_, i) => `<i class="${i < d.wins[side] ? 'on' : ''}"></i>`).join('');
      }
    }
    const offer = d.offer?.team === mine ? d.offer : null;
    if (offer !== this.shownOffer) {
      this.shownOffer = offer;
      this.cards.innerHTML = offer ? this.boonCards(offer.boons) : '';
      this.cards.classList.toggle('show', !!offer);
    }
    const theirs = d.boons[this.foe];
    if (theirs.length !== this.rivalBoons) {
      this.rivalBoons = theirs.length;
      const b = theirs[theirs.length - 1]!;
      this.rivalNews = `${this.rival.name} takes a boon: ${b.name} (${b.text})`;
    }
    if (d.phase === 'fight' && d.timer > 4) this.rivalNews = '';
    const text = this.rivalNews
      ? this.rivalNews
      : d.phase === 'fight'
        ? d.ringIn > 0
          ? `Round ${d.round} · the ring closes in ${Math.ceil(d.ringIn)}`
          : 'The ring of fire is closing!'
        : `Round ${d.round}`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.state.textContent = text;
      this.state.dataset.state = d.phase === 'fight' && d.ringIn <= 0 ? 'contested' : '';
    }
    const big =
      d.phase === 'countdown'
        ? String(Math.ceil(d.timer))
        : d.phase === 'fight' && d.timer < 1
          ? 'Fight!'
          : d.phase === 'pause'
            ? d.lastRound === null
              ? 'Draw: fight it again'
              : d.lastRound === mine
                ? 'You take the round'
                : `${this.rival.name} takes the round`
            : '';
    if (big !== this.lastBig) {
      this.lastBig = big;
      this.big.textContent = big;
      this.big.classList.toggle('show', big !== '');
      this.big.dataset.side = d.phase === 'pause' && d.lastRound ? (d.lastRound === mine ? 'ally' : 'foe') : '';
    }
    if (d.winner && !this.shownEnd) {
      this.shownEnd = true;
      const won = d.winner === mine;
      const { award } = addResult('duel', { won });
      this.end.querySelector('.clash-end-title')!.textContent = won ? 'Victory' : 'Defeat';
      this.end.querySelector('.clash-end-score')!.textContent = `Rounds ${d.wins[mine]} – ${d.wins[this.foe]} against ${this.rival.name}`;
      this.end.querySelector('.clash-end-score')!.insertAdjacentHTML('afterend', awardLine(award));
      this.end.classList.add('show', won ? 'won' : 'lost');
      document.exitPointerLock?.();
    }
  }
}
