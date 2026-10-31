import type { Combatant } from '../game/combatant';
import { SLOT_COUNT, SLOT_KEYS, ULTIMATE_SLOT, type LoadoutError } from '../game/loadout';
import { MAX_LEVEL, MAX_TREE_POINTS, ranked } from '../game/progression';
import { pointsInTree, pointsSpent, prereqMet, TIER_REQUIREMENT, type AllocationError } from '../game/trees';
import type { GodDef, SkillDef, SkillTree, TreeNode } from '../game/types';
import { skillIcon, talentIcon } from './icons';
import './menu.css';

const ERRORS: Record<AllocationError | LoadoutError | 'notInBase', string> = {
  unknownNode: 'Unknown talent.',
  maxRank: 'That talent is maxed.',
  noPoints: 'No skill points left. Level up or earn Favor.',
  tierLocked: 'Spend more points in this tree first.',
  needsPrereq: 'Max the talent the arrow points from first.',
  notAllocated: 'No points in that talent.',
  wouldBreakTier: 'Refunding that would lock a talent you use.',
  wrongSize: 'Invalid loadout.',
  unknownSkill: 'Unknown skill.',
  duplicate: 'That skill is already equipped.',
  ultimateInRegularSlot: 'Ultimates only go in the ultimate slot (4).',
  notInBase: 'Only in base. Recall with B.',
};

/** Accent per tree column, in tree order. */
const TREE_ACCENTS = ['#ff7a3d', '#ffc94a', '#4fc3ff'] as const;

export interface LoadoutMenuHooks {
  /** The combatant the menu edits (changes when the god is switched). */
  combatant(): Combatant;
  gods: readonly GodDef[];
  /** Absent in a match: the god is locked in once it starts. */
  switchGod?(id: string): string | null;
  /** Practice shortcuts, only on the training ground. */
  practiceLevel?(level: number): void;
  practiceFavor?(): void;
  onClose(): void;
}

/**
 * The K menu, laid out like a classic talent frame: three tree columns of
 * square talents in tiers that open as points go into that tree, with the
 * 5-slot loadout and skill pool along the bottom. Left-click learns a rank,
 * right-click unlearns one. Points can be spent anywhere; refunds, resets,
 * swaps and god changes need the fountain, like Smite's item shop.
 */
export class LoadoutMenu {
  readonly root: HTMLDivElement;
  private readonly host: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private selectedSlot = 0;
  private message = '';
  private open_ = false;
  /** The data-tip key under the mouse, so a re-render can keep its tooltip up. */
  private hovered: string | null = null;

  constructor(private readonly hooks: LoadoutMenuHooks) {
    this.root = document.createElement('div');
    this.root.className = 'lm';
    this.host = document.createElement('div');
    this.host.className = 'lm-host';
    this.tip = document.createElement('div');
    this.tip.className = 'lm-tip';
    this.root.append(this.host, this.tip);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.host.addEventListener('click', (e) => this.onClick(e, false));
    this.host.addEventListener('contextmenu', (e) => this.onClick(e, true));
    this.host.addEventListener('mouseover', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      this.hovered = el?.dataset.tip ?? null;
      this.showTip(el);
    });
    this.host.addEventListener('mouseleave', () => {
      this.hovered = null;
      this.showTip(null);
    });
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    this.open_ = true;
    this.message = '';
    this.root.classList.add('show');
    this.render();
  }

  close(): void {
    this.open_ = false;
    this.hovered = null;
    this.showTip(null);
    this.root.classList.remove('show');
    this.hooks.onClose();
  }

  /** Re-render when something the menu shows may have changed (level ups, leaving base). */
  refresh(): void {
    if (this.open_) this.render();
  }

  private say(err: string | null): void {
    this.message = err ? (ERRORS[err as keyof typeof ERRORS] ?? err) : '';
    this.render();
  }

  private onClick(e: MouseEvent, right: boolean): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const c = this.hooks.combatant();
    const v = el.dataset.v ?? '';
    switch (el.dataset.act) {
      case 'node':
        return this.say(right ? c.deallocate(v) : c.allocate(v));
      case 'reset':
        return this.say(c.resetTrees(v || undefined));
      case 'slot':
        if (right) return;
        this.selectedSlot = Number(v);
        return this.say(null);
      case 'skill':
        if (right) return;
        return this.say(c.swap(this.selectedSlot, v));
      case 'god':
        return this.say(this.hooks.switchGod?.(v) ?? null);
      case 'level':
        this.hooks.practiceLevel?.(Number(v));
        return this.say(null);
      case 'favor':
        this.hooks.practiceFavor?.();
        return this.say(null);
      case 'close':
        return this.close();
    }
  }

  private render(): void {
    const c = this.hooks.combatant();
    const g = c.god;
    const spent = pointsSpent(c.allocation);
    const base = c.inBase;
    const pool = g.skills.filter((s) => this.selectedSlot === ULTIMATE_SLOT || s.kind === 'regular');
    this.host.innerHTML = `
      <div class="lm-panel">
        <header class="lm-head">
          <div class="lm-name">
            <div class="lm-title">${g.name}</div>
            <div class="lm-sub">${g.title} &middot; ${g.pantheon} &middot; ${g.role}</div>
          </div>
          ${this.hooks.switchGod ? `<div class="lm-gods">${this.hooks.gods
            .map((d) => `<button class="lm-god${d.id === g.id ? ' on' : ''}" data-act="god" data-v="${d.id}" ${base ? '' : 'disabled'}>${d.name}</button>`)
            .join('')}</div>` : '<div class="lm-gods"></div>'}
          <button class="lm-close" data-act="close" aria-label="Close">&times;</button>
        </header>
        <div class="lm-trees">${g.trees.map((t, i) => this.treeHtml(c, t, i)).join('')}</div>
        <div class="lm-foot">
          <div class="lm-points">
            <span>Level <b>${c.level}</b></span>
            <span>Points <b>${spent}</b> / ${MAX_TREE_POINTS}</span>
            <span class="lm-left${c.unspentPoints ? ' glow' : ''}"><b>${c.unspentPoints}</b> to spend</span>
            <span class="lm-base ${base ? 'yes' : 'no'}">${base ? 'At the fountain' : 'In the field: learn only'}</span>
          </div>
          <div class="lm-msg">${this.message}</div>
          <div class="lm-actions">
            ${this.hooks.practiceLevel ? `<span class="lm-practice">Practice
              <button data-act="level" data-v="${Math.min(MAX_LEVEL, c.level + 1)}">+1 level</button>
              <button data-act="level" data-v="${MAX_LEVEL}">Level 20</button>
              <button data-act="favor">Max Favor</button>
            </span>` : ''}
            <button class="lm-reset" data-act="reset" data-v="" ${base && spent ? '' : 'disabled'} title="${base ? 'Refund every point' : 'Only in base'}">Reset all</button>
          </div>
        </div>
        <div class="lm-loadout">
          <div class="lm-group">
            <h3>Loadout</h3>
            <div class="lm-slots">${Array.from({ length: SLOT_COUNT }, (_, i) => i).map((i) => this.slotHtml(c, i)).join('')}</div>
          </div>
          <div class="lm-group lm-pool-group">
            <h3>${this.selectedSlot === ULTIMATE_SLOT ? 'Ultimate slot (4): any skill' : `${SLOT_KEYS[this.selectedSlot]} slot: regular skills`}${base ? '' : ' <em>swap at the fountain</em>'}</h3>
            <div class="lm-pool">${pool.map((s) => this.poolHtml(c, s)).join('')}</div>
          </div>
        </div>
      </div>`;
    this.showTip(this.hovered ? this.host.querySelector<HTMLElement>(`[data-tip="${this.hovered}"]`) : null);
  }

  private treeHtml(c: Combatant, tree: SkillTree, index: number): string {
    const accent = TREE_ACCENTS[index] ?? TREE_ACCENTS[0];
    const inTree = pointsInTree(c.trees, c.allocation, tree.id);
    const tiers = [1, 2, 3, 4] as const;
    const key = tree.nodes.find((n) => n.tier === 4);
    return `<section class="lm-tree" style="--accent:${accent}">
      <div class="lm-tree-art">${key ? talentIcon(c.god.id, key, c.god.skills, accent) : ''}</div>
      <header class="lm-tree-head">
        <div>
          <h2>${tree.name}</h2>
          <div class="lm-theme">${tree.theme}</div>
        </div>
        <span class="lm-tree-pts" title="Points spent in ${tree.name}">${inTree}</span>
      </header>
      <div class="lm-grid">${tiers
        .map((tier) => {
          const nodes = tree.nodes.filter((n) => n.tier === tier);
          // a lone node (the keystone) sits in the middle column, under its prerequisite
          const start = nodes.length === 1 ? 2 : 1;
          return nodes.map((n, i) => this.nodeHtml(c, tree, n, tier, start + i)).join('');
        })
        .join('')}</div>
      <button class="lm-tree-reset" data-act="reset" data-v="${tree.id}" ${c.inBase && inTree ? '' : 'disabled'}>Reset ${tree.name}</button>
    </section>`;
  }

  private nodeHtml(c: Combatant, tree: SkillTree, n: TreeNode, tier: TreeNode['tier'], col: number): string {
    const r = c.allocation[n.id] ?? 0;
    const tierOpen = pointsInTree(c.trees, c.allocation, tree.id, tier) >= TIER_REQUIREMENT[tier];
    const open = tierOpen && prereqMet(c.trees, c.allocation, n);
    const learnable = open && r < n.maxRank && c.unspentPoints > 0;
    const cls = [
      'lm-node',
      open ? 'open' : 'locked',
      r ? 'taken' : '',
      r === n.maxRank ? 'max' : '',
      learnable ? 'learnable' : '',
      tier === 4 ? 'key' : '',
      n.requires ? `arrow${prereqMet(c.trees, c.allocation, n) ? ' arrow-on' : ''}` : '',
    ].join(' ');
    return `<button class="${cls}" style="grid-row:${tier};grid-column:${col}" data-act="node" data-v="${n.id}" data-tip="n:${n.id}" aria-label="${n.name} ${r} of ${n.maxRank}">
      ${talentIcon(c.god.id, n, c.god.skills, TREE_ACCENTS[c.god.trees.indexOf(tree)] ?? TREE_ACCENTS[0])}
      <span class="lm-rank">${r}/${n.maxRank}</span>
    </button>`;
  }

  private slotHtml(c: Combatant, i: number): string {
    const s = c.skillInSlot(i);
    const sel = i === this.selectedSlot ? ' sel' : '';
    return `<button class="lm-slot${sel}${i === ULTIMATE_SLOT ? ' ult' : ''}" data-act="slot" data-v="${i}" ${s ? `data-tip="s:${s.id}"` : ''}>
      <span class="lm-ico">${s ? skillIcon(c.god.id, s) : ''}</span>
      <span class="lm-key">${SLOT_KEYS[i]}</span>
    </button>`;
  }

  private poolHtml(c: Combatant, s: SkillDef): string {
    const equipped = c.loadout.includes(s.id);
    return `<button class="lm-skill${equipped ? ' equipped' : ''}" data-act="skill" data-v="${s.id}" data-tip="s:${s.id}" ${c.inBase && !equipped ? '' : 'aria-disabled="true"'}>
      <span class="lm-ico">${skillIcon(c.god.id, s)}</span>
      ${equipped ? `<span class="lm-eq">${SLOT_KEYS[c.loadout.indexOf(s.id)]}</span>` : ''}
    </button>`;
  }

  private showTip(el: HTMLElement | null): void {
    const key = el?.dataset.tip;
    const html = key ? this.tipHtml(key) : '';
    if (!el || !html) {
      this.tip.classList.remove('show');
      return;
    }
    this.tip.innerHTML = html;
    this.tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    let x = r.right + 10;
    if (x + w > innerWidth - 8) x = r.left - w - 10;
    const y = Math.max(8, Math.min(innerHeight - h - 8, r.top));
    this.tip.style.left = `${Math.max(8, x)}px`;
    this.tip.style.top = `${y}px`;
  }

  private tipHtml(key: string): string {
    const c = this.hooks.combatant();
    const id = key.slice(2);
    if (key.startsWith('n:')) {
      const entry = c.trees.node.get(id);
      if (!entry) return '';
      const { node: n, tree } = entry;
      const r = c.allocation[n.id] ?? 0;
      const need = TIER_REQUIREMENT[n.tier];
      const have = pointsInTree(c.trees, c.allocation, tree.id, n.tier);
      const req = n.requires ? c.trees.node.get(n.requires)?.node : undefined;
      const lines = [
        `<div class="lm-tip-name">${n.name}</div>`,
        `<div class="lm-tip-rank">Rank ${r}/${n.maxRank}${n.tier === 4 ? ' &middot; Keystone' : ''}</div>`,
        have < need ? `<div class="lm-tip-req">Requires ${need} points in ${tree.name}</div>` : '',
        req && !prereqMet(c.trees, c.allocation, n) ? `<div class="lm-tip-req">Requires ${req.maxRank} points in ${req.name}</div>` : '',
        `<div class="lm-tip-desc">${n.description}</div>`,
        r < n.maxRank && have >= need && prereqMet(c.trees, c.allocation, n)
          ? `<div class="lm-tip-hint">${c.unspentPoints ? 'Left-click to learn' : 'No points to spend'}</div>`
          : '',
        r > 0 ? `<div class="lm-tip-hint">${c.inBase ? 'Right-click to unlearn' : 'Unlearn at the fountain'}</div>` : '',
      ];
      return lines.join('');
    }
    const s = c.god.skills.find((k) => k.id === id);
    if (!s) return '';
    const slot = c.loadout.indexOf(s.id);
    const rank = Math.max(1, slot >= 0 ? c.skillRankInSlot(slot) : 1);
    return [
      `<div class="lm-tip-name">${s.name}</div>`,
      `<div class="lm-tip-rank">${s.kind === 'ultimate' ? 'Ultimate' : 'Skill'} &middot; ${ranked(s.cooldown, rank)}s cooldown &middot; ${ranked(s.cost, rank)} mana</div>`,
      `<div class="lm-tip-desc">${s.description}</div>`,
      `<div class="lm-tip-tags">${s.tags.join(' &middot; ')}</div>`,
      slot >= 0
        ? `<div class="lm-tip-hint">Equipped in ${SLOT_KEYS[slot]}</div>`
        : `<div class="lm-tip-hint">${c.inBase ? `Click to equip in ${SLOT_KEYS[this.selectedSlot]}` : 'Swap at the fountain'}</div>`,
    ].join('');
  }
}
