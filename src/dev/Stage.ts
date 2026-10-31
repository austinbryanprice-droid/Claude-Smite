import * as THREE from 'three/webgpu';
import type { CombatGame } from '../combat/CombatGame';
import { godById } from '../game/gods';
import { XP_TABLE } from '../game/progression';
import { GodBot } from '../sim/Bot';
import { dummyUnit, godUnit } from '../sim/factory';
import type { Unit } from '../sim/Unit';

/**
 * `?stage` dev view for filming the intro trailer (tools/trailer): the player's
 * god steps out of the scene and the follow camera stops, so a script can
 * cast gods as bots, aim their skills and fly the camera through `director`,
 * which runs once a rendered frame. Loaded on demand, so a normal launch
 * never downloads it.
 */
export class Stage {
  /** Called every rendered frame with the frame's time step and the stage time. */
  director: ((dt: number, t: number, stage: Stage) => void) | null = null;
  t = 0;
  /** Holds the clock at 0 (while the filming script settles the first view). */
  hold = false;
  readonly THREE = THREE;
  /** Scratch space for a shot's script. */
  readonly vars: Record<string, any> = {};

  constructor(readonly combat: CombatGame, readonly camera: THREE.PerspectiveCamera, private readonly hidePlayer: () => void) {
    hidePlayer();
  }

  /** Removes the training posts and the arena's Thor. */
  clear(): void {
    for (const u of [...this.combat.sim.units]) if (u !== this.combat.player && (u.kind === 'god' || u.kind === 'dummy')) this.combat.sim.remove(u);
    this.combat.bot = null;
  }

  /** Puts the player's own god out of the way, far outside the shot. */
  park(x: number, z: number): void {
    this.hidePlayer();
    this.combat.sim.teleport(this.combat.player, x, z);
  }

  /** A god at `level` that fights on its own (`aggression` 0 keeps it from casting by itself). */
  god(id: string, team: 'order' | 'chaos', x: number, z: number, yaw = 0, opts: { level?: number; aggression?: number; leash?: number; aggro?: number } = {}): Unit {
    const u = godUnit(godById(id)!, team, { x, z, yaw });
    const lvl = opts.level ?? 20;
    u.combatant.gainXp(XP_TABLE[Math.min(XP_TABLE.length, lvl) - 1]! - u.combatant.xp);
    u.brain = new GodBot(this.combat.sim, u, { anchor: { x, z }, leash: opts.leash ?? 30, aggro: opts.aggro ?? 30, aggression: opts.aggression ?? 0.5 });
    this.combat.sim.add(u);
    return u;
  }

  /** A training post for the shot's gods to hit. */
  dummy(x: number, z: number): Unit {
    return dummyUnit(godById('zeus')!, 'chaos', { x, z, yaw: Math.PI });
  }

  /** Casts a skill slot (0-3, 4 the ultimate) at a ground point, ignoring cooldown and mana. */
  cast(u: Unit, slot: number, x: number, z: number): string | null {
    u.aim.x = x;
    u.aim.z = z;
    u.body.yaw = Math.atan2(-(x - u.x), -(z - u.z));
    const c = u.combatant as unknown as { cooldowns: Map<string, number>; mana: number };
    c.cooldowns.clear();
    c.mana = u.combatant.stats.maxMana;
    return this.combat.sim.cast(u, slot) ?? null;
  }

  /** Game time run ahead by `skip` so far. */
  skipped = 0;

  /** Runs the simulation ahead without drawing (the views catch up on the next frame). */
  skip(seconds: number): void {
    for (let s = 0; s < seconds * 60; s++) this.combat.update(1 / 60);
    this.skipped += seconds;
    this.combat.sim.drainEvents();
  }

  /** Skips ahead in half-second steps until `found` holds; false if `limit` seconds pass first. */
  skipUntil(found: () => boolean, limit: number): boolean {
    const end = this.skipped + limit;
    while (this.skipped < end) {
      if (found()) return true;
      this.skip(0.5);
    }
    return found();
  }

  look(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 50): void {
    this.camera.position.set(px, py, pz);
    this.camera.lookAt(tx, ty, tz);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt: number): void {
    if (!this.hold) this.t += dt;
    this.director?.(this.hold ? 0 : dt, this.t, this);
  }
}
