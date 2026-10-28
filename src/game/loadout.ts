import type { GodDef, SkillDef } from './types';

/** Slots 0-3 are regular (keys 1-4); slot 4 is the ultimate slot (key R). */
export type Loadout = readonly [string, string, string, string, string];
export const ULTIMATE_SLOT = 4;
export const SLOT_KEYS = ['1', '2', '3', '4', 'R'] as const;

export type LoadoutError = 'wrongSize' | 'unknownSkill' | 'duplicate' | 'ultimateInRegularSlot' | 'notInBase';

export function skillById(god: GodDef, id: string): SkillDef | undefined {
  return god.skills.find((s) => s.id === id);
}

/**
 * Rules (design doc section 3): regular slots take regular skills only; the
 * ultimate slot takes an ultimate or a regular skill; no skill twice.
 */
export function validateLoadout(god: GodDef, loadout: readonly string[]): LoadoutError | null {
  if (loadout.length !== SLOT_KEYS.length) return 'wrongSize';
  const seen = new Set<string>();
  for (let slot = 0; slot < loadout.length; slot++) {
    const id = loadout[slot]!;
    const skill = skillById(god, id);
    if (!skill) return 'unknownSkill';
    if (seen.has(id)) return 'duplicate';
    seen.add(id);
    if (slot !== ULTIMATE_SLOT && skill.kind === 'ultimate') return 'ultimateInRegularSlot';
  }
  return null;
}

/** Swap the skill in a slot. Only allowed while standing in base. */
export function swapSkill(
  god: GodDef,
  loadout: Loadout,
  slot: number,
  skillId: string,
  inBase: boolean,
): { ok: true; loadout: Loadout } | { ok: false; error: LoadoutError } {
  if (!inBase) return { ok: false, error: 'notInBase' };
  const next = [...loadout] as [string, string, string, string, string];
  next[slot] = skillId;
  const error = validateLoadout(god, next);
  return error ? { ok: false, error } : { ok: true, loadout: next };
}

/** Skills that may go into a slot, excluding ones already equipped elsewhere. */
export function slotOptions(god: GodDef, loadout: Loadout, slot: number): SkillDef[] {
  return god.skills.filter(
    (s) =>
      (slot === ULTIMATE_SLOT || s.kind === 'regular') &&
      !loadout.some((id, i) => i !== slot && id === s.id),
  );
}
