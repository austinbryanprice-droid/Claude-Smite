import * as THREE from 'three/webgpu';
import { createGodModel } from './godModels';
import type { Input } from '../core/Input';
import type { Updatable } from '../core/Loop';
import type { CastError } from '../game/combatant';
import { GODS, godById } from '../game/gods';
import type { GodDef } from '../game/types';
import { ULTIMATE_SLOT } from '../game/loadout';
import { FAVOR_THRESHOLDS, XP_TABLE } from '../game/progression';
import type { PlayerController } from '../player/PlayerController';
import type { World } from '../scene/World';
import { GodBot, SummonBrain } from '../sim/Bot';
import { dummyUnit, godUnit, summonUnit } from '../sim/factory';
import { LaneBot, ROLES, spawnPoint, type BotRole } from '../sim/LaneBot';
import { conquestBases, Match } from '../sim/Match';
import { angleBetween, MELEE_ARC, Sim, type BaseZone, type SimTerrain } from '../sim/Sim';
import { isStructure, Unit, WORLD_SCALE, type Body, type SimEvent } from '../sim/Unit';
import { CombatHud } from '../ui/CombatHud';
import { LoadoutMenu } from '../ui/LoadoutMenu';
import { MatchHud } from '../ui/MatchHud';
import { GroundDecal, type DecalShape } from './GroundDecal';
import { paletteFor } from './palette';
import type { StructureModel } from './structures';
import { UnitViews } from './UnitViews';
import { BuffAuras } from './BuffAuras';
import { monsterWarmup } from './MonsterViews';
import { CombatVfx } from './Vfx';

const SLOT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR'] as const;

const CAST_MESSAGES: Partial<Record<CastError | 'forced', string>> = {
  cooldown: 'On cooldown',
  mana: 'Not enough mana',
  cc: "Can't cast right now",
  locked: 'Not unlocked yet',
  dead: 'You are dead',
};

export interface CombatDeps {
  world: World;
  /** 'conquest' plays a full match against bots; 'arena' is the training ground. */
  mode?: 'arena' | 'conquest';
  /** The player's god (defaults to Zeus). */
  god?: string;
  input: Input;
  player: PlayerController;
  camera: THREE.PerspectiveCamera;
  /** Adds camera shake (0..1 trauma). */
  shake?: (amount: number) => void;
}

/** Until the Conquest scene lands, a match on another map follows its ground but ignores its walls. */
const openGround = (c: SimTerrain): SimTerrain => ({ groundAt: (x, z) => c.groundAt(x, z), resolve: (x, z) => ({ x, z }) });

/**
 * Owns the simulation and connects it to input, the 3D views and the HUD.
 * Two modes: the training ground (three training posts in front of the
 * temple and an enemy bot holding the north side) and a Conquest match (the
 * player in mid with four allied bots against five enemy bots).
 *
 * `update` runs on the fixed step (after the player controller); `frame`
 * runs once per rendered frame (after the controller places the model).
 */
export class CombatGame implements Updatable {
  readonly sim: Sim;
  player!: Unit;
  bot: Unit | null = null;
  readonly match: Match | null = null;
  private readonly matchHud: MatchHud | null = null;
  private endTimer = 0;
  private readonly views: UnitViews;
  private readonly vfx: CombatVfx;
  private readonly auras = new BuffAuras();
  /** Monsters drawn out of sight for the first frames, so their shaders compile during loading. */
  private warm: { group: THREE.Group; frames: number } | null = null;
  /** The HUD's crosshair, which shows whether a basic attack would land. */
  private reticle: HTMLElement | null = null;
  private setCampActive: ((id: string, active: boolean) => void) | null = null;
  private readonly campLit = new Map<string, boolean>();
  private readonly hud: CombatHud;
  private readonly menu: LoadoutMenu;
  private readonly body: Body;
  private readonly bases: Record<'order' | 'chaos', BaseZone>;
  private preview: { slot: number; code: string } | null = null;
  private readonly shapeDecal: GroundDecal;
  private readonly rangeDecal: GroundDecal;
  private suppressBasic = false;
  private readonly ray = new THREE.Vector3();
  private readonly groundAt: (x: number, z: number) => number;

  constructor(private readonly deps: CombatDeps) {
    const { world, player } = deps;
    const conquest = deps.mode === 'conquest';
    const onConquestMap = (world as unknown as { map?: string }).map === 'conquest';
    const terrain: SimTerrain = conquest && !onConquestMap ? openGround(world.collision) : world.collision;
    this.groundAt = (x, z) => terrain.groundAt(x, z);
    const spawn = conquest ? spawnPoint('order', 1) : world.spawn;
    this.bases = conquest
      ? conquestBases()
      : {
          order: { x: spawn.x, z: spawn.z + 2, radius: 9 },
          chaos: { x: 0, z: -62, radius: 9 },
        };
    this.sim = new Sim(terrain, this.bases);
    this.sim.summonFactory = (owner, kind, at, i) => {
      const s = summonUnit(owner, kind, at, i);
      if (kind === 'einherjar') s.brain = new SummonBrain(this.sim, s);
      return s;
    };

    // The player's body is the controller: it keeps owning normal movement,
    // the simulation moves it for dashes, leaps and knockbacks.
    this.body = {
      get x() { return player.position.x; },
      set x(v) { player.position.x = v; },
      get y() { return player.position.y; },
      set y(v) { player.position.y = v; },
      get z() { return player.position.z; },
      set z(v) { player.position.z = v; },
      get yaw() { return player.yaw; },
      set yaw(v) { player.yaw = v; },
      // keep the camera's aim through blinks; only respawns and recalls turn the god
      teleport: (x, z, yaw) => player.spawn(x, z, yaw !== undefined && this.isHomeTeleport(x, z) ? yaw : player.yaw),
    };

    this.vfx = new CombatVfx(this.groundAt);
    this.vfx.targets = () => (this.match ? [...this.match.brains].map(([s, b]) => [s, b.current] as const) : []);
    world.vfx.add(this.vfx.group, this.auras.group);
    this.shapeDecal = new GroundDecal(this.groundAt);
    this.rangeDecal = new GroundDecal(this.groundAt);
    this.shapeDecal.setStyle('telegraph');
    this.rangeDecal.setStyle('telegraph');
    this.shapeDecal.mesh.visible = this.rangeDecal.mesh.visible = false;
    world.vfx.add(this.shapeDecal.mesh, this.rangeDecal.mesh);

    if (conquest) player.spawn(spawn.x, spawn.z, spawn.yaw);
    const mine = godById(deps.god ?? 'zeus') ?? GODS[0]!;
    this.player = godUnit(mine, 'order', { x: spawn.x, z: spawn.z, yaw: spawn.yaw }, this.body);
    this.sim.add(this.player);
    // the Conquest map builds and places its own Tower, Phoenix and Titan models
    // the map dims a buff altar's crystal while its Warden is down (when the map supports it)
    const content = (world as unknown as { content?: { setCampActive?: (id: string, active: boolean) => void } }).content;
    if (content?.setCampActive) this.setCampActive = content.setCampActive.bind(content);
    const placed = (world as unknown as { content?: { structures?: Map<string, StructureModel> } }).content?.structures;
    this.views = new UnitViews(this.player, player.model, (u) => {
      if (!placed || !this.match) return undefined;
      for (const [id, s] of this.match.structures) if (s === u) return placed.get(id);
      return undefined;
    });
    world.actors.add(this.views.group);
    this.setPlayerModel(mine.id);

    this.hud = new CombatHud(this.player, deps.camera, (u, out) => this.views.headOf(u, out));
    this.menu = new LoadoutMenu(
      conquest
        ? { combatant: () => this.player.combatant, gods: GODS, onClose: () => undefined }
        : {
            combatant: () => this.player.combatant,
            gods: GODS,
            switchGod: (id) => this.switchGod(id),
            practiceLevel: (lvl) => this.practiceLevel(lvl),
            practiceFavor: () => {
              const c = this.player.combatant;
              c.gainFavor(Math.max(0, FAVOR_THRESHOLDS[FAVOR_THRESHOLDS.length - 1]! - c.favor));
            },
            onClose: () => undefined,
          },
    );

    if (conquest) {
      this.match = new Match(this.sim, godById('zeus')!);
      // build the bots' jungle paths while the map loads, not mid-match
      this.match.nav.warm();
      // and compile the jungle's shaders now, not when the first camp grows
      this.warmup(world.actors);
      this.match.addGod(this.player);
      this.addTeam('order', GODS.filter((g) => g.id !== mine.id), ['solo', 'duo', 'duo', 'roam'], [0, 2, 3, 4]);
      this.addTeam('chaos', GODS, ROLES, [0, 1, 2, 3, 4]);
      this.matchHud = new MatchHud(this.match, this.player);
      this.sim.drainEvents();
      return;
    }

    // Training posts on the temple plaza, facing the fountain.
    for (const x of [-6, 0, 6]) {
      this.sim.add(dummyUnit(godById('zeus')!, 'chaos', { x, z: 9 + Math.abs(x) * 0.25, yaw: Math.PI }));
    }

    // An enemy Thor holds the north side of the temple.
    this.bot = godUnit(godById('thor')!, 'chaos', { x: this.bases.chaos.x, z: this.bases.chaos.z, yaw: Math.PI });
    this.bot.brain = new GodBot(this.sim, this.bot, { anchor: { x: 0, z: -24 }, leash: 48, aggro: 24, aggression: 0.45 });
    this.sim.add(this.bot);
    this.sim.teleport(this.bot, 0, -24, Math.PI);
    this.sim.drainEvents();
  }

  /**
   * Draw one of every monster far below the map for the first few frames.
   * Culling is off so they are drawn (and their pipelines built) even though
   * nothing on screen shows them; the loader's shader pre-compile picks them up too.
   */
  private warmup(parent: THREE.Object3D): void {
    if (!this.match) return;
    const group = new THREE.Group();
    group.position.y = -500;
    for (const root of monsterWarmup()) group.add(root);
    group.traverse((o) => (o.frustumCulled = false));
    parent.add(group);
    this.warm = { group, frames: 3 };
  }

  private addTeam(team: 'order' | 'chaos', gods: readonly GodDef[], roles: readonly BotRole[], spots: readonly number[]): void {
    gods.forEach((def, i) => {
      const u = godUnit(def, team, spawnPoint(team, spots[i]!));
      u.brain = new LaneBot(this.sim, this.match!, u, roles[i]!);
      this.match!.addGod(u);
    });
  }

  private isHomeTeleport(x: number, z: number): boolean {
    return Math.hypot(x - this.player.home.x, z - this.player.home.z) < 0.01;
  }

  // -------------------------------------------------------------------------
  // Fixed step

  update(dt: number): void {
    // after a Titan falls the world keeps moving a few seconds, then freezes behind the end screen
    if (this.match?.winner) this.endTimer += dt;
    if (this.endTimer < 4) {
      this.views.beforeStep(this.sim.units);
      this.match?.step(dt);
      this.sim.step(dt);
      this.views.afterStep(this.sim.units);
    }

    // the training bot keeps pace with the player so fights stay fair
    if (this.bot) {
      const pc = this.player.combatant;
      const bc = this.bot.combatant;
      if (bc.level < pc.level) bc.gainXp(XP_TABLE[pc.level - 1]! - bc.xp);
    }

    this.deps.player.movement = {
      speed: this.sim.moveSpeed(this.player),
      canMove: this.sim.canMove(this.player),
    };
  }

  // -------------------------------------------------------------------------
  // Per frame

  frame(dt: number, alpha: number, time: number): void {
    const input = this.deps.input;
    if (this.warm && --this.warm.frames <= 0) {
      this.warm.group.removeFromParent();
      this.warm = null;
    }
    this.updateAim();
    this.updateReticle();

    if (input.wasPressed('KeyK')) this.toggleMenu();
    if (this.menu.isOpen && input.wasPressed('Escape')) this.menu.close();

    if (!this.menu.isOpen && !this.match?.winner) this.handleCombatInput();

    for (const e of this.sim.drainEvents()) {
      this.vfx.onEvent(e);
      this.views.onEvent(e);
      this.hud.onEvent(e);
      this.matchHud?.onEvent(e);
      this.feel(e);
      if ((e.type === 'levelUp' || e.type === 'reward' || e.type === 'recall') && e.unit === this.player) this.menu.refresh();
    }

    this.views.frame(this.sim.units, dt, alpha, time);
    this.matchHud?.frame(dt, this.sim.units, input.isDown('Tab'));
    if (this.match?.winner) this.hud.setVisible(false);
    this.vfx.player = this.player;
    this.vfx.frame(this.sim, dt, time);
    this.syncCamps();
    this.auras.frame(this.sim.units, time, (u) => u.stealth <= 0 || u.team === this.player.team);
    this.updatePreview();
    this.hud.setPreview(this.preview?.slot ?? null);
    this.hud.frame(this.sim.units, dt);
    const inBase = this.player.combatant.inBase;
    if (inBase !== this.wasInBase) {
      this.wasInBase = inBase;
      this.menu.refresh();
    }
  }

  private wasInBase = true;

  private toggleMenu(): void {
    if (this.menu.isOpen) {
      this.menu.close();
      return;
    }
    this.cancelPreview();
    this.menu.open();
    document.exitPointerLock?.();
  }

  private handleCombatInput(): void {
    const input = this.deps.input;
    const u = this.player;

    if (input.wasPressed('KeyB')) {
      if (this.sim.startRecall(u)) this.cancelPreview();
    }

    SLOT_CODES.forEach((code, slot) => {
      if (!input.wasPressed(code)) return;
      if (this.preview?.slot === slot) {
        this.castSlot(slot);
        return;
      }
      const err = u.combatant.canCast(slot);
      if (err) {
        this.denied(slot, err);
        return;
      }
      const t = u.combatant.resolve(slot).targeting;
      // self casts fire at once; everything else shows where it will land first
      if (t.type === 'self') this.castSlot(slot);
      else this.preview = { slot, code };
    });

    if (this.preview) {
      if (input.isMouseDown(2)) this.cancelPreview();
      else if (input.isMouseDown(0) && input.locked) {
        this.castSlot(this.preview.slot);
        this.suppressBasic = true;
      } else if (!input.isDown(this.preview.code)) this.castSlot(this.preview.slot);
    }

    if (!input.isMouseDown(0)) this.suppressBasic = false;
    if (!this.preview && !this.suppressBasic && input.locked && input.isMouseDown(0) && u.alive) this.sim.basic(u);
  }

  private syncCamps(): void {
    if (!this.match || !this.setCampActive) return;
    for (const c of this.match.jungle.camps) {
      const lit = this.match.jungle.alive(c);
      if (this.campLit.get(c.camp.id) === lit) continue;
      this.campLit.set(c.camp.id, lit);
      this.setCampActive(c.camp.id, lit);
    }
  }

  /** Camera shake for the hits the player should feel: their own pain and big blasts nearby. */
  private feel(e: SimEvent): void {
    const shake = this.deps.shake;
    if (!shake) return;
    const me = this.player;
    const near = (x: number, z: number, r: number) => Math.max(0, 1 - Math.hypot(x - me.x, z - me.z) / r);
    switch (e.type) {
      case 'damage':
        if (e.target === me && e.amount > 0) shake(Math.min(0.45, 0.12 + (e.amount / me.combatant.stats.maxHealth) * 2.5));
        break;
      case 'impact':
        if (e.big) shake(0.3 * near(e.x, e.z, 16));
        break;
      case 'basic':
        if (e.unit.kind === 'titan') shake(0.5 * near(e.unit.x, e.unit.z, 30));
        else if (e.unit.tag.endsWith('warden')) shake(0.3 * near(e.unit.x, e.unit.z, 14));
        else if (e.unit.kind === 'monster' && e.unit.radius > 2) shake(0.4 * near(e.unit.x, e.unit.z, 22));
        break;
      case 'cast':
        if (e.unit === me && e.cast.slot === ULTIMATE_SLOT) shake(0.25);
        break;
      case 'death':
        if (isStructure(e.unit) || (e.unit.kind === 'monster' && e.unit.radius > 2)) shake(0.8 * near(e.unit.x, e.unit.z, 60));
        else if (e.unit.kind === 'god') shake(e.killer === me || e.unit === me ? 0.4 : 0.25 * near(e.unit.x, e.unit.z, 25));
        break;
      default:
        break;
    }
  }

  private castSlot(slot: number): void {
    this.preview = null;
    const err = this.sim.cast(this.player, slot);
    if (err) this.denied(slot, err);
  }

  private denied(slot: number, err: CastError | 'forced'): void {
    this.hud.deny(slot);
    const msg = err === 'locked' && slot === ULTIMATE_SLOT ? 'Ultimate unlocks at level 5' : CAST_MESSAGES[err];
    if (msg) this.hud.toast(msg, 'warn');
  }

  private cancelPreview(): void {
    this.preview = null;
  }

  /**
   * Tell the player what a basic attack would hit right now: the crosshair
   * turns red over an enemy in reach (grey when the enemy is lined up but too
   * far), and that enemy's health bar is outlined.
   */
  private updateReticle(): void {
    this.reticle ??= document.querySelector<HTMLElement>('.hud-crosshair');
    const { target, inRange } = this.aimTarget();
    this.reticle?.classList.toggle('on-target', target !== null && inRange);
    this.reticle?.classList.toggle('far-target', target !== null && !inRange);
    this.hud.setTarget(inRange ? target : null);
  }

  /** The enemy the player's basic attack is lined up on, and whether it can reach it. */
  private aimTarget(): { target: Unit | null; inRange: boolean } {
    const u = this.player;
    if (!u.alive) return { target: null, inRange: false };
    const basic = u.combatant.god.basicAttack;
    const melee = basic.projectileSpeed === undefined;
    const range = basic.range * WORLD_SCALE;
    const dir = this.sim.aimDir(u);
    let best: Unit | null = null;
    let bestAlong = Infinity;
    for (const t of this.sim.enemiesOf(u)) {
      if (!t.targetable || t.stealth > 0) continue;
      const rx = t.x - u.x;
      const rz = t.z - u.z;
      const along = rx * dir.x + rz * dir.z;
      if (along <= 0 || along > range * 2.5) continue;
      // melee swings cover an arc; shots fly a narrow line (the projectile's own width)
      const lined = melee
        ? Math.hypot(rx, rz) <= t.radius || angleBetween(dir, { x: rx, z: rz }) <= MELEE_ARC / 2
        : Math.abs(rx * dir.z - rz * dir.x) <= t.radius + 0.45;
      if (lined && along < bestAlong) {
        best = t;
        bestAlong = along;
      }
    }
    if (!best) return { target: null, inRange: false };
    return { target: best, inRange: Math.hypot(best.x - u.x, best.z - u.z) <= range + best.radius };
  }

  /** The ground point under the crosshair, by marching the camera's center ray. */
  private updateAim(): void {
    const cam = this.deps.camera;
    const u = this.player;
    const dir = cam.getWorldDirection(this.ray);
    const o = cam.position;
    let hit: { x: number; z: number } | null = null;
    for (let t = 1; t < 140; t += 0.5) {
      const x = o.x + dir.x * t;
      const y = o.y + dir.y * t;
      const z = o.z + dir.z * t;
      if (y <= this.groundAt(x, z)) {
        hit = { x, z };
        break;
      }
    }
    const f = u.forward;
    if (!hit) hit = { x: u.x + f.x * 60, z: u.z + f.z * 60 };
    // never aim behind the god (steep camera angles can hit the ground between camera and god)
    const ahead = (hit.x - u.x) * f.x + (hit.z - u.z) * f.z;
    if (ahead < 1.5) hit = { x: u.x + f.x * 1.5, z: u.z + f.z * 1.5 };
    u.aim.x = hit.x;
    u.aim.z = hit.z;
  }

  private updatePreview(): void {
    const show = (d: GroundDecal, on: boolean) => (d.mesh.visible = on);
    if (!this.preview || !this.player.alive) {
      show(this.shapeDecal, false);
      show(this.rangeDecal, false);
      return;
    }
    const u = this.player;
    const cast = u.combatant.resolve(this.preview.slot);
    const t = cast.targeting;
    const p = paletteFor(u.combatant.god.id);
    const S = WORLD_SCALE;
    const range = (r: number) => r * S * cast.rangeScale;
    const radius = (r: number) => r * S * cast.radiusScale;
    const dir = this.sim.aimDir(u);
    const yaw = Math.atan2(-dir.x, -dir.z);
    this.shapeDecal.setColors(p.vfx, p.core);
    this.rangeDecal.setColors(p.vfx, p.core);
    this.shapeDecal.opacity.value = 0.9;
    this.rangeDecal.opacity.value = 0.45;

    let shape: DecalShape | null = null;
    let at = { x: u.x, z: u.z };
    let ring: number | null = null;
    switch (t.type) {
      case 'projectile':
        shape = { type: 'rect', length: range(t.range), width: Math.max(1, radius(t.radius) * 2) };
        break;
      case 'line':
        shape = { type: 'rect', length: range(t.range), width: radius(t.width) };
        break;
      case 'dash':
        shape = { type: 'rect', length: t.distance * S * cast.rangeScale, width: radius(t.width) };
        break;
      case 'cone':
        shape = { type: 'cone', range: range(t.range), angle: t.angle };
        break;
      case 'ground':
      case 'leap':
        shape = { type: 'circle', radius: radius(t.radius) };
        at = this.sim.aimPoint(u, range(t.range));
        ring = range(t.range);
        break;
      case 'ally':
        ring = range(t.range);
        break;
      case 'self':
        if (t.radius !== undefined) shape = { type: 'circle', radius: radius(t.radius) };
        break;
    }
    show(this.shapeDecal, !!shape);
    if (shape) this.shapeDecal.place(shape, at.x, at.z, shape.type === 'circle' ? 0 : yaw);
    show(this.rangeDecal, ring !== null);
    if (ring !== null) this.rangeDecal.place({ type: 'ring', radius: ring, width: 0.25 }, u.x, u.z, 0);
  }

  // -------------------------------------------------------------------------
  // God switching and practice

  private setPlayerModel(godId: string): void {
    const ctrl = this.deps.player;
    const old = ctrl.model;
    const model = createGodModel(godId);
    old.root.parent?.add(model.root);
    old.root.parent?.remove(old.root);
    ctrl.model = model;
    ctrl.render(0, 1);
    this.views.setPlayer(this.player, model);
  }

  private switchGod(id: string): string | null {
    const def = godById(id);
    if (!def || def.id === this.player.combatant.god.id) return null;
    if (!this.player.combatant.inBase) return 'notInBase';
    const old = this.player;
    const next = godUnit(def, 'order', old.home, this.body);
    next.combatant.gainXp(old.combatant.xp);
    next.combatant.gainFavor(old.combatant.favor);
    this.sim.remove(old);
    this.sim.add(next);
    this.player = next;
    this.setPlayerModel(id);
    this.hud.setPlayer(next);
    return null;
  }

  private practiceLevel(level: number): void {
    const c = this.player.combatant;
    const need = XP_TABLE[level - 1]! - c.xp;
    if (need > 0) c.gainXp(need);
  }

  /** For automated checks and debugging from the console. */
  debugState() {
    return {
      player: { god: this.player.combatant.god.id, level: this.player.combatant.level, hp: this.player.combatant.health, x: this.player.x, z: this.player.z },
      units: this.sim.units.map((u) => ({ name: u.name, team: u.team, alive: u.alive, hp: Math.round(u.combatant.health), x: +u.x.toFixed(1), z: +u.z.toFixed(1) })),
      projectiles: this.sim.projectiles.length,
      zones: this.sim.zones.length,
    };
  }
}
