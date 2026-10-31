import { ULTIMATE_SLOT } from '../game/loadout';
import type { Unit } from '../sim/Unit';
import './coach.css';

const SEEN_KEY = 'ascendant.coachSeen';

/** What the coach looks at each check. */
export interface CoachView {
  alive: boolean;
  healthPct: number;
  unspentPoints: number;
  ultReady: boolean;
  inBase: boolean;
  /** The player has died at least once and is back. */
  respawned: boolean;
  menuOpen: boolean;
  /** Modes without a fountain to run back to (Temple Duel) skip the fountain tips. */
  fountain: boolean;
}

export interface Tip {
  id: string;
  text: string;
  when: (v: CoachView) => boolean;
}

/**
 * One-time tips for new players, each shown the first moment it matters and
 * never again. Order is priority: the first tip whose moment has come wins.
 */
export const TIPS: readonly Tip[] = [
  { id: 'death', text: 'You will be back in a few seconds. Spend skill points with <kbd>K</kbd> while you wait.', when: (v) => !v.alive },
  { id: 'points', text: 'You have a skill point! Press <kbd>K</kbd> to grow your skill trees and change how your god fights.', when: (v) => v.alive && v.unspentPoints > 0 && !v.menuOpen },
  { id: 'ult', text: 'Your ultimate is ready: press <kbd>4</kbd> or <kbd>R</kbd>.', when: (v) => v.alive && v.ultReady },
  { id: 'lowhp', text: 'Low on health? Step back to your fountain: it heals you fast.', when: (v) => v.fountain && v.alive && v.healthPct < 0.3 && !v.inBase },
  { id: 'swap', text: 'At the fountain you can swap which skills sit on your bar: open <kbd>K</kbd>.', when: (v) => v.fountain && v.alive && v.inBase && v.respawned && !v.menuOpen },
];

/** The tip to show now, if any, given the ones already seen. */
export function pickTip(v: CoachView, seen: ReadonlySet<string>): Tip | null {
  return TIPS.find((t) => !seen.has(t.id) && t.when(v)) ?? null;
}

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Shows the tips: one at a time, for a few seconds each, checked four times a second. */
export class Coach {
  private readonly el = document.createElement('div');
  private readonly seen = loadSeen();
  private showing = 0;
  private gap = 3;
  private check = 0;
  private died = false;

  constructor(
    private readonly player: Unit,
    private readonly menuOpen: () => boolean,
    private readonly fountain = true,
  ) {
    this.el.className = 'coach';
    document.body.appendChild(this.el);
  }

  frame(dt: number): void {
    if (this.showing > 0) {
      this.showing -= dt;
      if (this.showing <= 0) this.el.classList.remove('show');
      return;
    }
    this.gap -= dt;
    this.check -= dt;
    if (this.gap > 0 || this.check > 0) return;
    this.check = 0.25;
    const c = this.player.combatant;
    if (!c.alive) this.died = true;
    const tip = pickTip(
      {
        alive: c.alive,
        healthPct: c.health / c.stats.maxHealth,
        unspentPoints: c.unspentPoints,
        ultReady: c.canCast(ULTIMATE_SLOT) === null,
        inBase: c.inBase,
        respawned: this.died && c.alive,
        menuOpen: this.menuOpen(),
        fountain: this.fountain,
      },
      this.seen,
    );
    if (!tip) return;
    this.seen.add(tip.id);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...this.seen]));
    } catch {
      /* storage unavailable: tips may show again next time */
    }
    this.el.innerHTML = tip.text;
    this.el.classList.add('show');
    this.showing = 6;
    this.gap = 4;
  }
}
