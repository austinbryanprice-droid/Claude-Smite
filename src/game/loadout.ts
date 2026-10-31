import type { GodDef, SkillDef } from './types';

/** Slots 0-2 are regular (keys 1-3); slot 3 is the ultimate slot (key 4, or R). */
export type Loadout = readonly [string, string, string, string];
export const ULTIMATE_SLOT = 3;
export const SLOT_COUNT = 4;
export const SLOT_KEYS = ['1', '2', '3', '4'] as const;
/** Keyboard codes per slot. The ultimate also answers to R, the old key. */
export const SLOT_CODES: readonly (readonly string[])[] = [['Digit1'], ['Digit2'], ['Digit3'], ['Digit4', 'KeyR']];

/** The slot a keyboard code casts, or -1. */
export function slotForCode(code: string): number {
  return SLOT_CODES.findIndex((codes) => codes.includes(code));
}

/**
 * Bring any older or malformed loadout to the 3 + 1 shape: three regular
 * skills, then the ultimate slot. Older five-slot builds keep their first
 * three regular skills and their ultimate-slot skill.
 */
export function normalizeLoadout(god: GodDef, loadout: readonly string[]): Loadout {
  if (validateLoadout(god, loadout) === null) return loadout as Loadout;
  const ultId = loadout.length ? loadout[loadout.length - 1]! : '';
  const ult = skillById(god, ultId) ? ultId : god.defaultLoadout[ULTIMATE_SLOT];
  const regular: string[] = [];
  for (const id of [...loadout.slice(0, -1), ...god.defaultLoadout.slice(0, ULTIMATE_SLOT)]) {
    const s = skillById(god, id);
    if (s && s.kind === 'regular' && id !== ult && !regular.includes(id)) regular.push(id);
    if (regular.length === ULTIMATE_SLOT) break;
  }
  return [regular[0]!, regular[1]!, regular[2]!, ult];
}

export type LoadoutError = 'wrongSize' | 'unknownSkill' | 'duplicate' | 'ultimateInRegularSlot' | 'notInBase';

export function skillById(god: GodDef, id: string): SkillDef | undefined {
  return god.skills.find((s) => s.id === id);
}

/**
 * Rules (design doc section 3): regular slots take regular skills only; the
 * ultimate slot takes an ultimate or a regular skill; no skill twice.
 */
export function validateLoadout(god: GodDef, loadout: readonly string[]): LoadoutError | null {
  if (loadout.length !== SLOT_COUNT) return 'wrongSize';
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
  const next = [...loadout] as [string, string, string, string];
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
