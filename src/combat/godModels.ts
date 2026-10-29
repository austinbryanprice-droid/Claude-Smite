import { GodModel } from '../actors/GodModel';

/**
 * The one place combat builds god meshes. Character models can be swapped
 * here per god (or for summons) without touching the views or the game.
 * `variant` is 'einherjar' for Odin's summoned warriors.
 */
export function createGodModel(godId: string, variant: 'god' | 'einherjar' = 'god'): GodModel {
  return new GodModel(godId, variant === 'einherjar' ? 'einherjar' : undefined);
}
