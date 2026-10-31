import type { Sim } from './Sim';
import type { SimEvent, Unit } from './Unit';

export interface GodLine {
  readonly unit: Unit;
  kills: number;
  deaths: number;
  assists: number;
  /** Damage dealt to gods. */
  godDamage: number;
  /** Damage dealt to everything else (monsters, minions, structures). */
  otherDamage: number;
  taken: number;
}

/** Per-god tallies for an end screen: takedowns, deaths, assists, damage dealt and taken. */
export class Scoreboard {
  readonly lines = new Map<Unit, GodLine>();

  constructor(sim: Sim) {
    sim.listeners.push((e) => this.on(e));
  }

  /** Give these gods a line now, so a god with a quiet match still shows. */
  track(units: readonly Unit[]): void {
    for (const u of units) this.line(u);
  }

  private line(u: Unit | null): GodLine | null {
    if (!u) return null;
    const g = u.owner ?? u;
    if (g.kind !== 'god') return null;
    let l = this.lines.get(g);
    if (!l) this.lines.set(g, (l = { unit: g, kills: 0, deaths: 0, assists: 0, godDamage: 0, otherDamage: 0, taken: 0 }));
    return l;
  }

  private on(e: SimEvent): void {
    if (e.type === 'damage') {
      if (e.amount <= 0) return;
      const src = this.line(e.source);
      if (src && e.source && (e.source.owner ?? e.source).team !== e.target.team) {
        if (e.target.kind === 'god') src.godDamage += e.amount;
        else src.otherDamage += e.amount;
      }
      if (e.target.kind === 'god') this.line(e.target)!.taken += e.amount;
    } else if (e.type === 'death' && e.unit.kind === 'god') {
      this.line(e.unit)!.deaths++;
      const k = this.line(e.killer);
      if (k && k.unit.team !== e.unit.team) k.kills++;
      for (const a of e.assists) {
        const l = this.line(a);
        if (l && l !== k) l.assists++;
      }
    }
  }

  /** Every god's line, the given team first, each team by damage dealt. */
  sorted(first: string): GodLine[] {
    return [...this.lines.values()].sort(
      (a, b) => Number(b.unit.team === first) - Number(a.unit.team === first) || b.godDamage + b.otherDamage - (a.godDamage + a.otherDamage),
    );
  }
}

/** The end screen's table: one row per god, the player's row marked. */
export function scoreTable(board: Scoreboard, me: Unit, cols: 'gods' | 'monsters'): string {
  const fmt = (n: number) => (n >= 10000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
  const head = cols === 'gods' ? '<th>K / D / A</th><th>Damage to gods</th><th>Taken</th>' : '<th>Deaths</th><th>Damage</th><th>Taken</th>';
  const rows = board
    .sorted(me.team)
    .map((l) => {
      const cls = [l.unit === me ? 'me' : '', l.unit.team === me.team ? 'ally' : 'foe'].join(' ');
      const cells =
        cols === 'gods'
          ? `<td>${l.kills} / ${l.deaths} / ${l.assists}</td><td>${fmt(l.godDamage)}</td><td>${fmt(l.taken)}</td>`
          : `<td>${l.deaths}</td><td>${fmt(l.godDamage + l.otherDamage)}</td><td>${fmt(l.taken)}</td>`;
      return `<tr class="${cls}"><td>${l.unit.name}${l.unit === me ? ' (you)' : ''}</td>${cells}</tr>`;
    })
    .join('');
  return `<table class="end-table"><tr><th></th>${head}</tr>${rows}</table>`;
}
