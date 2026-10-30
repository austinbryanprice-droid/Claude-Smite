// The trailer's edit: draws any moment of it with `window.renderAt(t)`, so
// render.mjs can step through it frame by frame. Footage comes from film.mjs
// (out/frames), the rest is drawn here from the game's own data and icons.
// Served by Vite so it can import the game's modules.

import { GODS } from '../../src/game/gods';
import type { GodDef, SkillDef } from '../../src/game/types';
import { skillIcon, talentIcon } from '../../src/ui/icons';
import { paletteFor } from '../../src/combat/palette';
// @ts-expect-error plain JS module shared with score.ts
import { FINALE, HEROES, LENGTH, TITLE, VOICE } from './timeline.mjs';
import script from './script.json';

const W = 1920;
const H = 1080;
const FILM_FPS = 30;
const stage = document.getElementById('stage')!;
const lengths: Record<string, number> = await fetch('./out/voice/lengths.json').then((r) => r.json());

// ---------------------------------------------------------------------------
// Helpers

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x: number) => {
  const k = clamp(x);
  return k * k * (3 - 2 * k);
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
/** 0 → 1 over [a, a+fadeIn], 1 → 0 over [b-fadeOut, b]. */
const window01 = (t: number, a: number, b: number, fadeIn = 0.35, fadeOut = 0.35) => Math.min(clamp((t - a) / fadeIn), clamp((b - t) / fadeOut));

/** When a word is spoken: its share of the line's characters, a rough but steady clock. */
function word(id: keyof typeof VOICE, w: string): number {
  const line = script.lines.find((l) => l.id === id)!;
  const i = line.text.indexOf(w);
  return VOICE[id] + (lengths[id] ?? 2) * ((i < 0 ? 0 : i) / line.text.length) * 0.94 + 0.08;
}

function el(cls: string, html = '', parent: HTMLElement = stage): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  parent.appendChild(d);
  return d;
}
function show(e: HTMLElement, o: number, transform = ''): void {
  e.style.opacity = String(o);
  e.style.display = o <= 0.001 ? 'none' : '';
  e.style.transform = transform;
}

// ---------------------------------------------------------------------------
// Footage: film.mjs frames, blended between neighbours when slowed down

const frameCount = new Map<string, number>();
async function countFrames(shot: string): Promise<number> {
  if (frameCount.has(shot)) return frameCount.get(shot)!;
  let lo = 0;
  let hi = 400;
  // binary search the last frame that exists
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const ok = await fetch(`./out/frames/${shot}/${String(mid).padStart(4, '0')}.jpg`, { method: 'HEAD' }).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('image'));
    if (ok) lo = mid;
    else hi = mid - 1;
  }
  const exists = await fetch(`./out/frames/${shot}/0000.jpg`, { method: 'HEAD' }).then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('image'));
  const n = exists ? lo + 1 : 0;
  frameCount.set(shot, n);
  return n;
}

const images = new Map<string, Promise<HTMLImageElement>>();
function image(src: string): Promise<HTMLImageElement> {
  let p = images.get(src);
  if (!p) {
    const img = new Image();
    img.src = src;
    p = img.decode().then(() => img);
    images.set(src, p);
    if (images.size > 80) images.delete(images.keys().next().value!);
  }
  return p;
}

const canvas = document.createElement('canvas');
canvas.width = W;
canvas.height = H;
stage.appendChild(canvas);
const ctx = canvas.getContext('2d')!;

interface Clip {
  shot: string;
  start: number;
  end: number;
  /** Footage seconds per trailer second. */
  speed?: number;
  /** Footage second to start from. */
  from?: number;
  /** Zoom at the start and end (Ken Burns), and drift in pixels. */
  zoom?: [number, number];
  drift?: [number, number];
  /** Brightness multiplier (dims footage under overlays). */
  dim?: number;
  blur?: number;
}

async function drawClip(c: Clip, t: number, alpha: number): Promise<void> {
  const n = await countFrames(c.shot);
  const local = t - c.start;
  const k = (c.end - c.start) > 0 ? local / (c.end - c.start) : 0;
  const z = c.zoom ? c.zoom[0] + (c.zoom[1] - c.zoom[0]) * ease(k) : 1.04;
  const dx = (c.drift?.[0] ?? 0) * (k - 0.5);
  const dy = (c.drift?.[1] ?? 0) * (k - 0.5);
  ctx.save();
  ctx.globalAlpha = alpha;
  const dim = c.dim ?? 1;
  ctx.filter = `contrast(1.08) saturate(1.12) brightness(${dim})${c.blur ? ` blur(${c.blur}px)` : ''}`;
  ctx.translate(W / 2 + dx, H / 2 + dy);
  ctx.scale(z, z);
  if (n === 0) {
    // not filmed yet: a placeholder so the edit still renders
    const g = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
    g.addColorStop(0, '#2a3446');
    g.addColorStop(1, '#3a2a1a');
    ctx.fillStyle = g;
    ctx.fillRect(-W / 2, -H / 2, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '40px Cinzel';
    ctx.textAlign = 'center';
    ctx.fillText(c.shot, 0, 0);
  } else {
    const f = clamp(((c.from ?? 0) + local * (c.speed ?? 1)) * FILM_FPS, 0, n - 1);
    const i = Math.floor(f);
    const frac = f - i;
    const a = await image(`./out/frames/${c.shot}/${String(i).padStart(4, '0')}.jpg`);
    ctx.drawImage(a, -W / 2, -H / 2, W, H);
    if (frac > 0.02 && i + 1 < n) {
      const b = await image(`./out/frames/${c.shot}/${String(i + 1).padStart(4, '0')}.jpg`);
      ctx.globalAlpha = alpha * frac;
      ctx.drawImage(b, -W / 2, -H / 2, W, H);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The edit

const H0 = HEROES[0].at;
const CONQ = VOICE.conquest - 0.4;
const clips: Clip[] = [
  { shot: 'cqVista', start: 0.7, end: 5.25, speed: 0.6, zoom: [1.12, 1.02] },
  { shot: 'brawlA', start: 5.25, end: 5.95, speed: 1, from: 0.4, zoom: [1.08, 1.0] },
  { shot: 'heroThor', start: 5.95, end: 6.65, speed: 1, from: 0.2, zoom: [1.0, 1.1] },
  { shot: 'brawlB', start: 6.65, end: TITLE, speed: 1, from: 1.0, zoom: [1.1, 1.0] },
  ...HEROES.map((h: { god: string; at: number }, i: number) => ({ shot: `hero${h.god[0]!.toUpperCase()}${h.god.slice(1)}`, start: h.at, end: i < 4 ? HEROES[i + 1].at : VOICE.skills1 - 0.4, speed: 0.78, zoom: [1.0, 1.06] as [number, number] })),
  { shot: 'brawlA', start: VOICE.skills1 - 0.4, end: VOICE.skills2 - 0.4, speed: 0.55, from: 0.3, zoom: [1.0, 1.08], dim: 0.5 },
  { shot: 'heroZeus', start: VOICE.skills2 - 0.4, end: VOICE.trees - 0.4, speed: 0.2, from: 0.3, zoom: [1.1, 1.0], dim: 0.38, blur: 3 },
  { shot: 'brawlB', start: VOICE.trees - 0.4, end: CONQ, speed: 0.25, from: 0.2, zoom: [1.0, 1.1], dim: 0.36, blur: 3 },
  { shot: 'cqClash', start: CONQ, end: word('conquest', 'Break') - 0.2, speed: 0.75, zoom: [1.08, 1.0] },
  { shot: 'cqTower', start: word('conquest', 'Break') - 0.2, end: word('conquest', 'burn') - 0.15, speed: 0.8, zoom: [1.0, 1.08] },
  { shot: 'cqPhoenix', start: word('conquest', 'burn') - 0.15, end: word('conquest', 'topple') - 0.15, speed: 0.8, zoom: [1.06, 1.0] },
  { shot: 'cqTitan', start: word('conquest', 'topple') - 0.15, end: VOICE.jungle - 0.4, speed: 0.75, zoom: [1.0, 1.08] },
  { shot: 'cqJungle', start: VOICE.jungle - 0.4, end: VOICE.bosses - 0.4, speed: 0.7, zoom: [1.0, 1.06] },
  { shot: 'cqWyrm', start: VOICE.bosses - 0.4, end: word('bosses', 'and the') , speed: 0.7, zoom: [1.06, 1.0] },
  { shot: 'cqColossus', start: word('bosses', 'and the'), end: VOICE.multi - 0.4, speed: 0.7, zoom: [1.0, 1.07] },
  { shot: 'cqFight', start: VOICE.multi - 0.4, end: VOICE.close1 - 0.3, speed: 0.75, zoom: [1.0, 1.08] },
  { shot: 'heroZeus', start: VOICE.close1 - 0.3, end: FINALE, speed: 0.4, from: 0.5, zoom: [1.0, 1.15], dim: 0.75 },
];
/** Crossfade length at each cut (0 = hard cut). */
const XF = 0.12;

// Title
const title = el('title gold', 'ASCENDANT');
const subtitle = el('subtitle', 'A WAR OF GODS');

// Choose your god: the title screen's face cards
const faces = el('faces', GODS.map((g) => `<div class="face"><img src="/portraits/${g.id}.jpg"><b>${g.name}</b></div>`).join(''));
const faceEls = [...faces.children] as HTMLElement[];

// Hero name cards
const ROLE: Record<string, string> = { solo: 'Solo', jungle: 'Jungle', mid: 'Mid', carry: 'Carry', support: 'Support' };
const cards = HEROES.map((h: { god: string }) => {
  const g = GODS.find((d) => d.id === h.god)!;
  return el('card', `<div class="name gold">${g.name.toUpperCase()}</div><div class="rule"></div><div class="sub">${g.title.toUpperCase()} &nbsp;·&nbsp; ${ROLE[g.role] ?? g.role}</div>`);
});

// Five skills: Zeus's loadout
const zeus = GODS.find((g) => g.id === 'zeus')!;
const skillOf = (g: GodDef, id: string) => g.skills.find((s) => s.id === id)!;
const loadout = zeus.defaultLoadout.map((id) => skillOf(zeus, id));
const KEYS = ['1', '2', '3', '4', 'R'];
const slotHtml = (s: SkillDef, i: number) => `<div class="slot${i === 4 ? ' ult' : ''}"><div class="key">${KEYS[i]}</div><div class="ico">${skillIcon(zeus.id, s)}</div><div class="sn">${s.name}</div></div>`;
const bar = el('bar', loadout.map(slotHtml).join(''));
const slots = [...bar.children] as HTMLElement[];
const skillsHeading = el('heading gold', 'FIVE SKILLS');

// The pool: every skill Zeus knows, and a swap into the ultimate slot
const pool = el('pool', zeus.skills.map((s) => `<div class="p${s.kind === 'ultimate' ? ' ult' : ''}"><div class="ico">${skillIcon(zeus.id, s)}</div><div class="sn">${s.name}</div></div>`).join(''));
const poolEls = [...pool.children] as HTMLElement[];
const poolHeading = el('heading gold', 'ELEVEN SKILLS · YOUR CHOICE');
const swapIn = zeus.skills.find((s) => s.kind === 'ultimate' && s.id !== zeus.defaultLoadout[4])!;
const swapBar = el('bar', loadout.map((s, i) => slotHtml(i === 4 ? swapIn : s, i)).join(''));
swapBar.style.top = '700px';
const swapSlots = [...swapBar.children] as HTMLElement[];
const swapIdx = zeus.skills.indexOf(swapIn);

// Trees
const accent = '#' + paletteFor(zeus.id).vfx.toString(16).padStart(6, '0');
const trees = el('trees', zeus.trees.map((tr) => `<div class="tree"><h4>${tr.name.toUpperCase()}</h4><div class="theme">${tr.theme}</div>${[1, 2, 3, 4].map((tier) => `<div class="tier">${tr.nodes.filter((n) => n.tier === tier).map((n) => `<div class="node" data-max="${n.maxRank}">${talentIcon(zeus.id, n, zeus.skills, accent)}<span class="rk"></span></div>`).join('')}</div>`).join('')}</div>`).join(''));
const treeEls = [...trees.children] as HTMLElement[];
const nodeEls = treeEls.map((t) => [...t.querySelectorAll<HTMLElement>('.node')]);
const treesHeading = el('heading gold', 'THREE SKILL TREES');
const points = el('points gold', '');

// Chips over the game footage
const chips = el('chips');
function setChips(items: [string, number][], t: number): void {
  const html = items.map(([s]) => `<div class="chip">${s}</div>`).join('');
  if (chips.dataset.html !== html) {
    chips.innerHTML = html;
    chips.dataset.html = html;
  }
  [...chips.children].forEach((c, i) => show(c as HTMLElement, easeOut((t - items[i]![1]) / 0.3), `translateY(${(1 - easeOut((t - items[i]![1]) / 0.3)) * 30}px)`));
  show(chips, items.length ? 1 : 0);
}
const bossCard = el('card', '<div class="name gold"></div><div class="rule"></div><div class="sub"></div>');

const vignette = el('bars');
const caption = el('caption');
const flash = el('flash');

// embers drifting over the title and the end card
const embers = Array.from({ length: 70 }, (_, i) => {
  const r = (k: number) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: r(1) * W, y: r(2) * H, s: 1 + r(3) * 3, v: 30 + r(4) * 80, w: r(5) * 6.28 };
});
function drawEmbers(t: number, alpha: number): void {
  if (alpha <= 0) return;
  ctx.save();
  for (const e of embers) {
    const y = ((e.y - e.v * t) % H + H) % H;
    const x = e.x + Math.sin(t * 0.8 + e.w) * 30;
    const a = alpha * (0.4 + 0.6 * Math.abs(Math.sin(t * 2 + e.w)));
    const g = ctx.createRadialGradient(x, y, 0, x, y, e.s * 4);
    g.addColorStop(0, `rgba(255, 210, 130, ${a})`);
    g.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - e.s * 4, y - e.s * 4, e.s * 8, e.s * 8);
  }
  ctx.restore();
}

function backdrop(t: number, alpha: number): void {
  // a dark stormy sky behind the title cards
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(W / 2, H * 0.45, 50, W / 2, H * 0.5, W * 0.7);
  g.addColorStop(0, '#3a2a18');
  g.addColorStop(0.5, '#140e0a');
  g.addColorStop(1, '#030202');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  drawEmbers(t, alpha);
}

/** Captions: each line cut into sentences (and long ones at commas), timed by their share of the line. */
const phrases = script.lines.flatMap((l) => {
  const at = VOICE[l.id as keyof typeof VOICE];
  const len = lengths[l.id] ?? 2;
  const parts: string[] = [];
  for (const sentence of l.text.match(/[^.]+\.?/g) ?? [l.text]) {
    const s = sentence.trim();
    if (s.length <= 64) parts.push(s);
    else {
      let cur = '';
      for (const bit of s.split(/(?<=,) /)) {
        if (cur && (cur + ' ' + bit).length > 64) {
          parts.push(cur);
          cur = bit;
        } else cur = cur ? cur + ' ' + bit : bit;
      }
      if (cur) parts.push(cur);
    }
  }
  let c = 0;
  return parts.map((text) => {
    const start = at + (len * c) / l.text.length;
    c += text.length + 1;
    return { text, at: start, end: at + (len * Math.min(c, l.text.length)) / l.text.length };
  });
});

// ---------------------------------------------------------------------------

async function renderAt(t: number): Promise<void> {
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // footage, crossfading into each new clip
  for (const c of clips) {
    if (t < c.start - XF || t >= c.end) continue;
    const a = clamp((t - (c.start - XF)) / XF);
    await drawClip(c, t, a);
  }
  // fade up from black at the start, and the title and end cards' sky
  if (t < 1.4) {
    ctx.fillStyle = `rgba(0,0,0,${1 - clamp((t - 0.7) / 0.7)})`;
    ctx.fillRect(0, 0, W, H);
  }
  const titleA = window01(t, TITLE, H0 - 2.0, 0.05, 0.5);
  const chooseA = window01(t, H0 - 2.0, H0, 0.3, 0.12);
  backdrop(t, Math.max(titleA, chooseA));
  const endA = clamp((t - FINALE) / 0.08);
  backdrop(t, endA);

  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  // title
  const tt = t - TITLE;
  show(title, titleA, `scale(${1.18 - 0.18 * easeOut(tt / 2.6)})`);
  show(subtitle, window01(t, TITLE + 0.9, H0 - 2.0, 0.6, 0.5), `translateY(${(1 - easeOut((tt - 0.9) / 0.6)) * 16}px)`);
  // end card
  if (t >= FINALE) {
    show(title, endA, `scale(${1.12 - 0.12 * easeOut((t - FINALE) / 3)})`);
    show(subtitle, clamp((t - FINALE - 1.2) / 0.8));
    subtitle.textContent = 'ENTER THE BATTLE';
  } else subtitle.textContent = 'A WAR OF GODS';

  // choose your god
  faceEls.forEach((f, i) => show(f, chooseA * easeOut((t - (H0 - 2.0) - i * 0.12) / 0.4), `translateY(${(1 - easeOut((t - (H0 - 2.0) - i * 0.12) / 0.5)) * 60}px)`));
  show(faces, chooseA);

  // hero name cards
  cards.forEach((c: HTMLElement, i: number) => {
    const at = HEROES[i].at + 0.25;
    const end = i < 4 ? HEROES[i + 1].at : VOICE.skills1 - 0.4;
    show(c, window01(t, at, end, 0.3, 0.25), `translateX(${(1 - easeOut((t - at) / 0.45)) * -60}px)`);
  });

  // five skills
  const s1 = window01(t, VOICE.skills1 - 0.2, VOICE.skills2 - 0.4, 0.3, 0.3);
  show(skillsHeading, s1);
  show(bar, s1);
  const four = word('skills1', 'Four');
  const ult = word('skills1', 'one ultimate');
  slots.forEach((s, i) => {
    const at = VOICE.skills1 + 0.3 + i * 0.22;
    const lit = i < 4 ? window01(t, four, ult, 0.15, 0.2) : clamp((t - ult) / 0.2);
    s.style.filter = lit > 0 ? `drop-shadow(0 0 ${18 * lit}px rgba(255, 210, 120, ${0.9 * lit}))` : '';
    show(s, easeOut((t - at) / 0.35), `translateY(${(1 - easeOut((t - at) / 0.35)) * 40}px) scale(${1 + 0.06 * lit})`);
  });

  // eleven skills and the swap
  const s2 = window01(t, VOICE.skills2 - 0.2, VOICE.trees - 0.4, 0.3, 0.3);
  show(pool, s2);
  show(poolHeading, s2);
  show(swapBar, s2);
  const swapAt = word('skills2', 'Swap');
  const evenAt = word('skills2', 'even your');
  poolEls.forEach((p, i) => {
    const at = VOICE.skills2 + 0.4 + i * 0.12;
    const hl = i === swapIdx ? window01(t, swapAt, evenAt + 1.6, 0.2, 0.3) : 0;
    p.style.filter = hl > 0 ? `drop-shadow(0 0 ${20 * hl}px rgba(255, 210, 120, ${hl}))` : '';
    show(p, easeOut((t - at) / 0.3), `translateY(${(1 - easeOut((t - at) / 0.3)) * 30}px) scale(${1 + 0.1 * hl})`);
  });
  swapSlots.forEach((s, i) => {
    const at = VOICE.skills2 + 1.6 + i * 0.1;
    if (i < 4) return show(s, easeOut((t - at) / 0.3));
    // the ultimate slot: the default ultimate first, then the swapped one drops in
    const k = easeOut((t - evenAt) / 0.45);
    s.querySelector('.ico')!.innerHTML = skillIcon(zeus.id, t < evenAt ? loadout[4]! : swapIn);
    s.querySelector('.sn')!.textContent = t < evenAt ? loadout[4]!.name : swapIn.name;
    const glow = window01(t, evenAt, evenAt + 2.2, 0.1, 0.6);
    s.style.filter = glow > 0 ? `drop-shadow(0 0 ${26 * glow}px rgba(255, 200, 100, ${glow}))` : '';
    show(s, easeOut((t - at) / 0.3), t >= evenAt ? `translateY(${(1 - k) * -90}px) scale(${1 + 0.12 * (1 - k) + 0.05 * glow})` : '');
  });

  // trees: points flow into the nodes until all 35 are spent
  const s3 = window01(t, VOICE.trees - 0.2, CONQ, 0.3, 0.3);
  show(trees, s3);
  show(treesHeading, s3);
  show(points, s3);
  const spendStart = VOICE.trees + 1.0;
  const spendEnd = word('trees', 'Mix');
  const spent = Math.round(35 * clamp((t - spendStart) / (spendEnd - spendStart)));
  points.textContent = `POINTS SPENT  ${spent} / 35`;
  // a fixed spending order across the three trees (mix and match)
  const order: [number, number][] = [];
  const plan = [[0, 0], [1, 0], [0, 1], [2, 0], [1, 1], [0, 2], [2, 1], [1, 2], [0, 3], [2, 2], [1, 3], [2, 3], [0, 4], [1, 4], [2, 4]];
  for (const [tr, n] of plan) {
    const node = nodeEls[tr]?.[n];
    if (!node) continue;
    for (let r = 0; r < Number(node.dataset.max); r++) order.push([tr, n]);
  }
  const ranks = nodeEls.map((ns) => ns.map(() => 0));
  for (let k = 0; k < Math.min(spent, order.length); k++) ranks[order[k]![0]]![order[k]![1]]!++;
  nodeEls.forEach((ns, tr) => ns.forEach((n, i) => {
    const r = ranks[tr]![i]!;
    n.style.borderColor = r ? '#f0c977' : '#5a4424';
    n.style.filter = r ? 'none' : 'grayscale(0.85) brightness(0.55)';
    n.style.boxShadow = r ? '0 0 18px rgba(255, 200, 100, 0.55)' : 'none';
    n.querySelector('.rk')!.textContent = r ? `${r}/${n.dataset.max}` : '';
  }));
  treeEls.forEach((e, i) => show(e, s3 * easeOut((t - VOICE.trees - i * 0.2) / 0.4), `translateY(${(1 - easeOut((t - VOICE.trees - i * 0.2) / 0.4)) * 40}px)`));

  // chips over the game
  const C = (s: string, id: keyof typeof VOICE, w: string): [string, number] => [s, word(id, w)];
  if (t >= CONQ && t < VOICE.jungle - 0.4) setChips([C('5 V 5', 'conquest', 'Five'), C('3 LANES', 'conquest', 'three lanes'), C('TOWERS', 'conquest', 'towers'), C('PHOENIXES', 'conquest', 'Phoenixes'), C('TITAN', 'conquest', 'Titan')], t);
  else if (t >= VOICE.jungle - 0.4 && t < VOICE.bosses - 0.4) setChips([C('MIGHT', 'jungle', 'camps'), ['WISDOM', word('jungle', 'camps') + 0.15], ['SWIFTNESS', word('jungle', 'camps') + 0.3], ['INSIGHT', word('jungle', 'camps') + 0.45]], t);
  else if (t >= VOICE.multi - 0.4 && t < VOICE.close1 - 0.3) setChips([C('CO-OP', 'multi', 'beside'), C('VERSUS', 'multi', 'against'), C('PLAY WITH FRIENDS', 'multi', 'in co-op')], t);
  else setChips([], t);
  const chipsFade = Math.min(window01(t, CONQ, VOICE.jungle - 0.4, 0.2, 0.25), 1) || window01(t, VOICE.jungle - 0.4, VOICE.bosses - 0.4, 0.2, 0.25) || window01(t, VOICE.multi - 0.4, VOICE.close1 - 0.3, 0.2, 0.25);
  chips.style.opacity = String(chipsFade);

  // boss and section name cards
  const cardFor = (a: number, b: number, name: string, sub: string) => {
    if (t < a || t >= b) return false;
    bossCard.querySelector('.name')!.textContent = name;
    bossCard.querySelector('.sub')!.textContent = sub;
    show(bossCard, window01(t, a, b, 0.3, 0.25), `translateX(${(1 - easeOut((t - a) / 0.45)) * -60}px)`);
    return true;
  };
  const wyrmAt = VOICE.bosses - 0.1;
  const colAt = word('bosses', 'and the');
  if (!cardFor(VOICE.jungle - 0.1, VOICE.bosses - 0.4, 'THE JUNGLE', 'HUNT CAMPS FOR BUFFS') && !cardFor(wyrmAt, colAt - 0.05, 'TREASURE WYRM', 'BOSS · GOLD AND GLORY') && !cardFor(colAt + 0.15, VOICE.multi - 0.4, 'MOLTEN COLOSSUS', "BOSS · THE COLOSSUS'S FURY") && !cardFor(CONQ + 0.1, word('conquest', 'Break') - 0.3, 'CONQUEST', 'THE MAIN EVENT')) show(bossCard, 0);

  // letterbox bars while the game is on screen, gone for the title and the menus
  const ui = Math.max(titleA, chooseA, s1, s2, s3, endA);
  show(vignette, 1 - ui);

  // captions: the phrase being spoken, one line at a time
  let cap = '';
  for (const c of phrases) if (t >= c.at - 0.1 && t < c.end + 0.25) cap = c.text;
  caption.textContent = cap;
  show(caption, cap ? 1 : 0);

  // white flashes: the first lightning, the title hit, the montage cuts, the last hit
  const flashAt = [0.55, TITLE, 5.25, 5.95, 6.65, FINALE];
  let f = 0;
  for (const a of flashAt) if (t >= a) f = Math.max(f, (a === TITLE || a === FINALE || a === 0.55 ? 0.95 : 0.45) * Math.exp(-(t - a) * (a === 0.55 ? 6 : 8)));
  show(flash, f);
  // fade to black at the very end
  if (t > LENGTH - 1.2) {
    flash.style.background = '#000';
    show(flash, clamp((t - (LENGTH - 1.2)) / 1.0));
  } else flash.style.background = '#fff';
}

await document.fonts.ready;
(window as unknown as { renderAt: typeof renderAt; ready: boolean }).renderAt = renderAt;
(window as unknown as { ready: boolean }).ready = true;
