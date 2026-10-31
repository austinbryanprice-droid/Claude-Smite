import { describe, expect, it } from 'vitest';
import { GODS } from '../game/gods';
import { glyphFor, skillIcon, talentIcon } from './icons';

describe('skill icons', () => {
  it('gives every skill of a god its own glyph', () => {
    for (const god of GODS) {
      const seen = new Map<string, string>();
      for (const s of god.skills) {
        const g = glyphFor(s);
        expect(seen.get(g), `${god.name}: ${s.name} shares "${g}" with ${seen.get(g)}`).toBeUndefined();
        seen.set(g, s.name);
      }
    }
  });

  it('draws every skill and talent, and badges every talent that changes a skill', () => {
    for (const god of GODS) {
      for (const s of god.skills) expect(skillIcon(god.id, s)).toContain('<svg');
      for (const t of god.trees)
        for (const n of t.nodes) {
          const svg = talentIcon(god.id, n, god.skills, '#c85');
          expect(svg).toContain('<svg');
          if (n.tier === 2) expect(svg, n.name).toContain('r="8.5"');
        }
    }
  });
});
