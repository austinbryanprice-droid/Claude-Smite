import { describe, expect, it } from 'vitest';
import { GODS } from '../game/gods';
import { glyphFor } from './icons';

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
});
