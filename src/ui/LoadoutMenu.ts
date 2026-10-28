import type { Combatant } from '../game/combatant';
import { SLOT_KEYS, ULTIMATE_SLOT, type LoadoutError } from '../game/loadout';
import { MAX_LEVEL, MAX_TREE_POINTS, ranked } from '../game/progression';
import { pointsInTree, pointsSpent, TIER_REQUIREMENT, type AllocationError } from '../game/trees';
import type { GodDef, SkillDef, TreeNode } from '../game/types';
import { skillIcon } from './icons';
import './menu.css';

const ERRORS: Record<AllocationError | LoadoutError | 'notInBase', string> = {
  unknownNode: 'Unknown node.',
  maxRank: 'That node is maxed.',
  noPoints: 'No skill points left. Level up or earn Favor.',
  tierLocked: 'Spend more points lower in this tree first.',
  notAllocated: 'No points in that node.',
  wouldBreakTier: 'Refunding that would lock a higher tier you use.',
  wrongSize: 'Invalid loadout.',
  unknownSkill: 'Unknown skill.',
  duplicate: 'That skill is already equipped.',
  ultimateInRegularSlot: 'Ultimates only go in the R slot.',
  notInBase: 'Only in base. Recall with B.',
};

export interface LoadoutMenuHooks {
  /** The combatant the menu edits (changes when the god is switched). */
  combatant(): Combatant;
  gods: readonly GodDef[];
  switchGod(id: string): string | null;
  practiceLevel(level: number): void;
  practiceFavor(): void;
  onClose(): void;
}

/**
 * The K menu: the 5-slot loadout and skill pool on the left, the three skill
 * trees on the right. Points can be spent anywhere; refunds, swaps and god
 * changes need the fountain, like Smite's item shop.
 */
export class LoadoutMenu {
  readonly root: HTMLDivElement;
  private selectedSlot = 0;
  private message = '';
  private open_ = false;

  constructor(private readonly hooks: LoadoutMenuHooks) {
    this.root = document.createElement('div');
    this.root.className = 'lm';
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
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
    this.root.classList.remove('show');
    this.hooks.onClose();
  }

  /** Re-render when something the menu shows may have changed (cooldowns tick, level ups). */
  refresh(): void {
    if (this.open_) this.render();
  }

  private say(err: string | null): void {
    this.message = err ? (ERRORS[err as keyof typeof ERRORS] ?? err) : '';
    this.render();
  }

  private render(): void {
    const c = this.hooks.combatant();
    const g = c.god;
    const spent = pointsSpent(c.allocation);
    const budget = c.treeBudget;
    const base = c.inBase;
    this.root.innerHTML = `
      <div class="lm-panel">
        <header class="lm-head">
          <div>
            <div class="lm-title">${g.name}</div>
            <div class="lm-sub">${g.title} &middot; ${g.pantheon} &middot; ${g.role}</div>
          </div>
          <div class="lm-gods">${this.hooks.gods
            .map((d) => `<button class="lm-god${d.id === g.id ? ' on' : ''}" data-god="${d.id}" ${base ? '' : 'disabled'}>${d.name}</button>`)
            .join('')}</div>
          <button class="lm-close" data-close>Close &middot; K</button>
        </header>
        <div class="lm-bar">
          <span>Level <b>${c.level}</b></span>
          <span>Skill points <b>${spent}</b> / ${budget} earned (max ${MAX_TREE_POINTS})</span>
          <span class="${c.unspentPoints ? 'lm-glow' : ''}">${c.unspentPoints} to spend</span>
          <span class="lm-base ${base ? 'yes' : 'no'}">${base ? 'In base: swaps and refunds allowed' : 'In the field: you can only spend points'}</span>
          <span class="lm-practice">Practice:
            <button data-level="${Math.min(MAX_LEVEL, c.level + 1)}">+1 level</button>
            <button data-level="${MAX_LEVEL}">Level 20</button>
            <button data-favor>Max Favor</button>
          </span>
        </div>
        <div class="lm-msg">${this.message}</div>
        <div class="lm-body">
          <section class="lm-left">
            <h3>Loadout</h3>
            <div class="lm-slots">${[0, 1, 2, 3, 4].map((i) => this.slotHtml(c, i)).join('')}</div>
            <h3>${this.selectedSlot === ULTIMATE_SLOT ? 'Ultimate slot: any skill' : `Slot ${SLOT_KEYS[this.selectedSlot]}: regular skills`}</h3>
            <div class="lm-pool">${g.skills
              .filter((s) => this.selectedSlot === ULTIMATE_SLOT || s.kind === 'regular')
              .map((s) => this.poolHtml(c, s))
              .join('')}</div>
          </section>
          <section class="lm-trees">${g.trees.map((t) => this.treeHtml(c, t.id)).join('')}</section>
        </div>
      </div>`;
    this.bind(c);
  }

  private slotHtml(c: Combatant, i: number): string {
    const s = c.skillInSlot(i);
    const sel = i === this.selectedSlot ? ' sel' : '';
    return `<button class="lm-slot${sel}${i === ULTIMATE_SLOT ? ' ult' : ''}" data-slot="${i}">
      <span class="lm-ico">${s ? skillIcon(c.god.id, s) : ''}</span>
      <span class="lm-key">${SLOT_KEYS[i]}</span>
      <span class="lm-sname">${s?.name ?? 'Empty'}</span>
    </button>`;
  }

  private poolHtml(c: Combatant, s: SkillDef): string {
    const equipped = c.loadout.includes(s.id);
    const rank = Math.max(1, c.loadout.includes(s.id) ? c.skillRankInSlot(c.loadout.indexOf(s.id)) : 1);
    const cd = ranked(s.cooldown, rank);
    const cost = ranked(s.cost, rank);
    return `<button class="lm-skill${equipped ? ' equipped' : ''}${s.kind === 'ultimate' ? ' ult' : ''}" data-skill="${s.id}">
      <span class="lm-ico">${skillIcon(c.god.id, s)}</span>
      <span class="lm-sk-text">
        <span class="lm-sk-name">${s.name}${s.kind === 'ultimate' ? ' <em>Ultimate</em>' : ''}${equipped ? ' <em>Equipped</em>' : ''}</span>
        <span class="lm-sk-desc">${s.description}</span>
        <span class="lm-sk-meta">${s.tags.join(' &middot; ')} &middot; ${cd}s &middot; ${cost} mana</span>
      </span>
    </button>`;
  }

  private treeHtml(c: Combatant, treeId: string): string {
    const tree = c.god.trees.find((t) => t.id === treeId)!;
    const inTree = pointsInTree(c.trees, c.allocation, treeId);
    const tiers = [1, 2, 3, 4] as const;
    return `<div class="lm-tree">
      <h3>${tree.name} <span>${inTree}</span></h3>
      <div class="lm-theme">${tree.theme}</div>
      ${tiers
        .map((tier) => {
          const below = pointsInTree(c.trees, c.allocation, treeId, tier);
          const open = below >= TIER_REQUIREMENT[tier];
          const nodes = tree.nodes.filter((n) => n.tier === tier);
          return `<div class="lm-tier${open ? '' : ' locked'}${tier === 4 ? ' key' : ''}">
            ${open ? '' : `<span class="lm-req">${TIER_REQUIREMENT[tier]} pts in tree</span>`}
            ${nodes.map((n) => this.nodeHtml(c, n)).join('')}
          </div>`;
        })
        .join('')}
    </div>`;
  }

  private nodeHtml(c: Combatant, n: TreeNode): string {
    const r = c.allocation[n.id] ?? 0;
    return `<button class="lm-node${r ? ' taken' : ''}${r === n.maxRank ? ' max' : ''}" data-node="${n.id}" title="${n.description}">
      <span class="lm-n-name">${n.name}</span>
      <span class="lm-n-rank">${r}/${n.maxRank}</span>
      <span class="lm-n-desc">${n.description}</span>
    </button>`;
  }

  private bind(c: Combatant): void {
    const q = <T extends HTMLElement>(sel: string) => [...this.root.querySelectorAll<T>(sel)];
    q('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    q('[data-slot]').forEach((b) =>
      b.addEventListener('click', () => {
        this.selectedSlot = Number(b.dataset.slot);
        this.say(null);
      }),
    );
    q('[data-skill]').forEach((b) => b.addEventListener('click', () => this.say(c.swap(this.selectedSlot, b.dataset.skill!))));
    q('[data-node]').forEach((b) => {
      b.addEventListener('click', () => this.say(c.allocate(b.dataset.node!)));
      b.addEventListener('contextmenu', () => this.say(c.deallocate(b.dataset.node!)));
    });
    q('[data-god]').forEach((b) => b.addEventListener('click', () => this.say(this.hooks.switchGod(b.dataset.god!))));
    q('[data-level]').forEach((b) =>
      b.addEventListener('click', () => {
        this.hooks.practiceLevel(Number(b.dataset.level));
        this.say(null);
      }),
    );
    q('[data-favor]').forEach((b) =>
      b.addEventListener('click', () => {
        this.hooks.practiceFavor();
        this.say(null);
      }),
    );
  }
}
