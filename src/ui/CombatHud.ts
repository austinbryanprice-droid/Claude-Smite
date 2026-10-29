import { BUFF_GLOW } from '../combat/MonsterViews';
import { BUFF_DURATION, BUFF_KINDS, BUFFS, buffMark, FURY_DURATION, isBoss, isBuff, MonsterBrain, type BuffKind } from '../sim/Jungle';
import * as THREE from 'three/webgpu';
import { SLOT_KEYS, ULTIMATE_SLOT } from '../game/loadout';
import { MAX_LEVEL } from '../game/progression';
import type { CCKind } from '../game/types';
import { RECALL_TIME } from '../sim/Sim';
import { isStructure, type SimEvent, type Unit } from '../sim/Unit';
import { hex, TEAM_COLORS } from '../combat/palette';
import { skillIcon } from './icons';
import './combat.css';

const CC_LABEL: Partial<Record<CCKind, string>> = {
  stun: 'Stunned',
  root: 'Rooted',
  silence: 'Silenced',
  disarm: 'Disarmed',
  fear: 'Feared',
  taunt: 'Taunted',
  mesmerize: 'Mesmerized',
  disorient: 'Disoriented',
  knockup: 'Knocked up',
  knockback: 'Knocked back',
  pull: 'Pulled',
  grab: 'Grabbed',
  banish: 'Banished',
  polymorph: 'Polymorphed',
  slow: 'Slowed',
  cripple: 'Crippled',
  blind: 'Blinded',
  intoxicate: 'Intoxicated',
};

interface Bar {
  el: HTMLDivElement;
  hp: HTMLDivElement;
  /** Recent damage: a pale strip that drains after the health fill. */
  lag: HTMLDivElement;
  lagPct: number;
  shield: HTMLDivElement;
  level: HTMLSpanElement;
  name: HTMLSpanElement;
  marks: HTMLSpanElement;
}

interface Floater {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  age: number;
  drift: number;
}

/** Original epithets for the jungle's big monsters, shown on the objective bar. */
const EPITHET: Record<string, string> = {
  treasureWyrm: 'Coiled Keeper of the Hoard',
  moltenColossus: 'Heart of the Sunken Forge',
};
const SPECIAL_NAME: Record<string, string> = { treasureWyrm: 'Tail Sweep', moltenColossus: 'Eruption' };
const OBJECTIVE_COLOR: Record<string, string> = { treasureWyrm: '#f5c542', moltenColossus: '#ff6a1a' };
/** The objective bar shows the nearest boss or Warden within this range of the player. */
const OBJECTIVE_RANGE = 38;

/** Drain a lagging damage strip toward the real value, quickly at first. */
const drain = (lag: number, pct: number, dt: number): number => (pct >= lag ? pct : Math.max(pct, lag - Math.max(0.04, (lag - pct) * 2.5) * dt));

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

/**
 * In-match HUD: the player's frame and ability bar (Smite layout, bottom
 * center), overhead health bars, floating damage numbers, crowd-control and
 * recall readouts, and the death screen. Plain DOM over the canvas.
 */
export class CombatHud {
  readonly root: HTMLDivElement;
  private readonly slots: { tile: HTMLDivElement; icon: HTMLDivElement; cd: HTMLDivElement; cdText: HTMLSpanElement; cost: HTMLSpanElement; lock: HTMLSpanElement; skillId: string }[] = [];
  private readonly hpFill: HTMLDivElement;
  private readonly hpShield: HTMLDivElement;
  private readonly hpText: HTMLSpanElement;
  private readonly manaFill: HTMLDivElement;
  private readonly manaText: HTMLSpanElement;
  private readonly levelText: HTMLSpanElement;
  private readonly xpRing: SVGCircleElement;
  private readonly points: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly buffs: HTMLDivElement;
  private buffKey = '';
  private readonly recall: HTMLDivElement;
  private readonly recallFill: HTMLDivElement;
  private readonly death: HTMLDivElement;
  private readonly deathTimer: HTMLSpanElement;
  private readonly toastBox: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly bars = new Map<Unit, Bar>();
  /** The big bar under the scoreboard for a boss or Warden the player is near. */
  private readonly objective: { root: HTMLDivElement; name: HTMLDivElement; hp: HTMLDivElement; lag: HTMLDivElement; pct: HTMLSpanElement; cast: HTMLDivElement; castFill: HTMLDivElement };
  private objectiveUnit: Unit | null = null;
  private target: Unit | null = null;
  private objectiveLag = 1;
  private readonly floaters: Floater[] = [];
  private readonly v = new THREE.Vector3();
  private loadoutKey = '';

  /** Red screen edges: pulse on damage taken, linger at low health. */
  private readonly vignette: HTMLElement;
  private hurt = 0;

  constructor(
    private player: Unit,
    private readonly camera: THREE.Camera,
    private readonly headOf: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null,
  ) {
    this.root = el('div', 'combat-hud', document.body);
    this.vignette = el('div', 'ch-vignette', this.root);
    this.overlay = el('div', 'ch-overlay', this.root);

    const frame = el('div', 'ch-frame', this.root);
    this.buffs = el('div', 'ch-buffs', frame);
    const top = el('div', 'ch-frame-top', frame);
    const badge = el('div', 'ch-level', top, `<svg viewBox="0 0 44 44"><circle class="ch-level-track" cx="22" cy="22" r="19"/><circle class="ch-level-xp" cx="22" cy="22" r="19"/></svg><span></span>`);
    this.levelText = badge.querySelector('span')!;
    this.xpRing = badge.querySelector('.ch-level-xp')!;
    const bars = el('div', 'ch-bars', top);
    const hp = el('div', 'ch-res ch-hp', bars);
    this.hpFill = el('div', 'ch-res-fill', hp);
    this.hpShield = el('div', 'ch-res-shield', hp);
    this.hpText = el('span', 'ch-res-text', hp);
    const mana = el('div', 'ch-res ch-mana', bars);
    this.manaFill = el('div', 'ch-res-fill', mana);
    this.manaText = el('span', 'ch-res-text', mana);

    const row = el('div', 'ch-abilities', frame);
    for (let i = 0; i < 5; i++) {
      const tile = el('div', `ch-slot${i === ULTIMATE_SLOT ? ' ch-ult' : ''}`, row);
      const icon = el('div', 'ch-icon', tile);
      const cd = el('div', 'ch-cd', tile);
      const cdText = el('span', 'ch-cd-text', tile);
      el('span', 'ch-key', tile, SLOT_KEYS[i]);
      const cost = el('span', 'ch-cost', tile);
      const lock = el('span', 'ch-lock', tile);
      this.slots.push({ tile, icon, cd, cdText, cost, lock, skillId: '' });
    }
    this.points = el('div', 'ch-points', frame);

    this.status = el('div', 'ch-status', this.root);
    this.recall = el('div', 'ch-recall', this.root, '<span>Recalling</span>');
    this.recallFill = el('div', 'ch-recall-fill', this.recall);
    this.death = el('div', 'ch-death', this.root, '<div class="ch-death-title">Slain</div><div>Returning in <span></span></div>');
    this.deathTimer = this.death.querySelector('span')!;
    this.toastBox = el('div', 'ch-toasts', this.root);

    const obj = el('div', 'ch-boss', this.root);
    const name = el('div', 'ch-boss-name', obj);
    const track = el('div', 'ch-boss-bar', obj);
    const lag = el('div', 'ch-boss-lag', track);
    const hpFill = el('div', 'ch-boss-hp', track);
    el('div', 'ch-boss-ticks', track);
    const pct = el('span', 'ch-boss-pct', track);
    const cast = el('div', 'ch-boss-cast', obj);
    const castFill = el('div', 'ch-boss-cast-fill', cast);
    el('span', '', cast);
    this.objective = { root: obj, name, hp: hpFill, lag, pct, cast, castFill };
  }

  setPlayer(u: Unit): void {
    this.player = u;
    this.loadoutKey = '';
    for (const b of this.bars.values()) b.el.remove();
    this.bars.clear();
  }

  toast(text: string, kind: 'info' | 'warn' | 'gold' = 'info'): void {
    const t = el('div', `ch-toast ch-toast-${kind}`, this.toastBox, text);
    setTimeout(() => t.classList.add('out'), 1400);
    setTimeout(() => t.remove(), 2000);
  }

  /** Outline the health bar of the enemy the player's basic attack is lined up on. */
  setTarget(u: Unit | null): void {
    if (u === this.target) return;
    if (this.target) this.bars.get(this.target)?.el.classList.remove('ch-ob-target');
    this.target = u;
    if (u) this.bars.get(u)?.el.classList.add('ch-ob-target');
  }

  /** Brief red flash on a slot that could not be cast. */
  deny(slot: number): void {
    const s = this.slots[slot];
    if (!s) return;
    s.tile.classList.remove('deny');
    void s.tile.offsetWidth;
    s.tile.classList.add('deny');
  }

  setPreview(slot: number | null): void {
    this.slots.forEach((s, i) => s.tile.classList.toggle('aiming', i === slot));
  }

  onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'damage': {
        const mine = e.source === this.player || e.source?.owner === this.player;
        const onMe = e.target === this.player;
        if (onMe) this.hurt = Math.min(1, this.hurt + 0.25 + (e.amount / this.player.combatant.stats.maxHealth) * 3);
        if (!mine && !onMe) break;
        const cls = onMe ? 'taken' : e.crit ? 'crit' : e.ability ? 'ability' : 'basic';
        this.floater(e.target, `${Math.round(e.amount)}${e.crit ? '!' : ''}`, `ch-num ch-num-${cls}`);
        break;
      }
      case 'heal':
        if (e.target === this.player && e.amount >= 2) this.floater(e.target, `+${Math.round(e.amount)}`, 'ch-num ch-num-heal');
        break;
      case 'levelUp':
        if (e.unit === this.player) this.toast(`Level ${e.level}${e.level === 5 ? ' &middot; Ultimate unlocked' : ''}`, 'gold');
        break;
      case 'reward':
        if (e.unit === this.player && e.favor > 0) this.floater(e.unit, `+${e.xp} XP &middot; +${e.favor} Favor`, 'ch-num ch-num-reward');
        break;
      case 'death':
        if (e.killer === this.player && e.unit.kind === 'god') this.toast(`You slew ${e.unit.name}`, 'gold');
        break;
      case 'recall':
        if (e.unit === this.player && e.state === 'cancel') this.toast('Recall interrupted', 'warn');
        break;
      default:
        break;
    }
  }

  private floater(u: Unit, html: string, cls: string): void {
    const pos = new THREE.Vector3();
    if (!this.headOf(u, pos)) pos.set(u.x, u.body.y + 2.6, u.z);
    const f: Floater = { el: el('div', cls, this.overlay, html), pos, age: 0, drift: (Math.random() - 0.5) * 50 };
    this.floaters.push(f);
  }

  frame(units: readonly Unit[], dt: number): void {
    const p = this.player;
    const c = p.combatant;
    const s = c.stats;

    // resources and level
    const hpPct = (c.health / s.maxHealth) * 100;
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    const low = p.alive ? Math.max(0, (35 - hpPct) / 35) : 0;
    const beat = low > 0 ? 0.75 + 0.25 * Math.sin(performance.now() / 180) : 0;
    this.vignette.style.opacity = `${Math.min(1, this.hurt * 0.9 + low * beat)}`;
    const shield = c.shieldTotal;
    this.hpFill.style.width = `${hpPct}%`;
    this.hpShield.style.left = `${hpPct}%`;
    this.hpShield.style.width = `${Math.min(100 - hpPct, (shield / s.maxHealth) * 100)}%`;
    this.hpText.textContent = `${Math.ceil(c.health)} / ${Math.round(s.maxHealth)}${shield > 0 ? ` (+${Math.round(shield)})` : ''}`;
    this.manaFill.style.width = `${(c.mana / s.maxMana) * 100}%`;
    this.manaText.textContent = `${Math.floor(c.mana)} / ${Math.round(s.maxMana)}`;
    this.levelText.textContent = String(c.level);
    const prog = c.levelProgress;
    const frac = c.level >= MAX_LEVEL ? 1 : prog.into / prog.needed;
    this.xpRing.style.strokeDashoffset = String(119.4 * (1 - frac));

    this.updateBuffs();

    // abilities
    const key = c.loadout.join('|') + c.level;
    if (key !== this.loadoutKey) {
      this.loadoutKey = key;
      this.slots.forEach((slot, i) => {
        const skill = c.skillInSlot(i);
        slot.skillId = skill?.id ?? '';
        slot.icon.innerHTML = skill ? skillIcon(c.god.id, skill) : '';
        slot.tile.title = skill ? `${skill.name}: ${skill.description}` : '';
      });
    }
    this.slots.forEach((slot, i) => {
      const rank = c.skillRankInSlot(i);
      const locked = rank <= 0;
      const cd = c.cooldownOf(i);
      const total = Math.max(0.01, c.resolveCooldown(i));
      const cost = locked ? 0 : c.resolveCost(i);
      slot.tile.classList.toggle('locked', locked);
      slot.tile.classList.toggle('cooling', cd > 0);
      slot.tile.classList.toggle('nomana', !locked && cd <= 0 && c.mana < cost);
      slot.cd.style.background = cd > 0 ? `conic-gradient(rgba(5,5,10,0.78) ${(cd / total) * 360}deg, transparent 0)` : 'none';
      slot.cdText.textContent = cd > 0 ? (cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1)) : '';
      slot.cost.textContent = locked ? '' : String(Math.round(cost));
      slot.lock.textContent = locked ? `Lv ${i === ULTIMATE_SLOT ? 5 : 1}` : '';
    });
    const unspent = c.unspentPoints;
    this.points.innerHTML = unspent > 0 ? `<b>${unspent}</b> skill point${unspent > 1 ? 's' : ''} &middot; press <kbd>K</kbd>` : '';
    this.points.classList.toggle('show', unspent > 0);

    // crowd control on the player
    const cc = c.cc.active.filter((a) => CC_LABEL[a.kind]);
    this.status.innerHTML = cc.map((a) => `<span class="ch-cc ch-cc-${a.kind}">${CC_LABEL[a.kind]} ${a.remaining.toFixed(1)}</span>`).join('');

    this.recall.classList.toggle('show', p.recall > 0);
    this.recallFill.style.width = `${(1 - p.recall / RECALL_TIME) * 100}%`;

    this.death.classList.toggle('show', !c.alive);
    if (!c.alive) this.deathTimer.textContent = `${Math.ceil(c.respawnTimer)}s`;

    this.overheadBars(units, dt);
    this.objectiveBar(units, dt);
    this.updateFloaters(dt);
  }

  /** Jungle buffs the player holds, each a glowing chip with a draining timer ring. */
  private updateBuffs(): void {
    const held = BUFF_KINDS.filter((k) => this.player.marks.has(buffMark(k)));
    const key = held.join('|');
    if (key !== this.buffKey) {
      this.buffKey = key;
      this.buffs.innerHTML = held
        .map((k) => {
          const b = BUFFS[k];
          return `<div class="ch-buff" data-buff="${k}" style="--c:${hex(BUFF_GLOW[k] ?? 0xffffff)}" title="${b.name}: ${b.text}"><span>${k === 'fury' ? 'F' : b.name[0]}</span><i></i></div>`;
        })
        .join('');
    }
    for (const chip of this.buffs.children as HTMLCollectionOf<HTMLElement>) {
      const m = this.player.marks.get(buffMark(chip.dataset.buff as BuffKind));
      if (!m) continue;
      chip.style.setProperty('--p', String(m.remaining / (chip.dataset.buff === 'fury' ? FURY_DURATION : BUFF_DURATION)));
      chip.querySelector('i')!.textContent = String(Math.ceil(m.remaining));
    }
  }

  private project(p: THREE.Vector3): { x: number; y: number } | null {
    this.v.copy(p).project(this.camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight };
  }

  /** Bosses and Wardens near the player get a big named bar under the scoreboard instead of a small overhead one. */
  private objectiveBar(units: readonly Unit[], dt: number): void {
    const p = this.player;
    let best: Unit | null = null;
    let bd = OBJECTIVE_RANGE;
    for (const u of units) {
      if (!u.alive || !(u.brain instanceof MonsterBrain)) continue;
      const kind = u.brain.camp.camp.kind;
      if (!isBoss(kind) && !isBuff(kind)) continue;
      const d = Math.hypot(u.x - p.x, u.z - p.z);
      if (d < bd) {
        best = u;
        bd = d;
      }
    }
    const o = this.objective;
    o.root.classList.toggle('show', best !== null);
    if (!best) {
      this.objectiveUnit = null;
      return;
    }
    const brain = best.brain as MonsterBrain;
    const kind = brain.camp.camp.kind;
    if (best !== this.objectiveUnit) {
      this.objectiveUnit = best;
      this.objectiveLag = 1;
      const color = OBJECTIVE_COLOR[kind] ?? hex(BUFF_GLOW[kind] ?? 0xffffff);
      o.root.style.setProperty('--c', color);
      const title = isBoss(kind) ? EPITHET[kind]! : `Guardian of ${BUFFS[kind as BuffKind].name}`;
      o.name.innerHTML = `${best.name}<small>${title}</small>`;
      o.root.classList.toggle('ch-boss-major', isBoss(kind));
      // a notch every thousand health
      o.root.style.setProperty('--tick', `${(100 * 1000) / best.combatant.stats.maxHealth}%`);
      o.cast.querySelector('span')!.textContent = SPECIAL_NAME[kind] ?? '';
    }
    const c = best.combatant;
    const pct = c.health / c.stats.maxHealth;
    this.objectiveLag = drain(this.objectiveLag, pct, dt);
    o.hp.style.width = `${pct * 100}%`;
    o.lag.style.width = `${this.objectiveLag * 100}%`;
    o.pct.textContent = `${Math.ceil(c.health).toLocaleString()} / ${Math.round(c.stats.maxHealth).toLocaleString()}`;
    const cast = brain.specialProgress;
    o.cast.classList.toggle('show', cast > 0);
    o.castFill.style.width = `${cast * 100}%`;
    o.root.classList.toggle('engaged', brain.target !== null);
  }

  private overheadBars(units: readonly Unit[], dt: number): void {
    const seen = new Set<Unit>();
    for (const u of units) {
      seen.add(u);
      let b = this.bars.get(u);
      if (!b) b = this.makeBar(u);
      const head = u.alive ? this.headOf(u, this.v) : null;
      const at = head && this.project(head);
      const enemyHidden = u.team !== this.player.team && u.stealth > 0;
      // the objective bar already shows it
      if (!at || enemyHidden || u === this.objectiveUnit) {
        b.el.style.display = 'none';
        continue;
      }
      const c = u.combatant;
      const dist = this.camera.position.distanceTo(head!);
      // keep the screen readable in a big fight: minion bars only up close
      const maxDist = u.kind === 'minion' || u.kind === 'monster' ? 45 : isStructure(u) ? 45 : 80;
      if (dist > maxDist) {
        b.el.style.display = 'none';
        continue;
      }
      b.el.style.display = '';
      b.el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%) scale(${Math.max(0.6, Math.min(1, 22 / dist))})`;
      const max = c.stats.maxHealth;
      const shield = c.shieldTotal;
      const total = Math.max(max, c.health + shield);
      const pct = c.health / total;
      b.lagPct = drain(b.lagPct, pct, dt);
      b.hp.style.width = `${pct * 100}%`;
      b.lag.style.width = `${b.lagPct * 100}%`;
      // a notch every 250 health on gods, every thousand on structures
      const step = u.kind === 'god' ? 250 : isStructure(u) ? 1000 : 0;
      if (step) b.el.style.setProperty('--tick', `${(100 * step) / total}%`);
      b.shield.style.left = `${(c.health / total) * 100}%`;
      b.shield.style.width = `${(shield / total) * 100}%`;
      b.level.textContent = u.kind === 'god' ? String(c.level) : '';
      b.marks.textContent = [...u.marks].filter(([k]) => !k.startsWith('buff:')).map(([, m]) => '◆'.repeat(m.stacks)).join('');
    }
    for (const [u, b] of this.bars) {
      if (seen.has(u)) continue;
      b.el.remove();
      this.bars.delete(u);
    }
  }

  private makeBar(u: Unit): Bar {
    const side = u === this.player ? 'self' : u.team === this.player.team ? 'ally' : u.team === 'neutral' ? 'neutral' : 'enemy';
    const root = el('div', `ch-ob ch-ob-${side} ch-ob-${u.kind}`, this.overlay);
    const head = el('div', 'ch-ob-head', root);
    const level = el('span', 'ch-ob-level', head);
    const name = el('span', 'ch-ob-name', head, u === this.player ? '' : u.name);
    const marks = el('span', 'ch-ob-marks', head);
    const bar = el('div', 'ch-ob-bar', root);
    const lag = el('div', 'ch-ob-lag', bar);
    const hp = el('div', 'ch-ob-hp', bar);
    hp.style.setProperty('--c', TEAM_COLORS[side]);
    const shield = el('div', 'ch-ob-shield', bar);
    el('div', 'ch-ob-ticks', bar);
    if (u === this.target) root.classList.add('ch-ob-target');
    const b = { el: root, hp, lag, lagPct: 1, shield, level, name, marks };
    this.bars.set(u, b);
    return b;
  }

  private updateFloaters(dt: number): void {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]!;
      f.age += dt;
      const at = this.project(f.pos);
      if (!at || f.age > 1.1) {
        f.el.remove();
        this.floaters.splice(i, 1);
        continue;
      }
      const rise = 30 + f.age * 70;
      const pop = f.age < 0.12 ? 1 + (0.12 - f.age) * 5 : 1;
      f.el.style.transform = `translate(${at.x + f.drift * f.age}px, ${at.y - rise}px) translate(-50%, -50%) scale(${pop})`;
      f.el.style.opacity = String(Math.min(1, (1.1 - f.age) / 0.35));
    }
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }
}
