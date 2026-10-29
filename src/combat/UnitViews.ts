import * as THREE from 'three/webgpu';
import type { GodModel } from '../actors/GodModel';
import { createGodModel } from './godModels';
import { float, fract, length, mix, mx_noise_float, positionLocal, smoothstep, uv, vec3 } from '../render/tsl';
import type { StructureKind } from '../sim/factory';
import { isStructure, type SimEvent, type Unit } from '../sim/Unit';
import { MinionViews } from './MinionViews';
import { createMonsterView, type MonsterView } from './MonsterViews';
import { createStructureModel, type StructureModel } from './structures';
import { MUZZLE_HEIGHT } from './Vfx';

/** A wooden training post with a straw body and a painted target shield. */
/** Seconds a fallen god stays on the ground before it is hidden. */
const GOD_CORPSE = 2.8;

/** How far a fallen god has sunk into the ground, in the last second before it is hidden. */
function godSink(deathTime: number): number {
  const t = THREE.MathUtils.clamp(deathTime - (GOD_CORPSE - 1), 0, 1);
  return t * t * 0.9;
}

function buildDummy(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardNodeMaterial({ color: 0x6b4426, roughness: 0.8 });
  wood.colorNode = mix(vec3(0.24, 0.14, 0.07), vec3(0.42, 0.27, 0.14), mx_noise_float(positionLocal.mul(vec3(2, 26, 2))).mul(0.5).add(0.5));
  const straw = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const fiber = mx_noise_float(positionLocal.mul(vec3(40, 3, 40))).mul(0.5).add(0.5);
  straw.colorNode = mix(vec3(0.45, 0.33, 0.12), vec3(0.85, 0.68, 0.3), fiber);
  const rope = new THREE.MeshStandardNodeMaterial({ color: 0x5a4630, roughness: 0.9 });
  const stone = new THREE.MeshStandardNodeMaterial({ color: 0x8c877c, roughness: 0.85 });
  const burlap = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  burlap.colorNode = mix(vec3(0.4, 0.32, 0.22), vec3(0.55, 0.45, 0.32), mx_noise_float(positionLocal.mul(60)).mul(0.5).add(0.5));
  const paint = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
  const r = length(uv().sub(0.5)).mul(2);
  const ring = fract(r.mul(2.5)).step(0.5);
  const bull = smoothstep(0.22, 0.2, r);
  const red = vec3(0.6, 0.06, 0.04);
  const cream = vec3(0.85, 0.78, 0.6);
  const gold = vec3(0.9, 0.65, 0.2);
  paint.colorNode = mix(mix(cream, red, ring), gold, bull).mul(float(0.85).add(mx_noise_float(positionLocal.mul(30)).mul(0.15)));

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(0.62, 0.7, 0.28, 10), stone, 0, 0.14, 0);
  add(new THREE.CylinderGeometry(0.09, 0.11, 2.1, 10), wood, 0, 1.2, 0);
  add(new THREE.CylinderGeometry(0.36, 0.3, 1.05, 14, 4), straw, 0, 1.35, 0);
  for (const y of [0.98, 1.35, 1.72]) add(new THREE.TorusGeometry(0.345, 0.03, 6, 20), rope, 0, y, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 8), wood, 0, 1.62, 0, 0, Math.PI / 2);
  for (const x of [-0.82, 0.82]) add(new THREE.SphereGeometry(0.14, 10, 8), straw, x, 1.62, 0);
  add(new THREE.SphereGeometry(0.25, 14, 10), burlap, 0, 2.12, 0);
  // the target faces +Z (the model's front, like the god model)
  add(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 28), paint, 0, 1.32, 0.36, Math.PI / 2);
  return g;
}

/** How often (in frames) a god model off screen is animated. */
const OFFSCREEN_EVERY = 8;
/** The longest step GodModel.animate takes without dropping time. */
const MAX_ANIM_DT = 1 / 20;

interface UnitView {
  root: THREE.Group;
  model: GodModel | null;
  /** Height of the head above the feet, for bars and effects. */
  height: number;
  wobble: number;
  wobbleVel: number;
  deathTime: number;
  localDir: THREE.Vector2;
  lift: number;
  structure: StructureModel | null;
  /** The map owns and updates this structure model; combat only drives its state. */
  external: boolean;
  /** Last frame's windup, to start the slam animation once. */
  windup: number;
  /** Seconds since a destroyed structure began to rise again, or -1. */
  rebirth: number;
  monster: MonsterView | null;
  /** Time the god model's animation has not caught up on yet (see animateEvery). */
  animDt: number;
  /** Staggers reduced-rate animation so gods don't all update on the same frame. */
  stagger: number;
}

/**
 * The 3D side of every unit: god models for bots and summons, training
 * posts, death and hit reactions. The player's model is owned by the
 * PlayerController; this only adds cast poses, lift and visibility to it.
 */
export class UnitViews {
  readonly group = new THREE.Group();
  readonly minions = new MinionViews();
  private readonly views = new Map<Unit, UnitView>();
  private readonly prev = new Map<Unit, THREE.Vector3>();
  private readonly cur = new Map<Unit, THREE.Vector3>();
  /** When set, gods off screen or far away animate at a reduced rate. */
  camera: THREE.Camera | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly bounds = new THREE.Sphere();
  private frameNo = 0;
  private created = 0;

  constructor(
    private player: Unit,
    private playerModel: GodModel,
    /** Structure models the map already built and placed, by unit. */
    private readonly mapStructure: (u: Unit) => StructureModel | undefined = () => undefined,
  ) {
    this.group.name = 'units';
    this.group.add(this.minions.group);
  }

  /** After a god switch: the old player's view is dropped (its model belongs to the controller). */
  setPlayer(u: Unit, model: GodModel): void {
    this.views.delete(this.player);
    this.player = u;
    this.playerModel = model;
  }

  /** Called before each fixed simulation step, so frames can interpolate between steps. */
  beforeStep(units: readonly Unit[]): void {
    for (const u of units) {
      const c = this.cur.get(u);
      const p = this.prev.get(u) ?? new THREE.Vector3();
      if (c) p.copy(c);
      else p.set(u.x, u.body.y, u.z);
      this.prev.set(u, p);
    }
  }

  afterStep(units: readonly Unit[]): void {
    for (const u of units) {
      const c = this.cur.get(u) ?? new THREE.Vector3();
      c.set(u.x, u.body.y, u.z);
      this.cur.set(u, c);
    }
  }

  frame(units: readonly Unit[], dt: number, alpha: number, time = 0): void {
    this.frameNo++;
    if (this.camera) this.frustum.setFromProjectionMatrix(this.viewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const seen = new Set<Unit>();
    const minions: Unit[] = [];
    for (const u of units) {
      seen.add(u);
      const v = this.views.get(u) ?? this.create(u);
      this.animate(u, v, dt, alpha);
      if (u.kind === 'minion') minions.push(u);
      if (v.structure && !v.external) v.structure.update(dt, time);
    }
    this.minions.frame(
      minions,
      dt,
      (u) => this.views.get(u)!.root.position,
      (u) => this.views.get(u)!.deathTime,
      (u) => this.views.get(u)!.root.visible,
    );
    for (const [u, v] of this.views) {
      if (seen.has(u)) continue;
      if (u !== this.player) this.group.remove(v.root);
      this.views.delete(u);
      this.prev.delete(u);
      this.cur.delete(u);
    }
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'damage') {
      const v = this.views.get(e.target);
      if (v && !v.structure) {
        v.wobbleVel += Math.min(6, 1.5 + e.amount / 40);
        v.model?.flinch(0.35 + e.amount / 150);
      }
      if (e.target.kind === 'minion') this.minions.hit(e.target, e.amount);
    } else if (e.type === 'basic') {
      const v = this.views.get(e.unit);
      v?.structure?.pulseFire();
      v?.model?.startCast('basic');
    } else if (e.type === 'cast') {
      this.views.get(e.unit)?.model?.startCast('skill');
    } else if (e.type === 'death') {
      const v = this.views.get(e.unit);
      if (v) v.deathTime = 0;
    } else if (e.type === 'respawn' && isStructure(e.unit)) {
      const v = this.views.get(e.unit);
      if (v) v.rebirth = 0;
    } else if (e.type === 'respawn' || e.type === 'teleport') {
      // don't interpolate across the map
      const p = this.prev.get(e.unit);
      if (p) p.set(e.unit.x, e.unit.body.y, e.unit.z);
      const c = this.cur.get(e.unit);
      if (c) c.set(e.unit.x, e.unit.body.y, e.unit.z);
    }
  }

  /** World position just above a unit's head (for health bars). */
  headOf(u: Unit, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.views.get(u);
    if (!v || !v.root.visible) return null;
    return out.copy(v.root.position).setY(v.root.position.y + v.height + 0.5);
  }

  private create(u: Unit): UnitView {
    let root: THREE.Group;
    let model: GodModel | null = null;
    let structure: StructureModel | null = null;
    let external = false;
    let monster: MonsterView | null = null;
    let height = 2.45;
    if (u === this.player) {
      model = this.playerModel;
      root = model.root;
    } else if (u.kind === 'dummy') {
      root = buildDummy();
      height = 2.3;
      this.group.add(root);
    } else if (u.kind === 'minion') {
      // drawn by the instanced crowd; this root only carries the position
      root = new THREE.Group();
      height = u.tag.endsWith('brute') ? 2.7 : 1.85;
    } else if (u.kind === 'monster') {
      monster = createMonsterView(u);
      root = monster.root;
      height = monster.height;
      this.group.add(root);
    } else if (isStructure(u)) {
      const placed = this.mapStructure(u);
      external = !!placed;
      structure = placed ?? createStructureModel(u.kind as StructureKind, u.side);
      root = structure.root as THREE.Group;
      height = structure.height;
      if (!placed) {
        root.position.set(u.x, u.body.y, u.z);
        root.rotation.y = u.body.yaw + Math.PI;
        this.group.add(root);
      }
      if (structure.muzzle) {
        // shots leave from the model's muzzle
        root.updateMatrixWorld(true);
        MUZZLE_HEIGHT[u.kind] = structure.muzzle.getWorldPosition(new THREE.Vector3()).y - root.position.y;
      }
    } else {
      const summoned = u.kind === 'summon' && u.name === 'Einherjar';
      model = createGodModel(u.combatant.god.id, summoned ? 'einherjar' : 'god');
      root = model.root;
      if (summoned) root.scale.setScalar(0.88);
      this.group.add(root);
    }
    const v: UnitView = { root, model, height, wobble: 0, wobbleVel: 0, deathTime: -1, localDir: new THREE.Vector2(), lift: 0, structure, rebirth: -1, external, windup: 0, monster, animDt: 0, stagger: this.created++ };
    this.views.set(u, v);
    return v;
  }

  private animate(u: Unit, v: UnitView, dt: number, alpha: number): void {
    // spring wobble when hit
    v.wobbleVel += (-v.wobble * 60 - v.wobbleVel * 7) * dt;
    v.wobble += v.wobbleVel * dt;

    if (v.model) {
      const target = u.sinceAction < 0.35 ? 1 : 0;
      v.model.castWeight += (target - v.model.castWeight) * (1 - Math.exp(-dt * (target ? 22 : 6)));
    }

    const liftGoal = u.untargetable > 0 && u.alive ? 5 : 0;
    v.lift += (liftGoal - v.lift) * (1 - Math.exp(-dt * 4));

    if (!u.alive) {
      if (v.deathTime < 0) v.deathTime = 0;
      v.deathTime += dt;
    } else v.deathTime = -1;
    if (v.model) v.model.deathTime = v.deathTime;

    if (u === this.player) {
      // no sink: the camera follows this root through the respawn wait
      v.root.visible = u.alive || v.deathTime < GOD_CORPSE;
      v.root.position.y += v.lift;
      return;
    }

    if (v.structure) {
      const s = v.structure;
      s.setShielded(u.alive && u.shielded());
      const c = u.combatant;
      s.setDamage?.(u.alive ? 1 - c.health / c.stats.maxHealth : 1);
      if (u.windup > 0 && v.windup <= 0) s.attack?.();
      v.windup = u.windup;
      if (v.rebirth >= 0) {
        v.rebirth += dt;
        v.structure.setRebirth?.(Math.min(1, v.rebirth / 2.5));
        if (v.rebirth >= 2.5) v.rebirth = -1;
      } else v.structure.setDestroyed(u.alive ? 0 : Math.min(1, v.deathTime / 2.2));
      v.root.visible = true;
      return;
    }

    const p = this.prev.get(u);
    const c = this.cur.get(u);
    if (p && c) v.root.position.lerpVectors(p, c, alpha);
    else v.root.position.set(u.x, u.body.y, u.z);
    v.root.position.y += v.lift;
    v.root.rotation.y = u.body.yaw + Math.PI;

    const hidden = u.stealth > 0 && u.team !== this.player.team;
    if (u.kind === 'dummy') {
      // a broken post tips over, then is hidden until it stands again
      const fall = v.deathTime < 0 ? 0 : Math.min(1, v.deathTime / 0.6);
      v.root.rotation.x = fall * fall * 1.45 + v.wobble * 0.12;
      v.root.visible = v.deathTime < 2.5;
      return;
    }
    if (u.kind === 'minion') {
      // the crowd poses the body (and its fall) from this root
      v.root.visible = !hidden && v.deathTime < 2.2;
      return;
    }
    if (v.monster) {
      v.root.visible = v.deathTime < 3;
      v.monster.animate(u, dt, v.deathTime, v.wobble);
      return;
    }
    v.root.visible = !hidden && (u.alive || v.deathTime < (v.model ? GOD_CORPSE : 0.05));
    if (!v.model) return;
    v.root.position.y -= godSink(v.deathTime);
    const speed = Math.hypot(u.vx, u.vz);
    if (speed > 0.1) {
      const sin = Math.sin(u.body.yaw);
      const cos = Math.cos(u.body.yaw);
      // world velocity into the model's frame: forward (-sin, -cos), right (cos, -sin)
      v.localDir.set((u.vx * cos - u.vz * sin) / speed, (-u.vx * sin - u.vz * cos) / speed);
    } else v.localDir.set(0, 0);
    v.root.rotation.z = v.wobble * 0.04;
    v.animDt += dt;
    const every = this.animateEvery(v);
    // GodModel.animate clamps its step to MAX_ANIM_DT, so pose before the backlog would exceed it
    if ((this.frameNo + v.stagger) % every !== 0 && v.animDt + dt <= MAX_ANIM_DT) return;
    v.model.animate(
      v.animDt,
      { speed, localDir: v.localDir, grounded: !u.forced || u.forced.arc === 0, verticalSpeed: 0 },
      // cloth is most of the cost: away from the camera it gets one 60 Hz step per update, in slow motion nobody can see
      every === 1 ? v.animDt : Math.min(v.animDt, 1 / 60),
    );
    v.animDt = 0;
  }

  /**
   * Skinned god models are the most expensive thing to animate on the CPU,
   * so only the ones on screen and close by pose every frame. Far ones catch
   * up every few frames, and ones off screen only tick over now and then
   * (their shadows may still be in view).
   */
  private animateEvery(v: UnitView): number {
    if (!this.camera) return 1;
    if (!v.root.visible) return OFFSCREEN_EVERY;
    this.bounds.center.copy(v.root.position).setY(v.root.position.y + v.height * 0.5);
    this.bounds.radius = v.height * 1.2;
    if (!this.frustum.intersectsSphere(this.bounds)) return OFFSCREEN_EVERY;
    const d = this.camera.position.distanceTo(this.bounds.center);
    return d > 70 ? 3 : d > 35 ? 2 : 1;
  }
}
