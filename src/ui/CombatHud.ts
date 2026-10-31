import { BUFF_GLOW } from '../combat/MonsterViews';
import { BUFF_DURATION, BUFF_KINDS, BUFFS, buffMark, FURY_DURATION, isBoss, isBuff, MonsterBrain, type BuffKind } from '../sim/Jungle';
import * as THREE from 'three/webgpu';
import { SLOT_COUNT, SLOT_KEYS, ULTIMATE_SLOT } from '../game/loadout';
import { MAX_LEVEL } from '../game/progression';
import type { CCKind } from '../game/types';
import { RECALL_TIME } from '../sim/Sim';
import { isStructure, type SimEvent, type Unit } from '../sim/Unit';
import { hex, TEAM_COLORS } from '../combat/palette';
import { skillIcon } from './icons';
import { hypot } from '../core/math';
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

/** Crowd control that only hampers; the rest stops a unit outright. */
const SOFT_CC = new Set<CCKind>(['slow', 'cripple', 'blind', 'intoxicate']);

/** The crowd control to show on a unit: hard before soft, then the longest left. */
function ccTag(u: Unit): { kind: CCKind; text: string } | null {
  let best: { kind: CCKind; remaining: number } | null = null;
  for (const a of u.combatant.cc.active) {
    if (!CC_LABEL[a.kind]) continue;
    const hard = !SOFT_CC.has(a.kind);
    const bestHard = best !== null && !SOFT_CC.has(best.kind);
    if (!best || (hard && !bestHard) || (hard === bestHard && a.remaining > best.remaining)) best = a;
  }
  return best && { kind: best.kind, text: `${CC_LABEL[best.kind]} ${best.remaining.toFixed(1)}` };
}

interface Bar {
  el: HTMLDivElement;
  hp: HTMLDivElement;
  /** Recent damage: a pale strip that drains after the health fill. */
  lag: HTMLDivElement;
  lagPct: number;
  shield: HTMLDivElement;
  /** The crowd control holding this unit, over its name. */
  cc: HTMLSpanElement;
  ccText: string;
  level: HTMLSpanElement;
  name: HTMLSpanElement;
  marks: HTMLSpanElement;
  /** The frame this bar's unit was last in the list. */
  seen: number;
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

/**
 * The HUD updates every frame, and every style or text write makes the browser
 * recalculate style before it can paint. These write only what changed, so
 * values that sit still (full health bars, idle cooldowns) cost nothing.
 */
const written = new WeakMap<Element, Map<string, string>>();
function changed(e: Element, key: string, value: string): boolean {
  let m = written.get(e);
  if (!m) written.set(e, (m = new Map()));
  if (m.get(key) === value) return false;
  m.set(key, value);
  return true;
}
function setStyle(e: HTMLElement | SVGElement, prop: string, value: string): void {
  if (changed(e, prop, value)) e.style.setProperty(prop, value);
}
function setText(e: Element, text: string): void {
  if (changed(e, '#text', text)) e.textContent = text;
}
function setHtml(e: Element, html: string): void {
  if (changed(e, '#html', html)) e.innerHTML = html;
}
const percent = (f: number): string => `${(f * 100).toFixed(1)}%`;

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
  private readonly slots: { tile: HTMLDivElement; icon: HTMLDivElement; cd: HTMLDivElement; cdText: HTMLSpanElement; cost: HTMLSpanElement; lock: HTMLSpanElement; charges: HTMLSpanElement; skillId: string; wasCooling: boolean }[] = [];
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
  private readonly objective: { root: HTMLDivElement; name: HTMLDivElement; hp: HTMLDivElement; lag: HTMLDivElement; pct: HTMLSpanElement; cast: HTMLDivElement; castFill: HTMLDivElement; cc: HTMLSpanElement };
  private objectiveCC = '';
  private objectiveUnit: Unit | null = null;
  private target: Unit | null = null;
  private objectiveLag = 1;
  private readonly floaters: Floater[] = [];
  private readonly v = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly screen = { x: 0, y: 0 };
  private barFrame = 0;
  private loadoutKey = '';

  /** Red screen edges: pulse on damage taken, linger at low health. */
  private readonly vignette: HTMLElement;
  private hurt = 0;
  /** Ticks around the crosshair that flash when the player's damage lands. */
  private readonly hitmarker: HTMLElement;
  private hitAnim: Animation | null = null;
  /** Red arcs around the crosshair pointing at whoever is hurting the player. */
  private readonly hitDirBox: HTMLElement;
  private readonly hitDirs = new Map<Unit, { el: HTMLElement; age: number; strength: number }>();

  constructor(
    private player: Unit,
    private readonly camera: THREE.Camera,
    private readonly headOf: (u: Unit, out: THREE.Vector3) => THREE.Vector3 | null,
  ) {
    this.root = el('div', 'combat-hud', document.body);
    this.vignette = el('div', 'ch-vignette', this.root);
    this.overlay = el('div', 'ch-overlay', this.root);
    this.hitmarker = el('div', 'ch-hitmarker', this.root, '<i></i><i></i><i></i><i></i>');
    this.hitDirBox = el('div', 'ch-hitdirs', this.root);

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
    for (let i = 0; i < SLOT_COUNT; i++) {
      const tile = el('div', `ch-slot${i === ULTIMATE_SLOT ? ' ch-ult' : ''}`, row);
      const icon = el('div', 'ch-icon', tile);
      const cd = el('div', 'ch-cd', tile);
      const cdText = el('span', 'ch-cd-text', tile);
      el('span', 'ch-key', tile, SLOT_KEYS[i]);
      const cost = el('span', 'ch-cost', tile);
      const lock = el('span', 'ch-lock', tile);
      const charges = el('span', 'ch-charges', tile);
      this.slots.push({ tile, icon, cd, cdText, cost, lock, charges, skillId: '', wasCooling: false });
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
    const cc = el('span', 'ch-ob-cc', obj);
    const cast = el('div', 'ch-boss-cast', obj);
    const castFill = el('div', 'ch-boss-cast-fill', cast);
    el('span', '', cast);
    this.objective = { root: obj, name, hp: hpFill, lag, pct, cast, castFill, cc };
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
        if (onMe) {
          const share = e.amount / this.player.combatant.stats.maxHealth;
          this.hurt = Math.min(1, this.hurt + 0.25 + share * 3);
          if (e.source && e.source !== this.player) this.markHitFrom(e.source, share);
        }
        if (mine && !onMe) this.markHit(e.crit ? 'crit' : 'hit');
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
        if (e.killer === this.player && e.unit.kind === 'god') {
          this.toast(`You slew ${e.unit.name}`, 'gold');
          this.markHit('kill');
        }
        break;
      case 'recall':
        if (e.unit === this.player && e.state === 'cancel') this.toast('Recall interrupted', 'warn');
        break;
      default:
        break;
    }
  }

  /** Flash the hitmarker; a crit or kill outranks a plain hit still on screen. */
  private markHit(kind: 'hit' | 'crit' | 'kill'): void {
    const rank = { hit: 0, crit: 1, kill: 2 };
    const shown = this.hitmarker.dataset.kind as keyof typeof rank | undefined;
    if (this.hitAnim?.playState === 'running' && shown && rank[shown] > rank[kind]) return;
    this.hitmarker.dataset.kind = kind;
    this.hitAnim?.cancel();
    const big = kind === 'kill' ? 1.5 : kind === 'crit' ? 1.2 : 1;
    this.hitAnim = this.hitmarker.animate(
      [
        { opacity: 1, transform: `translate(-50%, -50%) scale(${0.7 * big})` },
        { opacity: 1, transform: `translate(-50%, -50%) scale(${big})`, offset: 0.25 },
        { opacity: 0, transform: `translate(-50%, -50%) scale(${1.1 * big})` },
      ],
      { duration: kind === 'kill' ? 520 : 260, easing: 'ease-out' },
    );
  }

  private markHitFrom(src: Unit, share: number): void {
    let d = this.hitDirs.get(src);
    if (!d) {
      d = { el: el('div', 'ch-hitdir', this.hitDirBox), age: 0, strength: 0 };
      this.hitDirs.set(src, d);
    }
    d.age = 0;
    d.strength = Math.min(1, Math.max(d.strength * 0.6, 0) + 0.55 + share * 4);
  }

  /** Point each damage arc at its source, in camera space, and fade it out. */
  private updateHitDirs(dt: number): void {
    const p = this.player;
    for (const [src, d] of this.hitDirs) {
      d.age += dt;
      const life = 1.3;
      if (d.age >= life || !p.alive) {
        d.el.remove();
        this.hitDirs.delete(src);
        continue;
      }
      // bearing from the player, not the camera, which trails a few units behind
      this.v.set(src.x - p.x, 0, src.z - p.z).transformDirection(this.camera.matrixWorldInverse);
      const angle = Math.atan2(this.v.x, -this.v.z);
      d.el.style.transform = `rotate(${angle}rad)`;
      d.el.style.opacity = `${d.strength * (1 - d.age / life)}`;
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
    setStyle(this.vignette, 'opacity', Math.min(1, this.hurt * 0.9 + low * beat).toFixed(2));
    this.updateHitDirs(dt);
    const shield = c.shieldTotal;
    setStyle(this.hpFill, 'width', percent(hpPct / 100));
    setStyle(this.hpShield, 'left', percent(hpPct / 100));
    setStyle(this.hpShield, 'width', percent(Math.min(1 - hpPct / 100, shield / s.maxHealth)));
    setText(this.hpText, `${Math.ceil(c.health)} / ${Math.round(s.maxHealth)}${shield > 0 ? ` (+${Math.round(shield)})` : ''}`);
    setStyle(this.manaFill, 'width', percent(c.mana / s.maxMana));
    setText(this.manaText, `${Math.floor(c.mana)} / ${Math.round(s.maxMana)}`);
    setText(this.levelText, String(c.level));
    const prog = c.levelProgress;
    const frac = c.level >= MAX_LEVEL ? 1 : prog.into / prog.needed;
    setStyle(this.xpRing, 'stroke-dashoffset', (119.4 * (1 - frac)).toFixed(1));

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
      // a short glint the frame a skill comes off cooldown, so it reads without looking down
      if (slot.wasCooling && cd <= 0 && !locked && p.alive) {
        slot.tile.animate(
          [
            { boxShadow: '0 0 0 2px rgba(255, 236, 170, 1), 0 0 18px rgba(255, 220, 120, 0.9)', filter: 'brightness(1.8)' },
            { boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.6)', filter: 'brightness(1)' },
          ],
          { duration: 450, easing: 'ease-out' },
        );
      }
      slot.wasCooling = cd > 0;
      slot.tile.classList.toggle('nomana', !locked && cd <= 0 && c.mana < cost);
      setStyle(slot.cd, 'background', cd > 0 ? `conic-gradient(rgba(5,5,10,0.78) ${((cd / total) * 360).toFixed(1)}deg, transparent 0)` : 'none');
      setText(slot.cdText, cd > 0 ? (cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1)) : '');
      setText(slot.cost, locked ? '' : String(Math.round(cost)));
      setText(slot.lock, locked ? `Lv ${i === ULTIMATE_SLOT ? 5 : 1}` : '');
      // skills a tree gave extra charges show a pip per charge
      const ch = c.chargesOf(i);
      setHtml(slot.charges, ch.max > 1 && !locked ? '<i class="on"></i>'.repeat(ch.ready) + '<i></i>'.repeat(ch.max - ch.ready) : '');
    });
    const unspent = c.unspentPoints;
    setHtml(this.points, unspent > 0 ? `<b>${unspent}</b> skill point${unspent > 1 ? 's' : ''} &middot; press <kbd>K</kbd>` : '');
    this.points.classList.toggle('show', unspent > 0);

    // crowd control on the player
    const cc = c.cc.active.filter((a) => CC_LABEL[a.kind]);
    setHtml(this.status, cc.map((a) => `<span class="ch-cc ch-cc-${a.kind}">${CC_LABEL[a.kind]} ${a.remaining.toFixed(1)}</span>`).join(''));

    this.recall.classList.toggle('show', p.recall > 0);
    setStyle(this.recallFill, 'width', percent(1 - p.recall / RECALL_TIME));

    this.death.classList.toggle('show', !c.alive);
    if (!c.alive) setText(this.deathTimer, `${Math.ceil(c.respawnTimer)}s`);

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
      setStyle(chip, '--p', (m.remaining / (chip.dataset.buff === 'fury' ? FURY_DURATION : BUFF_DURATION)).toFixed(3));
      setText(chip.querySelector('i')!, String(Math.ceil(m.remaining)));
    }
  }

  /** Screen position of `p`, or null behind the camera. The result is reused by the next call. */
  private project(p: THREE.Vector3): { x: number; y: number } | null {
    this.v.copy(p).project(this.camera);
    if (this.v.z > 1 || this.v.z < -1) return null;
    this.screen.x = (this.v.x * 0.5 + 0.5) * window.innerWidth;
    this.screen.y = (-this.v.y * 0.5 + 0.5) * window.innerHeight;
    return this.screen;
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
      const d = hypot(u.x - p.x, u.z - p.z);
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
    const frac = c.health / c.stats.maxHealth;
    this.objectiveLag = drain(this.objectiveLag, frac, dt);
    setStyle(o.hp, 'width', percent(frac));
    setStyle(o.lag, 'width', percent(this.objectiveLag));
    setText(o.pct, `${Math.ceil(c.health).toLocaleString()} / ${Math.round(c.stats.maxHealth).toLocaleString()}`);
    const cast = brain.specialProgress;
    o.cast.classList.toggle('show', cast > 0);
    setStyle(o.castFill, 'width', percent(cast));
    o.root.classList.toggle('engaged', brain.target !== null);
    // its overhead bar is hidden while this bar shows it, so its crowd control shows here
    const tag = ccTag(best);
    const text = tag?.text ?? '';
    if (text !== this.objectiveCC) {
      this.objectiveCC = text;
      o.cc.textContent = text;
      o.cc.className = tag ? `ch-ob-cc ch-ob-cc-on ch-cc-${tag.kind}` : 'ch-ob-cc';
    }
  }

  private overheadBars(units: readonly Unit[], dt: number): void {
    const frame = ++this.barFrame;
    for (const u of units) {
      const b = this.bars.get(u) ?? this.makeBar(u);
      b.seen = frame;
      const head = u.alive ? this.headOf(u, this.head) : null;
      const enemyHidden = u.team !== this.player.team && u.stealth > 0;
      // keep the screen readable in a big fight: minion bars only up close
      const maxDist = u.kind === 'minion' || u.kind === 'monster' ? 45 : isStructure(u) ? 45 : 80;
      const dist = head ? this.camera.position.distanceTo(head) : Infinity;
      // (the objective bar already shows its unit)
      const at = dist <= maxDist && !enemyHidden && u !== this.objectiveUnit ? this.project(head!) : null;
      if (!at) {
        setStyle(b.el, 'display', 'none');
        continue;
      }
      const c = u.combatant;
      setStyle(b.el, 'display', '');
      setStyle(b.el, 'transform', `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) translate(-50%, -100%) scale(${Math.max(0.6, Math.min(1, 22 / dist)).toFixed(2)})`);
      const max = c.stats.maxHealth;
      const shield = c.shieldTotal;
      const total = Math.max(max, c.health + shield);
      const frac = c.health / total;
      b.lagPct = drain(b.lagPct, frac, dt);
      setStyle(b.hp, 'width', percent(frac));
      setStyle(b.lag, 'width', percent(b.lagPct));
      // a notch every 250 health on gods, every thousand on structures
      const step = u.kind === 'god' ? 250 : isStructure(u) ? 1000 : 0;
      if (step) setStyle(b.el, '--tick', percent(step / total));
      setStyle(b.shield, 'left', percent(frac));
      setStyle(b.shield, 'width', percent(shield / total));
      setText(b.level, u.kind === 'god' ? String(c.level) : '');
      let marks = '';
      for (const [k, m] of u.marks) if (!k.startsWith('buff:')) marks += '◆'.repeat(m.stacks);
      setText(b.marks, marks);
      this.updateBarCC(b, u);
    }
    for (const [u, b] of this.bars) {
      if (b.seen === frame) continue;
      b.el.remove();
      this.bars.delete(u);
    }
  }

  /** Show what is holding a god or monster over its overhead bar. */
  private updateBarCC(b: Bar, u: Unit): void {
    const tag = u !== this.player && (u.kind === 'god' || u.kind === 'monster') ? ccTag(u) : null;
    const text = tag?.text ?? '';
    if (text === b.ccText) return;
    b.ccText = text;
    b.cc.textContent = text;
    b.cc.className = tag ? `ch-ob-cc ch-ob-cc-on ch-cc-${tag.kind}` : 'ch-ob-cc';
  }

  private makeBar(u: Unit): Bar {
    const side = u === this.player ? 'self' : u.team === this.player.team ? 'ally' : u.team === 'neutral' ? 'neutral' : 'enemy';
    const root = el('div', `ch-ob ch-ob-${side} ch-ob-${u.kind}`, this.overlay);
    const head = el('div', 'ch-ob-head', root);
    const level = el('span', 'ch-ob-level', head);
    const name = el('span', 'ch-ob-name', head, u === this.player ? '' : u.name);
    const marks = el('span', 'ch-ob-marks', head);
    const cc = el('span', 'ch-ob-cc', root);
    const bar = el('div', 'ch-ob-bar', root);
    const lag = el('div', 'ch-ob-lag', bar);
    const hp = el('div', 'ch-ob-hp', bar);
    hp.style.setProperty('--c', TEAM_COLORS[side]);
    const shield = el('div', 'ch-ob-shield', bar);
    el('div', 'ch-ob-ticks', bar);
    if (u === this.target) root.classList.add('ch-ob-target');
    const b = { el: root, hp, lag, lagPct: 1, shield, level, name, marks, cc, ccText: '', seen: 0 };
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
