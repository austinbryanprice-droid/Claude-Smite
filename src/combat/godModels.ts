import { GodModel } from '../actors/GodModel';
import { paletteFor } from './palette';

/**
 * The one place combat builds god meshes. Character models can be swapped
 * here per god (or for summons) without touching the views or the game.
 * `variant` is 'einherjar' for Odin's summoned warriors.
 */
export function createGodModel(godId: string, variant: 'god' | 'einherjar' = 'god'): GodModel {
  if (variant === 'einherjar') return new GodModel({ cloth: 0x4a4f5a, trim: 0xd8a23a, glow: 0xffd27a });
  const p = paletteFor(godId);
  return new GodModel({ cloth: p.cloth, trim: p.trim, glow: p.glow });
}
