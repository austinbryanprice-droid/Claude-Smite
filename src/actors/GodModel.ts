import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { godAsset, type GodAsset } from './gods/assets';
import { combinedMaterials, COMBINED, godMaterials, paintedMaterial } from './gods/materials';
import { SecondaryPhysics } from './gods/Physics';
import { castSkinnedAsOne, mergeSkinned, packScalars } from '../scene/merge';
import { color, luminance } from '../render/tsl';

/** Locomotion input the model animates from. All values are per frame. */
export interface LocomotionState {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Movement direction relative to facing: x = right, y = forward (normalized or zero). */
  localDir: THREE.Vector2;
  grounded: boolean;
  /** Vertical velocity, m/s (for jump poses). */
  verticalSpeed: number;
}

/**
 * Materials whose meshes skip the shadow passes: hair clumps, eyes, gems and
 * glow edges are dense but too thin to change a god's cast shadow, and the
 * baked AO already darkens them in contact. Saves ~100k triangles per cascade.
 */
const NO_SHADOW = new Set(['hair', 'eye', 'gem', 'glow']);

/** Geometry every model of one god shares: shadow stand-ins and pieces merged per combined material. */
const standIns = new Map<string, { geometry?: THREE.BufferGeometry }>();
const combinedPieces = new Map<string, THREE.BufferGeometry>();

/**
 * Per-god body language layered on the shared cast clip, so each god casts in
 * character. Rotations are about model-space axes (+Y up, +Z forward, the
 * god's right hand toward -X), in radians at full cast.
 */
const CAST_ACCENTS: Record<string, { bone: string; axis: [number, number, number]; angle: number }[]> = {
  // Zeus lifts the bolt overhead and leans back
  zeus: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: -0.2 },
    { bone: 'DEF-upper_arm.R', axis: [0, 0, 1], angle: -2.0 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: -0.15 },
  ],
  // Thor throws his weight into the swing
  thor: [
    { bone: 'DEF-spine002', axis: [0, 1, 0], angle: 0.3 },
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: 0.2 },
  ],
  // Odin levels his spear and leans back to throw
  odin: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: -0.12 },
    { bone: 'DEF-upper_arm.R', axis: [1, 0, 0], angle: -2.3 },
  ],
  // Loki lunges low with the daggers
  loki: [
    { bone: 'DEF-spine002', axis: [1, 0, 0], angle: 0.25 },
    { bone: 'DEF-spine003', axis: [0, 1, 0], angle: -0.3 },
  ],
  // Anubis hunches over the spell, head lowered, staff raised
  anubis: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: 0.18 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: 0.2 },
    { bone: 'DEF-upper_arm.R', axis: [1, 0, 0], angle: -0.8 },
  ],
};

/**
 * Per-god stance layered on the shared idle clip, faded out as the god starts
 * moving: posture says who they are before they act. Same axes as CAST_ACCENTS.
 */
const IDLE_STANCE: Record<string, { bone: string; axis: [number, number, number]; angle: number }[]> = {
  // Zeus: chest out, chin up
  zeus: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: -0.08 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: -0.1 },
  ],
  // Thor: shoulders rolled forward, head low, ready to charge
  thor: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: 0.1 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: 0.06 },
  ],
  // Odin: upright and watchful, head turned a little to his good eye
  odin: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: -0.04 },
    { bone: 'DEF-head', axis: [0, 1, 0], angle: 0.18 },
  ],
  // Loki: weight on one hip, head cocked
  loki: [
    { bone: 'DEF-spine001', axis: [0, 0, 1], angle: 0.08 },
    { bone: 'DEF-head', axis: [0, 0, 1], angle: -0.12 },
  ],
  // Anubis: hunched forward, head thrust out like a hound
  anubis: [
    { bone: 'DEF-spine003', axis: [1, 0, 0], angle: 0.1 },
    { bone: 'DEF-head', axis: [1, 0, 0], angle: 0.14 },
  ],
};

/** Bones the cast pose overrides (upper body only, so legs keep running). */
/** Which upper-body overlay an action plays. */
export type CastKind = 'basic' | 'skill' | 'ult';

/** Per kind: clip playback rate, accent strength, and how long gameplay holds the pose (s). */
const CAST_FEEL: Record<CastKind, { rate: number; accent: number; hold: number }> = {
  basic: { rate: 1.6, accent: 0, hold: 0.35 },
  skill: { rate: 1.6, accent: 1, hold: 0.35 },
  // ultimates play the skill motion slower and hold it twice as long
  ult: { rate: 1.05, accent: 1, hold: 0.7 },
};

/** Layered on top of the god's accent for ultimates: chest arched back, chin up, the off hand raised to the sky. */
const ULT_ACCENT: { bone: string; axis: [number, number, number]; angle: number }[] = [
  { bone: 'DEF-spine.003', axis: [1, 0, 0], angle: -0.28 },
  { bone: 'DEF-head', axis: [1, 0, 0], angle: -0.22 },
  { bone: 'DEF-upper_arm.L', axis: [0, 0, 1], angle: 1.7 },
];

const UPPER = /^DEF-(spine00[23]|neck|head|shoulder|upper_arm|forearm|hand|f_|thumb)/;

interface Loco {
  action: THREE.AnimationAction;
  /** Ground speed the clip was authored for, m/s at this god's size. */
  speed: number;
}

function sameSkeleton(a: THREE.Skeleton, b: THREE.Skeleton): boolean {
  return a.bones.length === b.bones.length && a.bones.every((bone, i) => bone === b.bones[i] && a.boneInverses[i]!.equals(b.boneInverses[i]!));
}

/**
 * A god: a skinned MakeHuman-based body with armor, hair and cloth, built
 * offline by tools/gods/build.py, on the shared UAL skeleton. Animation
 * blends the UAL locomotion clips by speed, turns the hips toward strafe
 * direction, and overlays the cast clip on the upper body by `castWeight`.
 * Capes, hair and cloth strips are simulated in `SecondaryPhysics`.
 *
 * The root sits at the feet and faces +Z.
 */
export class GodModel {
  readonly root = new THREE.Group();
  readonly head: THREE.Object3D;
  readonly chest: THREE.Object3D;
  readonly hips: THREE.Object3D;
  readonly rightHand: THREE.Object3D;
  readonly leftHand: THREE.Object3D;
  /** 0..1 blend toward the cast pose; gameplay sets it every frame. */
  castWeight = 0;
  /** Seconds since this god died, or negative while alive; gameplay sets it every frame. */
  deathTime = -1;
  readonly height: number;
  readonly id: string;

  private readonly mixer: THREE.AnimationMixer;
  private readonly loco: Loco[] = [];
  private readonly idle: THREE.AnimationAction;
  private readonly air: THREE.AnimationAction;
  private readonly asset: GodAsset;
  private readonly bones = new Map<string, THREE.Bone>();
  /** Upper-body overlays: a weapon strike for basic attacks, the god's spell motion for skills. */
  private readonly overlays: Record<'basic' | 'skill', { tracks: { bone: THREE.Bone; interp: THREE.Interpolant }[]; duration: number }>;
  private castKind: CastKind = 'skill';
  private castTime = 1e9;
  private prevCast = 0;
  private phase = 0;
  private smoothedSpeed = 0;
  private hipYaw = 0;
  private prevSpeed = 0;
  private lean = 0;
  private bank = 0;
  private readonly axisX = new THREE.Vector3(1, 0, 0);
  private readonly axisZ = new THREE.Vector3(0, 0, 1);
  private get spine(): THREE.Bone {
    return this.bones.get('DEF-spine002')!;
  }
  private airWeight = 0;
  private readonly death: THREE.AnimationAction;
  private deathWeight = 0;
  private readonly flinches: { bone: THREE.Bone; interp: THREE.Interpolant }[][] = [];
  private flinchClip = 0;
  private flinchTime = 1e9;
  private flinchDuration = 0.4;
  private flinchStrength = 0;
  /** Seconds of hit-stop left: the pose all but freezes so a blow reads as landing. */
  private stopLeft = 0;
  private readonly physics: SecondaryPhysics;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly curl: { bone: THREE.Bone; q: THREE.Quaternion }[] = [];
  private readonly accents: { bone: THREE.Bone; axis: THREE.Vector3; angle: number }[] = [];
  private readonly ultAccents: { bone: THREE.Bone; axis: THREE.Vector3; angle: number }[] = [];
  private readonly stance: { bone: THREE.Bone; axis: THREE.Vector3; angle: number }[] = [];
  private stanceWeight = 1;
  private readonly tmpV = new THREE.Vector3();

  /**
   * `shadowStandIn: false` leaves each piece in its own material and casting
   * its own shadow, for callers that re-dress the model (see `castSkinnedAsOne`).
   */
  constructor(god: string | object = 'zeus', variant?: string, { shadowStandIn = true } = {}) {
    this.id = typeof god === 'string' ? god : 'zeus';
    this.asset = godAsset(this.id);
    const scene = cloneSkinned(this.asset.scene) as THREE.Group;
    this.root.name = `god-${this.id}`;
    this.root.add(scene);
    this.height = this.asset.meta.height;

    const mats = godMaterials(this.asset.id, variant);
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshStandardMaterial;
      const name = src.name;
      // a sculpted god carries its paint in the GLB (tools/gods/meshy.py)
      mesh.material = src.map ? paintedMaterial(src.map) : mats.get(name) ?? mats.get('default')!;
      mesh.castShadow = !NO_SHADOW.has(name);
      mesh.receiveShadow = true;
      // cull against a fixed, generous sphere: the posed mesh (swinging weapons,
      // cast accents) never leaves it, and it is never recomputed from bones
      const geo = mesh.geometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const sphere = geo.boundingSphere!.clone();
      sphere.radius += 1.2;
      mesh.boundingSphere = sphere;
      mesh.frustumCulled = true;
    });
    // the clone gives every piece its own skeleton: share one, so the bones are
    // computed and uploaded once a frame instead of once per piece
    let skeleton: THREE.Skeleton | null = null;
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      if (!skeleton) skeleton = mesh.skeleton;
      else if (sameSkeleton(mesh.skeleton, skeleton)) mesh.bind(skeleton, mesh.bindMatrix);
    });
    if (shadowStandIn) {
      castSkinnedAsOne(scene, standIns);
      this.combineParts(scene, variant);
    }
    const bone = (n: string) => this.bones.get(n.replace(/\./g, ''))!;
    this.head = bone('DEF-head');
    this.chest = bone('DEF-spine.003');
    this.hips = bone('DEF-hips');
    this.rightHand = bone('DEF-hand.R');
    this.leftHand = bone('DEF-hand.L');

    this.mixer = new THREE.AnimationMixer(scene);
    const clip = (n: string) => {
      const c = this.asset.clips.get(n);
      if (!c) throw new Error(`clip ${n} missing`);
      return c;
    };
    const k = this.height / 1.75; // UAL clips are authored for a 1.75 m mannequin
    this.idle = this.mixer.clipAction(clip('Idle_Loop'));
    this.idle.play();
    for (const [n, speed] of [['Walk_Loop', 1.55], ['Jog_Fwd_Loop', 3.9], ['Sprint_Loop', 6.2]] as const) {
      const a = this.mixer.clipAction(clip(n));
      a.play();
      a.setEffectiveWeight(0);
      this.loco.push({ action: a, speed: speed * k });
    }
    this.air = this.mixer.clipAction(clip('Jump_Loop'));
    this.air.play();
    this.air.setEffectiveWeight(0);

    this.death = this.mixer.clipAction(clip('Death01'));
    this.death.setLoop(THREE.LoopOnce, 1);
    this.death.clampWhenFinished = true;
    this.death.timeScale = 0;
    this.death.play();
    this.death.setEffectiveWeight(0);

    // hammer and daggers swing; everyone else casts from the free hand
    const swing = this.id === 'thor' || this.id === 'loki';
    const overlay = (n: string) => {
      const c = clip(n);
      return { tracks: this.upperTracks(c), duration: c.duration };
    };
    this.overlays = {
      basic: overlay(variant === 'melee' ? 'Punch_Cross' : swing ? 'Sword_Attack' : 'Punch_Jab'),
      skill: overlay(variant === 'melee' ? 'Punch_Cross' : swing ? 'Sword_Attack' : 'Spell_Simple_Shoot'),
    };

    for (const n of ['Hit_Chest', 'Hit_Head']) {
      const c = clip(n);
      this.flinchDuration = Math.min(this.flinchDuration, c.duration);
      this.flinches.push(this.upperTracks(c));
    }

    for (const c of this.asset.meta.curl ?? []) {
      const b = bone(c.bone);
      const axis = new THREE.Vector3().fromArray(c.axis).normalize();
      if (b) this.curl.push({ bone: b, q: new THREE.Quaternion().setFromAxisAngle(axis, c.angle) });
    }
    for (const a of IDLE_STANCE[this.id] ?? []) {
      const b = this.bones.get(a.bone.replace(/\./g, ''));
      if (b) this.stance.push({ bone: b, axis: new THREE.Vector3(...a.axis), angle: a.angle });
    }
    for (const a of CAST_ACCENTS[this.id] ?? []) {
      const b = this.bones.get(a.bone.replace(/\./g, ''));
      if (b) this.accents.push({ bone: b, axis: new THREE.Vector3(...a.axis), angle: a.angle });
    }
    for (const a of ULT_ACCENT) {
      const b = this.bones.get(a.bone.replace(/\./g, ''));
      if (b) this.ultAccents.push({ bone: b, axis: new THREE.Vector3(...a.axis), angle: a.angle });
    }

    this.physics = new SecondaryPhysics(this.root, scene, this.asset.meta, this.bones, mats);
    this.mixer.update(0);
  }

  /**
   * Redraws each piece in its part's combined material and merges the pieces
   * that share one, so the god draws twice (metal and body) instead of once
   * per material (see `combinedMaterials`). The pieces' `_part` attribute
   * tells the combined material which part each vertex is.
   */
  private combineParts(scene: THREE.Object3D, variant?: string): void {
    const meshes: THREE.SkinnedMesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.layers.isEnabled(0)) meshes.push(o as THREE.SkinnedMesh);
    });
    const present = new Set(meshes.map((m) => (m.material as THREE.Material).name));
    const combined = combinedMaterials(this.asset.id, variant, present);
    for (const mesh of meshes) {
      const name = (mesh.material as THREE.Material).name;
      for (const [group, parts] of Object.entries(COMBINED)) {
        const part = parts.indexOf(name);
        if (part < 0) continue;
        // (the geometry is the asset's, shared by every model of this god)
        const geo = mesh.geometry;
        if (!geo.getAttribute('_part')) geo.setAttribute('_part', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(part), 1));
        mesh.material = combined.get(group)!;
      }
    }
    mergeSkinned(scene, combinedPieces);
    scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) packScalars((o as THREE.Mesh).geometry);
    });
  }

  /**
   * Recolors this instance's metal armor (gold and steel), e.g. a team color on a
   * Titan statue. Clones the shared materials, so other gods are unaffected.
   */
  tintMetal(hex: number, amount = 1): void {
    const done = new Map<THREE.Material, THREE.Material>();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material as THREE.MeshPhysicalNodeMaterial;
      if (!/^(metal|gold|goldplain|steel)$/.test(src.name)) return;
      let m = done.get(src);
      if (!m) {
        const c = src.clone();
        const base = src.colorNode ?? color(src.color.getHex());
        // keep the metal's light and dark detail, swap its hue for the tint
        const lum = luminance(base);
        c.colorNode = base.mix(color(hex).mul(lum.mul(2.2)), amount);
        c.name = src.name;
        done.set(src, (m = c));
      }
      mesh.material = m;
    });
  }

  /** Upper-body rotation tracks of a clip, sampled by hand for overlays. */
  private upperTracks(clip: THREE.AnimationClip): { bone: THREE.Bone; interp: THREE.Interpolant }[] {
    const out: { bone: THREE.Bone; interp: THREE.Interpolant }[] = [];
    for (const t of clip.tracks) {
      const [node, prop] = t.name.split('.');
      if (prop !== 'quaternion' || !UPPER.test(node!)) continue;
      const b = this.bones.get(node!);
      if (b) out.push({ bone: b, interp: (t as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant() });
    }
    return out;
  }

  /** Seconds after an action that gameplay should hold `castWeight` at 1 for the current overlay. */
  get castHold(): number {
    return CAST_FEEL[this.castKind].hold;
  }

  /** Starts the overlay for a basic attack, skill or ultimate; `castWeight` still blends it in and out. */
  startCast(kind: CastKind): void {
    this.castKind = kind;
    this.castTime = 0;
  }

  /** A short upper-body recoil from a hit; `strength` 0..1. Alternates chest and head hits. */
  flinch(strength: number): void {
    if (this.deathTime >= 0) return;
    this.flinchClip = (this.flinchClip + 1) % this.flinches.length;
    this.flinchTime = 0;
    this.flinchStrength = THREE.MathUtils.clamp(strength, 0, 1);
  }

  /** Hit-stop: nearly freeze the pose for a few frames, the way a heavy blow catches. */
  hitStop(seconds: number): void {
    if (this.deathTime >= 0) return;
    this.stopLeft = Math.max(this.stopLeft, seconds);
  }

  /** Dev: hold one clip (by name) instead of locomotion; null resumes. */
  debugClip(name: string | null, time = 0): void {
    this.held?.stop();
    this.held = null;
    if (!name) return;
    const c = this.asset.clips.get(name);
    if (!c) return;
    this.held = this.mixer.clipAction(c);
    this.held.play();
    this.held.time = time;
    this.held.setEffectiveWeight(1);
  }

  private held: THREE.AnimationAction | null = null;

  /**
   * Drives animation and secondary physics. Call once per rendered frame after placing `root`.
   * `clothDt` lets a caller run the cloth on less time than the skeleton (distant or off-screen gods).
   */
  animate(dt: number, s: LocomotionState, clothDt = dt): void {
    if (this.stopLeft > 0) {
      this.stopLeft -= dt;
      dt *= 0.06;
      clothDt *= 0.06;
    }
    dt = Math.min(dt, 1 / 20);
    const k = 1 - Math.exp(-dt * 10);
    this.smoothedSpeed += (s.speed - this.smoothedSpeed) * k;
    const speed = this.smoothedSpeed;
    const backward = s.localDir.y < -0.3;

    // locomotion: one shared phase so blended clips keep their feet in step
    let lo = this.loco[0]!;
    let hi = this.loco[0]!;
    for (const l of this.loco) {
      if (speed >= l.speed) lo = l;
    }
    hi = this.loco[Math.min(this.loco.indexOf(lo) + 1, this.loco.length - 1)]!;
    const t = hi === lo ? 1 : THREE.MathUtils.clamp((speed - lo.speed) / (hi.speed - lo.speed), 0, 1);
    const move = THREE.MathUtils.clamp(speed / (this.loco[0]!.speed * 0.6), 0, 1);
    const cycleSpeed = THREE.MathUtils.lerp(lo.speed, hi.speed, t);
    const playRate = speed / Math.max(0.01, cycleSpeed);
    this.phase = (this.phase + dt * playRate / THREE.MathUtils.lerp(lo.action.getClip().duration, hi.action.getClip().duration, t) * (backward ? -1 : 1) + 1) % 1;
    this.airWeight += ((s.grounded ? 0 : 1) - this.airWeight) * (1 - Math.exp(-dt * 12));
    const ground = 1 - this.airWeight;
    // dying: the fall takes over the whole body within a few frames
    this.deathWeight = this.deathTime >= 0 ? Math.min(1, this.deathWeight + dt * 8) : 0;
    const alive = 1 - this.deathWeight;
    this.death.setEffectiveWeight(this.deathWeight);
    this.death.time = Math.max(0, Math.min(this.deathTime, this.death.getClip().duration - 1e-3));
    for (const l of this.loco) {
      const w = l === lo ? (lo === hi ? 1 : 1 - t) : l === hi ? t : 0;
      l.action.setEffectiveWeight(w * move * ground * alive);
      l.action.time = this.phase * l.action.getClip().duration;
      l.action.timeScale = 0;
    }
    this.idle.setEffectiveWeight((1 - move) * ground * (this.held ? 0 : 1) * alive);
    if (this.held) {
      for (const l of this.loco) l.action.setEffectiveWeight(0);
      this.air.setEffectiveWeight(0);
    }
    this.idle.timeScale = 1;
    this.air.setEffectiveWeight(this.airWeight * alive);
    this.mixer.update(dt);
    if (alive <= 0) {
      for (const c of this.curl) c.bone.quaternion.multiply(c.q);
      this.root.updateMatrixWorld(true);
      this.physics.update(dt);
      return;
    }

    // strafing: legs turn toward the movement direction, the torso keeps aiming
    const strafeYaw = speed > 0.5 ? Math.atan2(s.localDir.x, Math.max(0.25, Math.abs(s.localDir.y))) * (backward ? -0.6 : 0.6) : 0;
    this.hipYaw += (strafeYaw - this.hipYaw) * k;
    this.root.updateMatrixWorld(true);
    if (Math.abs(this.hipYaw) > 1e-3) {
      this.rotateWorldY(this.hips, -this.hipYaw);
      this.rotateWorldY(this.bones.get('DEF-spine001')!, this.hipYaw * 0.6);
      this.rotateWorldY(this.bones.get('DEF-spine002')!, this.hipYaw * 0.4);
    }

    // weight: lean into acceleration, rock back when braking, bank into strafes
    const accel = dt > 0 ? (speed - this.prevSpeed) / dt : 0;
    this.prevSpeed = speed;
    this.lean += (THREE.MathUtils.clamp(accel * 0.035 * (backward ? -1 : 1), -0.14, 0.18) - this.lean) * Math.min(1, dt * 6);
    const bankTarget = s.grounded ? s.localDir.x * THREE.MathUtils.clamp(speed / 6, 0, 1) * 0.1 : 0;
    this.bank += (bankTarget - this.bank) * Math.min(1, dt * 5);
    if (Math.abs(this.lean) > 1e-3) this.rotateModel(this.spine, this.axisX, this.lean);
    if (Math.abs(this.bank) > 1e-3) this.rotateModel(this.spine, this.axisZ, this.bank);
    // stance: full while standing, gone at a jog
    this.stanceWeight += ((1 - move) * (s.grounded ? 1 : 0) - this.stanceWeight) * Math.min(1, dt * 4);
    if (this.stanceWeight > 0.01) for (const a of this.stance) this.rotateModel(a.bone, a.axis, a.angle * this.stanceWeight);

    // cast overlay: restart the clip on each new cast
    if (this.castWeight > 0.5 && this.prevCast <= 0.5) this.castTime = 0;
    this.prevCast = this.castWeight;
    this.castTime += dt;
    const cw = this.castWeight;
    if (cw > 0.01) {
      const feel = CAST_FEEL[this.castKind];
      const o = this.overlays[this.castKind === 'basic' ? 'basic' : 'skill'];
      const ct = Math.min(this.castTime * feel.rate, o.duration * 0.95);
      for (const c of o.tracks) {
        const v = c.interp.evaluate(ct);
        this.tmpQ.set(v[0]!, v[1]!, v[2]!, v[3]!);
        c.bone.quaternion.slerp(this.tmpQ, cw);
      }
      // skills and ultimates: ease into the god's accent over the first 40% of the clip and hold it
      if (feel.accent > 0) {
        const k = cw * feel.accent * THREE.MathUtils.smoothstep(ct, 0, o.duration * 0.4);
        const accents = this.castKind === 'ult' ? [...this.accents, ...this.ultAccents] : this.accents;
        if (accents.length) this.root.updateMatrixWorld(true);
        for (const a of accents) this.rotateModel(a.bone, a.axis, a.angle * k);
      }
    }
    // hit recoil: a quick ease in, then fade out by the end of the clip
    this.flinchTime += dt;
    if (this.flinchTime < this.flinchDuration && cw < 0.5) {
      const ft = this.flinchTime;
      const fw = this.flinchStrength * THREE.MathUtils.smoothstep(ft, 0, 0.06) * (1 - THREE.MathUtils.smoothstep(ft, this.flinchDuration * 0.45, this.flinchDuration));
      for (const c of this.flinches[this.flinchClip]!) {
        const v = c.interp.evaluate(ft);
        this.tmpQ.set(v[0]!, v[1]!, v[2]!, v[3]!);
        c.bone.quaternion.slerp(this.tmpQ, fw);
      }
    }
    // the weapon hand stays closed around its handle in every clip
    for (const c of this.curl) c.bone.quaternion.multiply(c.q);
    this.root.updateMatrixWorld(true);
    this.physics.update(Math.min(clothDt, 1 / 20));
  }

  /** Rotates a bone about an axis given in the god's model space (parents must have current world matrices). */
  private rotateModel(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
    this.root.getWorldQuaternion(this.tmpQ);
    this.tmpV.copy(axis).applyQuaternion(this.tmpQ);
    const parent = bone.parent!;
    parent.getWorldQuaternion(this.tmpQ);
    this.tmpQ2.setFromAxisAngle(this.tmpV, angle);
    const p = this.tmpQ;
    bone.quaternion.premultiply(p.clone().invert().multiply(this.tmpQ2).multiply(p));
    bone.updateMatrixWorld(true);
  }

  private rotateWorldY(bone: THREE.Object3D, angle: number): void {
    // q_local' = P^-1 * R * P * q_local, with P the parent's world rotation
    const parent = bone.parent!;
    parent.getWorldQuaternion(this.tmpQ);
    this.tmpQ2.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, angle);
    const p = this.tmpQ;
    bone.quaternion.premultiply(p.clone().invert().multiply(this.tmpQ2).multiply(p));
    bone.updateMatrixWorld(true);
  }
}
