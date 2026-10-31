import type { Unit } from '../sim/Unit';

export interface KillBanner {
  title: string;
  sub: string;
  /** 'epic' for the player's own takedowns, else whose side the news is good for. */
  side: 'ally' | 'enemy' | 'epic';
}

/**
 * Kill streaks, multi-kills and first blood, shared by every mode's HUD. Feed it
 * each god's death; it answers with the banner to show, if any.
 */
export class KillTally {
  private readonly streaks = new Map<Unit, number>();
  private multi = { count: 0, until: 0 };
  private firstBlood = false;

  constructor(private readonly me: () => Unit) {}

  private get player(): Unit {
    return this.me();
  }

  streak(u: Unit): number {
    return this.streaks.get(u) ?? 0;
  }

  /** A god died at `now` seconds. */
  onGodDeath(victim: Unit, killer: Unit | null, now: number): KillBanner | null {
    const ended = this.streak(victim);
    this.streaks.set(victim, 0);
    const byGod = killer?.kind === 'god' && killer !== victim;
    if (byGod) this.streaks.set(killer, this.streak(killer) + 1);
    const first = !this.firstBlood && byGod;
    if (first) this.firstBlood = true;
    if (killer === this.player) return this.celebrate(first, ended, now);
    if (first) return { title: 'First Blood', sub: '', side: killer!.team === this.player.team ? 'ally' : 'enemy' };
    if (victim === this.player) return { title: 'You have been slain', sub: ended >= 3 ? `Your ${ended} kill streak ended` : '', side: 'enemy' };
    return null;
  }

  /** The player's own kill: the biggest thing it achieved gets the banner, the streak goes underneath. */
  private celebrate(first: boolean, ended: number, now: number): KillBanner {
    this.multi.count = now < this.multi.until ? this.multi.count + 1 : 1;
    this.multi.until = now + 10;
    const streak = this.streak(this.player);
    const multi = ['', '', 'Double Kill', 'Triple Kill', 'Quadruple Kill', 'Ascendant'][Math.min(5, this.multi.count)]!;
    const title = multi || (first ? 'First Blood' : ended >= 3 ? 'Shutdown' : streak >= 7 ? 'Godlike' : streak === 5 ? 'Unstoppable' : streak === 3 ? 'Rampage' : 'Enemy Slain');
    const sub = [ended >= 3 ? (title === 'Shutdown' ? `Ended a ${ended} kill streak` : 'Shutdown') : '', streak >= 2 ? `${streak} kill streak` : ''].filter(Boolean).join(' · ');
    return { title, sub, side: 'epic' };
  }
}
