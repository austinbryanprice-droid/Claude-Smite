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
  // themed glyphs, picked by the skill's name
  bolt: '<path d="M38 4 L16 34 H30 L22 60 L48 26 H34 L44 4 Z"/>',
  cyclone: '<path d="M10 14 H54 M14 24 H48 M20 34 H44 M24 44 H38 M28 54 H34" stroke-width="5" stroke-linecap="round" fill="none"/>',
  cloud: '<path d="M16 46 A10 10 0 0 1 16 26 A13 13 0 0 1 40 20 A11 11 0 0 1 50 46 Z"/><path d="M18 54 H46" stroke-width="3" stroke-linecap="round"/>',
  hammer: '<rect x="12" y="8" width="40" height="18" rx="3"/><path d="M32 26 V58" stroke-width="7" stroke-linecap="round"/><path d="M26 58 H38" stroke-width="4" stroke-linecap="round"/>',
  spin: '<path d="M32 12 A20 20 0 1 1 13 26" stroke-width="5" stroke-linecap="round" fill="none"/><path d="M8 18 L14 30 L22 20 Z"/><circle cx="32" cy="32" r="6"/>',
  raven: '<path d="M6 30 Q20 14 32 26 Q44 14 58 30 Q46 26 38 32 L44 44 L32 38 L20 44 L26 32 Q18 26 6 30 Z"/><circle cx="32" cy="24" r="4"/>',
  eye: '<path d="M6 32 Q32 8 58 32 Q32 56 6 32 Z" stroke-width="4" fill="none"/><circle cx="32" cy="32" r="9"/><path d="M32 6 V14 M32 50 V58" stroke-width="3" stroke-linecap="round"/>',
  rune: '<path d="M22 8 V56 M22 12 L42 26 L22 38 M22 38 L44 54" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  dagger: '<path d="M32 4 L38 34 H26 Z"/><path d="M18 36 H46" stroke-width="5" stroke-linecap="round"/><path d="M32 38 V54" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="58" r="3.5"/>',
  smoke: '<circle cx="22" cy="38" r="12"/><circle cx="38" cy="30" r="14"/><circle cx="44" cy="46" r="9"/><circle cx="18" cy="20" r="5" opacity="0.7"/>',
  mask: '<path d="M10 16 Q32 8 54 16 Q54 44 32 56 Q10 44 10 16 Z" stroke-width="4" fill="none"/><path d="M18 28 Q24 22 28 30 Z M46 28 Q40 22 36 30 Z"/><path d="M24 44 Q32 38 40 44" stroke-width="3" fill="none"/>',
  rift: '<path d="M30 4 L24 18 L34 26 L22 40 L30 46 L26 60 M30 46 L40 52 M34 26 L44 22" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  swarm: '<ellipse cx="18" cy="20" rx="6" ry="4"/><ellipse cx="40" cy="14" rx="6" ry="4"/><ellipse cx="30" cy="32" rx="7" ry="5"/><ellipse cx="48" cy="34" rx="5" ry="3.5"/><ellipse cx="16" cy="44" rx="6" ry="4"/><ellipse cx="38" cy="50" rx="6" ry="4"/><path d="M12 16 L8 12 M46 10 L50 6 M24 28 L20 24" stroke-width="2"/>',
  wrap: '<path d="M18 10 Q32 4 46 10 V54 Q32 60 18 54 Z" stroke-width="3" fill="none"/><path d="M16 18 L48 26 M16 30 L48 22 M16 34 L48 42 M16 46 L48 38" stroke-width="4" stroke-linecap="round"/>',
  hand: '<path d="M18 58 V30 Q18 26 22 26 Q26 26 26 30 V14 Q26 10 30 10 Q34 10 34 14 V28 V12 Q34 8 38 8 Q42 8 42 12 V30 V18 Q42 14 46 14 Q50 14 50 18 V40 Q50 52 40 58 Z"/>',
  horn: '<path d="M10 42 Q14 18 40 14 L46 20 Q24 26 20 46 Z"/><path d="M50 26 Q56 32 50 40 M54 20 Q64 32 54 46" stroke-width="3" stroke-linecap="round" fill="none"/>',
  scales: '<path d="M32 8 V54 M14 54 H50 M12 20 H52" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M6 36 L12 20 L18 36 Z M46 36 L52 20 L58 36 Z" stroke-width="2"/><path d="M4 36 Q12 44 20 36 Z M44 36 Q52 44 60 36 Z"/>',
  wings: '<path d="M32 30 Q18 8 4 14 Q10 22 8 28 Q16 30 14 38 Q24 36 32 44 Q40 36 50 38 Q48 30 56 28 Q54 22 60 14 Q46 8 32 30 Z"/><circle cx="32" cy="52" r="5"/>',
  orb: '<circle cx="32" cy="32" r="13"/><path d="M32 6 L28 14 L34 16 M56 30 L48 28 L48 34 M10 38 L18 36 L16 30 M40 56 L36 48 L42 46" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  stormcloud: '<path d="M14 34 A9 9 0 0 1 14 18 A12 12 0 0 1 36 12 A10 10 0 0 1 48 34 Z"/><path d="M34 34 L26 46 H34 L28 60 L42 42 H34 L40 34 Z"/>',
  chain: '<rect x="6" y="24" width="20" height="14" rx="7" stroke-width="4" fill="none" transform="rotate(-25 16 31)"/><rect x="22" y="24" width="20" height="14" rx="7" stroke-width="4" fill="none" transform="rotate(-25 32 31)"/><rect x="38" y="24" width="20" height="14" rx="7" stroke-width="4" fill="none" transform="rotate(-25 48 31)"/>',
  crown: '<path d="M10 44 L8 18 L22 30 L32 12 L42 30 L56 18 L54 44 Z"/><path d="M10 52 H54" stroke-width="5" stroke-linecap="round"/>',
  slam: '<rect x="18" y="6" width="28" height="14" rx="3"/><path d="M32 20 V40" stroke-width="6" stroke-linecap="round"/><path d="M8 54 H56 M12 44 L4 38 M52 44 L60 38 M20 48 L16 40 M44 48 L48 40" stroke-width="4" stroke-linecap="round"/>',
  skull: '<path d="M32 6 C16 6 10 18 10 28 C10 36 16 40 18 42 V52 H46 V42 C48 40 54 36 54 28 C54 18 48 6 32 6 Z"/><circle cx="23" cy="28" r="6" fill="#07060a" stroke="none"/><circle cx="41" cy="28" r="6" fill="#07060a" stroke="none"/><path d="M26 52 V58 M32 52 V58 M38 52 V58" stroke-width="3"/>',
  poison: '<path d="M26 4 L32 30 H20 Z"/><path d="M14 32 H38" stroke-width="5" stroke-linecap="round"/><path d="M26 34 V46" stroke-width="5" stroke-linecap="round"/><path d="M46 30 C46 30 38 42 38 48 A8 8 0 0 0 54 48 C54 42 46 30 46 30 Z"/>',
  anvil: '<path d="M8 18 H48 Q58 18 58 26 H44 L40 34 H24 L20 26 H8 Z"/><path d="M22 34 H42 L46 52 H18 Z"/>',
} as const;

/** Themed glyphs by skill name, first match wins; the rest fall back to their targeting shape. */
const BY_NAME: readonly [RegExp, Glyph][] = [
  [/Worldbreaker|Rift/, 'rift'],
  [/Anvil/, 'anvil'],
  [/Mjolnir|Slam/, 'slam'],
  [/Hammer/, 'hammer'],
  [/Spin/, 'spin'],
  [/Sandstorm|Cyclone/, 'cyclone'],
  [/Skyfall/, 'stormcloud'],
  [/Aegis|Cloud/, 'cloud'],
  [/Ball Lightning/, 'orb'],
  [/Chain/, 'chain'],
  [/Thunder God/, 'crown'],
  [/Judgment/, 'skull'],
  [/Scales/, 'scales'],
  [/Poison/, 'poison'],
  [/Arc Bolt/, 'bolt'],
  [/Raven/, 'raven'],
  [/Eye|Gaze/, 'eye'],
  [/Rune/, 'rune'],
  [/Assassinate/, 'dagger'],
  [/Smoke/, 'smoke'],
  [/Decoy|Shapeshift/, 'mask'],
  [/Locust/, 'swarm'],
  [/Mummify/, 'wrap'],
  [/Grasp/, 'hand'],
  [/Howl|War Cry|Call of Asgard|Valhalla/, 'horn'],
  [/Ascension/, 'wings'],
];

type Glyph = keyof typeof GLYPHS;

export function glyphFor(skill: SkillDef): Glyph {
  for (const [re, g] of BY_NAME) if (re.test(skill.name)) return g;
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
