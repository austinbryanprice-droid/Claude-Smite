import { hex, paletteFor } from '../combat/palette';
import type { SkillDef } from '../game/types';

/**
 * Procedural skill icons: a glyph for what the skill does, drawn over a
 * radial glow in the god's spell color. Ultimates get a gold frame.
 * Everything is inline SVG, so there are no image assets to license.
 */
const GLYPHS = {
  // a comet: orb with a streak
  projectile: '<circle cx="40" cy="24" r="9"/><path d="M33 31 L12 52 M37 35 L20 54 M29 27 L10 46" stroke-width="4" stroke-linecap="round" fill="none"/>',
  // a spear
  line: '<path d="M10 54 L44 20" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M40 14 L54 10 L50 24 Z"/>',
  // a fan of blades
  cone: '<path d="M32 54 L12 16 M32 54 L32 10 M32 54 L52 16" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M14 18 A26 26 0 0 1 50 18" stroke-width="3" fill="none"/>',
  // a target circle with a strike
  ground: '<ellipse cx="32" cy="44" rx="20" ry="8" stroke-width="4" fill="none"/><path d="M36 6 L26 26 L34 26 L28 44 L42 20 L34 20 L40 6 Z"/>',
  // a nova
  nova: '<circle cx="32" cy="32" r="8"/><path d="M32 8 V18 M32 46 V56 M8 32 H18 M46 32 H56 M15 15 L22 22 M42 42 L49 49 M49 15 L42 22 M22 42 L15 49" stroke-width="4" stroke-linecap="round" fill="none"/>',
  // twin chevrons
  dash: '<path d="M12 16 L28 32 L12 48 M30 16 L46 32 L30 48" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M48 22 L56 32 L48 42" stroke-width="3" fill="none"/>',
  // an arcing leap
  leap: '<path d="M8 50 Q32 2 54 46" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M46 44 L56 50 L58 38 Z"/><ellipse cx="54" cy="52" rx="8" ry="3"/>',
  // an ankh
  ally: '<ellipse cx="32" cy="18" rx="8" ry="10" stroke-width="5" fill="none"/><path d="M32 28 V56 M18 32 H46" stroke-width="5" stroke-linecap="round" fill="none"/>',
  shield: '<path d="M32 8 L52 16 V30 C52 44 42 52 32 56 C22 52 12 44 12 30 V16 Z" stroke-width="4" fill="none"/><path d="M32 18 V46 M22 28 H42" stroke-width="3" fill="none"/>',
  heal: '<path d="M26 12 H38 V26 H52 V38 H38 V52 H26 V38 H12 V26 H26 Z"/>',
  buff: '<path d="M32 8 L50 30 H38 V56 H26 V30 H14 Z"/>',
  stealth: '<path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="7"/><path d="M12 52 L52 12" stroke-width="4" stroke-linecap="round"/>',
  summon: '<circle cx="22" cy="20" r="7"/><circle cx="42" cy="20" r="7"/><path d="M10 50 C10 34 34 34 34 50 M30 50 C30 34 54 34 54 50" stroke-width="4" fill="none"/>',
} as const;

type Glyph = keyof typeof GLYPHS;

export function glyphFor(skill: SkillDef): Glyph {
  const effects = skill.effects.map((e) => e.kind);
  if (effects.includes('summon')) return 'summon';
  if (effects.includes('stealth') && skill.targeting.type === 'self') return 'stealth';
  switch (skill.targeting.type) {
    case 'projectile':
      return 'projectile';
    case 'line':
      return 'line';
    case 'cone':
      return 'cone';
    case 'ground':
      return 'ground';
    case 'dash':
      return 'dash';
    case 'leap':
      return 'leap';
    case 'ally':
      return 'ally';
    case 'self':
      if (skill.targeting.radius !== undefined && effects.includes('damage')) return 'nova';
      if (effects.includes('shield')) return 'shield';
      if (effects.includes('heal')) return 'heal';
      return 'buff';
  }
}

export function skillIcon(godId: string, skill: SkillDef): string {
  const p = paletteFor(godId);
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const ult = skill.kind === 'ultimate';
  const frame = ult
    ? `<rect x="2" y="2" width="60" height="60" rx="8" fill="none" stroke="url(#${id}f)" stroke-width="4"/>`
    : `<rect x="1.5" y="1.5" width="61" height="61" rx="8" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>`;
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <radialGradient id="${id}b" cx="50%" cy="42%" r="70%">
        <stop offset="0" stop-color="${hex(p.vfx)}" stop-opacity="0.95"/>
        <stop offset="0.55" stop-color="${hex(p.vfx)}" stop-opacity="0.35"/>
        <stop offset="1" stop-color="#07060a"/>
      </radialGradient>
      <linearGradient id="${id}f" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff1b8"/><stop offset="0.5" stop-color="#d9a23a"/><stop offset="1" stop-color="#7a4f12"/>
      </linearGradient>
      <filter id="${id}g" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="2.2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="64" height="64" rx="9" fill="url(#${id}b)"/>
    <g fill="${hex(p.core)}" stroke="${hex(p.core)}" filter="url(#${id}g)">${GLYPHS[glyphFor(skill)]}</g>
    ${frame}
  </svg>`;
}
