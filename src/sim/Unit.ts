import type { BasicShot, Combatant, ResolvedSkill, Team } from '../game/combatant';

/**
 * Rules-engine distances are authored at roughly Smite's proportions; the
 * arena is built at a larger physical scale (the placeholder god is 2.45 m
 * tall and runs 6.6 m/s). Every engine distance and speed is multiplied by
 * this when it enters the world.
 */
export const WORLD_SCALE = 1.75;

/** Engine move speed (100 units = 1 engine m/s) to arena meters per second. */
export function worldSpeed(moveSpeed: number): number {
  return (moveSpeed / 100) * WORLD_SCALE;
}

export type UnitKind = 'god' | 'dummy' | 'summon' | 'minion' | 'tower' | 'phoenix' | 'titan';

/** Towers, Phoenixes and Titans: never move, take only basic attacks, and never respawn on their own. */
export function isStructure(u: { kind: UnitKind }): boolean {
  return u.kind === 'tower' || u.kind === 'phoenix' || u.kind === 'titan';
}

/**
 * Where a unit is. Bots own a plain object; the player's body is an adapter
 * over the PlayerController so the controller keeps owning normal movement.
 * Yaw 0 faces -Z; forward is (-sin yaw, -cos yaw).
 */
export interface Body {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Instant moves (recall, respawn) that should not be interpolated. */
  teleport?(x: number, z: number, yaw?: number): void;
}

export interface Point {
  x: number;
  z: number;
}

/** Movement the simulation drives: dashes, leaps, knockbacks, pulls. */
export interface Forced {
  vx: number;
  vz: number;
  remaining: number;
  total: number;
  /** Peak height of a leap arc, 0 for ground movement. */
  arc: number;
  /** Leaps fly over walls; dashes and knockbacks are stopped by them. */
  collide: boolean;
  /** A dash that hits units it passes through. */
  sweep?: { cast: ResolvedSkill; width: number; hit: Set<Unit> };
  land?: () => void;
}

/** Decides what a sim-driven unit does each step. */
export interface Brain {
  update(dt: number): void;
}

let nextId = 1;

export class Unit {
  readonly id = nextId++;
  /** Facing direction the simulation wants for sim-driven units, as a unit vector or null. */
  move: Point | null = null;
  /** Ground point the unit is aiming at (crosshair for the player, target for bots). */
  readonly aim: Point = { x: 0, z: 0 };
  forced: Forced | null = null;
  stealth = 0;
  untargetable = 0;
  /** Seconds left on a recall channel; 0 when not recalling. */
  recall = 0;
  /** Seconds left before a summon expires. */
  lifetime = Infinity;
  owner: Unit | null = null;
  brain: Brain | null = null;
  readonly marks = new Map<string, { stacks: number; remaining: number }>();
  /** Last step's horizontal velocity, for animation. */
  vx = 0;
  vz = 0;
  /** Seconds since the last cast or attack, for the cast pose. */
  sinceAction = 99;
  wasAlive = true;
  /** Gods respawn at home; minions are removed a moment after death and structures stay as rubble. */
  respawns = true;
  /** A structure that cannot be damaged yet (the one in front of it still stands). */
  shielded: () => boolean = () => false;
  /** The last time this unit damaged an enemy god, for tower aggro. */
  lastGodHit: { victim: Unit; at: number } | null = null;
  /** Enemy gods that damaged this unit and when, for assists. */
  readonly damagedBy = new Map<Unit, number>();
  /** Seconds until a wound-up attack lands (the Titan's slam), 0 when idle. */
  windup = 0;
  /** Seconds since death, for units that do not respawn. */
  deadFor = 0;
  /** Free-form tag the match uses (lane, minion type). */
  tag = '';

  constructor(
    readonly kind: UnitKind,
    readonly name: string,
    readonly combatant: Combatant,
    readonly body: Body,
    readonly radius: number,
    readonly home: { x: number; z: number; yaw: number },
  ) {}

  get team(): Team {
    return this.combatant.team;
  }

  get alive(): boolean {
    return this.combatant.alive;
  }

  get x(): number {
    return this.body.x;
  }

  get z(): number {
    return this.body.z;
  }

  /** Visible and hittable by enemies. */
  get targetable(): boolean {
    return this.alive && this.untargetable <= 0;
  }

  get forward(): Point {
    return { x: -Math.sin(this.body.yaw), z: -Math.cos(this.body.yaw) };
  }
}

/** A projectile in flight: a skill shot or a ranged basic attack. */
export interface Projectile {
  readonly id: number;
  owner: Unit;
  cast: ResolvedSkill | null;
  shot: BasicShot | null;
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  traveled: number;
  range: number;
  radius: number;
  pierce: boolean;
  bounces: number;
  /** Structure shots home in on their target. */
  homing: Unit | null;
  readonly hit: Set<Unit>;
  alive: boolean;
}

/** A lingering area that applies a skill on every tick. */
export interface Zone {
  readonly id: number;
  owner: Unit;
  cast: ResolvedSkill;
  x: number;
  z: number;
  radius: number;
  ticks: number;
  interval: number;
  timer: number;
  /** 'caster' stays on the caster, 'aim' drifts toward the caster's aim point. */
  follow: 'caster' | 'aim' | null;
  /** Max distance from the caster when following the aim. */
  range: number;
  age: number;
  duration: number;
}

/** A one-shot shape drawn for a moment when an instant skill resolves. */
export type FlashShape =
  | { type: 'circle'; x: number; z: number; radius: number }
  | { type: 'line'; x: number; z: number; yaw: number; length: number; width: number }
  | { type: 'cone'; x: number; z: number; yaw: number; range: number; angle: number };

export interface Flash {
  readonly id: number;
  shape: FlashShape;
  owner: Unit;
  age: number;
  life: number;
}

export type SimEvent =
  | { type: 'damage'; target: Unit; source: Unit | null; amount: number; crit: boolean; ability: boolean }
  | { type: 'heal'; target: Unit; amount: number }
  | { type: 'cast'; unit: Unit; cast: ResolvedSkill; x: number; z: number }
  | { type: 'basic'; unit: Unit; melee: boolean }
  | { type: 'impact'; x: number; z: number; owner: Unit; big: boolean }
  | { type: 'death'; unit: Unit; killer: Unit | null; assists: Unit[] }
  | { type: 'respawn'; unit: Unit }
  | { type: 'levelUp'; unit: Unit; level: number }
  | { type: 'reward'; unit: Unit; xp: number; favor: number }
  | { type: 'teleport'; unit: Unit; fromX: number; fromZ: number }
  | { type: 'recall'; unit: Unit; state: 'start' | 'cancel' | 'done' };

export function nextEntityId(): number {
  return nextId++;
}
