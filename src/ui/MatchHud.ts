import type { Team } from '../game/combatant';
import { ConquestLayout as L } from '../map/ConquestLayout';
import { LANES, type Match } from '../sim/Match';
import { isStructure, type SimEvent, type Unit } from '../sim/Unit';
import { BUFF_GLOW } from '../combat/MonsterViews';
import { hex, TEAM_COLORS } from '../combat/palette';
import './match.css';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const MAP = 220;

/**
 * Conquest match HUD: the score and clock at the top, structure pips for both
 * sides, a minimap, the kill feed, big announcements, the Tab scoreboard and
 * the victory or defeat screen.
 */
export class MatchHud {
  readonly root: HTMLDivElement;
  private readonly kills: Record<Team, HTMLSpanElement>;
  private readonly clockText: HTMLSpanElement;
  private readonly wave: HTMLSpanElement;
  private readonly pips: Record<Team, HTMLDivElement>;
  private readonly titanBars: Record<Team, HTMLDivElement>;
  private readonly map: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement;
  private readonly feed: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly board: HTMLDivElement;
  private readonly end: HTMLDivElement;
  private bannerTime = 0;
  private firstBlood = false;
  private shown = false;

  constructor(
    private readonly match: Match,
    private player: Unit,
  ) {
    this.root = el('div', 'match-hud', document.body);
    const top = el('div', 'mh-top', this.root);
    const side = (team: Team) => {
      const box = el('div', `mh-side mh-${this.rel(team)}`, top);
      const k = el('span', 'mh-kills', box, '0');
      const pips = el('div', 'mh-pips', box);
      const titan = el('div', 'mh-titan', box, '<div></div>');
      return { k, pips, titan: titan.firstElementChild as HTMLDivElement };
    };
    // own side on the left, the enemy on the right
    const own = player.team;
    const other: Team = own === 'order' ? 'chaos' : 'order';
    const left = side(own);
    const mid = el('div', 'mh-mid', top);
    this.clockText = el('span', 'mh-clock', mid, '0:00');
    this.wave = el('span', 'mh-wave', mid);
    const right = side(other);
    this.kills = { [own]: left.k, [other]: right.k } as Record<Team, HTMLSpanElement>;
    this.pips = { [own]: left.pips, [other]: right.pips } as Record<Team, HTMLDivElement>;
    this.titanBars = { [own]: left.titan, [other]: right.titan } as Record<Team, HTMLDivElement>;
    for (const team of ['order', 'chaos'] as const) {
      for (const lane of LANES) {
        const group = el('div', 'mh-lane', this.pips[team]);
        group.title = lane;
        for (const tier of ['outer', 'inner', 'phoenix']) {
          const pip = el('i', `mh-pip mh-pip-${tier}`, group);
          pip.dataset.id = `${team}-${lane}-${tier}`;
        }
      }
    }

    const mapBox = el('div', 'mh-map', this.root);
    const canvas = el('canvas', '', mapBox);
    canvas.width = canvas.height = MAP * devicePixelRatio;
    this.map = canvas.getContext('2d')!;
    this.mapBase = this.drawBase();
    this.feed = el('div', 'mh-feed', this.root);
    this.banner = el('div', 'mh-banner', this.root);
    this.board = el('div', 'mh-board', this.root);
    this.end = el('div', 'mh-end', this.root);
  }

  setPlayer(u: Unit): void {
    this.player = u;
  }

  /** ally or enemy, from the player's side */
  private rel(team: Team): 'ally' | 'enemy' {
    return team === this.player.team ? 'ally' : 'enemy';
  }

  // -------------------------------------------------------------------------

  onEvent(e: SimEvent): void {
    if (e.type !== 'death') return;
    const v = e.unit;
    const k = e.killer;
    if (v.kind === 'god') {
      const who = (u: Unit | null) => (u ? `<b class="mh-${this.rel(u.team)}">${u === this.player ? 'You' : u.name}</b>` : 'the jungle');
      const killer = k && k.kind === 'god' ? who(k) : k ? `<b class="mh-${this.rel(k.team)}">${k.name}</b>` : 'the jungle';
      this.pushFeed(`${killer} <span>slew</span> ${who(v)}`);
      if (!this.firstBlood && k?.kind === 'god') {
        this.firstBlood = true;
        this.announce('First Blood', this.rel(k.team));
      } else if (v === this.player) this.announce('You have been slain', 'enemy');
    } else if (isStructure(v)) {
      const ours = v.team === this.player.team;
      const name = v.kind === 'titan' ? 'Titan' : v.kind === 'phoenix' ? 'Phoenix' : 'tower';
      this.announce(ours ? `Your ${name} has fallen` : `Enemy ${name} destroyed`, ours ? 'enemy' : 'ally');
      this.pushFeed(`<b class="mh-${this.rel(v.team)}">${ours ? 'Allied' : 'Enemy'} ${name}</b> <span>destroyed</span>`);
    }
  }

  frame(dt: number, units: readonly Unit[], scoreboard: boolean): void {
    const m = this.match;
    for (const team of ['order', 'chaos'] as const) {
      let kills = 0;
      for (const g of m.gods) if (g.team === team) kills += m.stats.get(g)!.kills;
      this.kills[team].textContent = String(kills);
      const titan = m.titans[team].combatant;
      this.titanBars[team].style.width = `${(titan.health / titan.stats.maxHealth) * 100}%`;
    }
    this.clockText.textContent = clock(m.time);
    this.wave.textContent = m.untilWave > 0 && m.untilWave < 10 ? `Minions in ${Math.ceil(m.untilWave)}` : '';
    for (const pip of this.root.querySelectorAll<HTMLElement>('.mh-pip')) {
      const s = m.structures.get(pip.dataset.id!);
      pip.classList.toggle('down', !!s && !s.alive);
    }
    if (this.bannerTime > 0) {
      this.bannerTime -= dt;
      if (this.bannerTime <= 0) this.banner.classList.remove('show');
    }
    this.drawMap(units);
    this.board.classList.toggle('show', scoreboard || !!m.winner);
    if (scoreboard || m.winner) this.fillBoard();
    if (m.winner && !this.shown) this.showEnd(m.winner);
  }

  private announce(text: string, side: 'ally' | 'enemy'): void {
    this.banner.className = `mh-banner show mh-${side}`;
    this.banner.textContent = text;
    this.bannerTime = 3;
  }

  private pushFeed(html: string): void {
    const row = el('div', 'mh-feed-row', this.feed, html);
    setTimeout(() => row.classList.add('out'), 7000);
    setTimeout(() => row.remove(), 7600);
    while (this.feed.children.length > 6) this.feed.firstElementChild!.remove();
  }

  // -------------------------------------------------------------------------
  // Minimap: north is the enemy base, so the player's lanes run upward.

  private toMap(x: number, z: number): [number, number] {
    const s = MAP / (L.halfExtent * 2);
    const f = this.player.team === 'order' ? 1 : -1;
    return [(-x * f + L.halfExtent) * s, (-z * f + L.halfExtent) * s];
  }

  private drawBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = MAP * devicePixelRatio;
    const g = c.getContext('2d')!;
    g.scale(devicePixelRatio, devicePixelRatio);
    const grad = g.createRadialGradient(MAP / 2, MAP / 2, 10, MAP / 2, MAP / 2, MAP * 0.7);
    grad.addColorStop(0, '#2f3a22');
    grad.addColorStop(1, '#141a10');
    g.fillStyle = grad;
    g.fillRect(0, 0, MAP, MAP);
    const line = (pts: readonly (readonly [number, number])[], width: number, color: string) => {
      g.beginPath();
      pts.forEach(([x, z], i) => {
        const [mx, my] = this.toMap(x, z);
        if (i) g.lineTo(mx, my);
        else g.moveTo(mx, my);
      });
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = g.lineJoin = 'round';
      g.stroke();
    };
    for (const p of L.paths) line(p.points, 2, 'rgba(140, 120, 80, 0.55)');
    for (const lane of L.lanes) line(lane.points, 6, 'rgba(214, 200, 168, 0.75)');
    for (const b of L.bases) {
      const [x, y] = this.toMap(b.plaza.at[0], b.plaza.at[1]);
      g.beginPath();
      g.arc(x, y, (b.plaza.radius / (L.halfExtent * 2)) * MAP, 0, Math.PI * 2);
      g.fillStyle = 'rgba(214, 200, 168, 0.55)';
      g.fill();
    }
    // side camps are drawn live; the boss pits stay fixed
    for (const camp of L.camps) {
      if (camp.team) continue;
      const [x, y] = this.toMap(camp.at[0], camp.at[1]);
      g.beginPath();
      g.arc(x, y, camp.team ? 2.5 : 4.5, 0, Math.PI * 2);
      g.fillStyle = camp.team ? 'rgba(200, 170, 90, 0.6)' : 'rgba(220, 130, 60, 0.8)';
      g.fill();
    }
    return c;
  }

  private drawMap(units: readonly Unit[]): void {
    const g = this.map;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.mapBase, 0, 0);
    g.scale(devicePixelRatio, devicePixelRatio);
    const color = (u: Unit) => (u === this.player ? TEAM_COLORS.self : TEAM_COLORS[this.rel(u.team)]);
    for (const u of units) {
      if (u.kind !== 'minion' || !u.alive) continue;
      const [x, y] = this.toMap(u.x, u.z);
      g.fillStyle = color(u);
      g.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
    }
    // jungle camps: lit while they stand, a dim ring while they grow back
    for (const c of this.match.jungle.camps) {
      const [x, y] = this.toMap(c.camp.at[0], c.camp.at[1]);
      const up = this.match.jungle.alive(c);
      const glow = BUFF_GLOW[c.camp.kind];
      const col = glow !== undefined ? hex(glow) : '#e6b25a';
      g.beginPath();
      g.arc(x, y, glow !== undefined ? 3.4 : 2.4, 0, Math.PI * 2);
      if (up) {
        g.fillStyle = col;
        g.fill();
        g.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      } else g.strokeStyle = 'rgba(200, 180, 140, 0.45)';
      g.lineWidth = 1;
      g.stroke();
    }
    for (const s of this.match.structures.values()) {
      const [x, y] = this.toMap(s.x, s.z);
      const r = s.kind === 'titan' ? 6 : s.kind === 'phoenix' ? 4.5 : 3.5;
      g.fillStyle = s.alive ? color(s) : '#555';
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.beginPath();
      if (s.kind === 'tower') g.rect(x - r, y - r, r * 2, r * 2);
      else g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    for (const u of this.match.gods) {
      if (!u.alive || (u.team !== this.player.team && u.stealth > 0)) continue;
      const [x, y] = this.toMap(u.x, u.z);
      g.beginPath();
      g.arc(x, y, u === this.player ? 5.5 : 4.5, 0, Math.PI * 2);
      g.fillStyle = color(u);
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = u === this.player ? '#fff' : '#000';
      g.stroke();
      g.fillStyle = '#000';
      g.font = 'bold 7px Georgia';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(u.name[0]!, x, y + 0.5);
    }
  }

  // -------------------------------------------------------------------------

  private fillBoard(): void {
    const m = this.match;
    const rows = (team: Team) =>
      m.gods
        .filter((g) => g.team === team)
        .map((g) => {
          const s = m.stats.get(g)!;
          const c = g.combatant;
          const dead = !g.alive ? `<em>${Math.ceil(c.respawnTimer)}s</em>` : '';
          return `<tr class="${g === this.player ? 'me' : ''}"><td class="god">${g.name}${g === this.player ? ' (you)' : ''}${dead}</td><td>${c.level}</td><td>${s.kills} / ${s.deaths} / ${s.assists}</td><td>${s.minions}</td><td>${s.structures}</td><td>${Math.round(s.damage / 100) / 10}k</td></tr>`;
        })
        .join('');
    const table = (team: Team) =>
      `<div class="mh-team mh-${this.rel(team)}"><h3>${team === 'order' ? 'Order' : 'Chaos'}</h3><table><thead><tr><th>God</th><th>Lvl</th><th>K / D / A</th><th>Minions</th><th>Structures</th><th>Damage</th></tr></thead><tbody>${rows(team)}</tbody></table></div>`;
    const mine = this.player.team;
    this.board.innerHTML = table(mine) + table(mine === 'order' ? 'chaos' : 'order');
  }

  private showEnd(winner: Team): void {
    this.shown = true;
    const won = winner === this.player.team;
    this.end.innerHTML = `<div class="mh-end-title ${won ? 'win' : 'loss'}">${won ? 'Victory' : 'Defeat'}</div><div class="mh-end-sub">${won ? 'The enemy Titan has fallen' : 'Your Titan has fallen'} &middot; ${clock(this.match.time)}</div><button class="mh-again">Play again</button>`;
    // the final scoreboard sits between the title and the button
    this.end.insertBefore(this.board, this.end.querySelector('button'));
    this.end.classList.add('show');
    this.end.querySelector('button')!.addEventListener('click', () => location.reload());
    document.exitPointerLock?.();
  }
}
