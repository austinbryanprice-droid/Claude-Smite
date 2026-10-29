import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { godAsset, type GodAsset } from './gods/assets';
import { godMaterials } from './gods/materials';
import { SecondaryPhysics } from './gods/Physics';
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

/** Bones the cast pose overrides (upper body only, so legs keep running). */
const UPPER = /^DEF-(spine00[23]|neck|head|shoulder|upper_arm|forearm|hand|f_|thumb)/;

interface Loco {
  action: THREE.AnimationAction;
  /** Ground speed the clip was authored for, m/s at this god's size. */
  speed: number;
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
  readonly height: number;
  readonly id: string;

  private readonly mixer: THREE.AnimationMixer;
  private readonly loco: Loco[] = [];
  private readonly idle: THREE.AnimationAction;
  private readonly air: THREE.AnimationAction;
  private readonly asset: GodAsset;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly cast: { bone: THREE.Bone; interp: THREE.Interpolant }[] = [];
  private castDuration = 0.5;
  private castTime = 1e9;
  private prevCast = 0;
  private phase = 0;
  private smoothedSpeed = 0;
  private hipYaw = 0;
  private airWeight = 0;
  private readonly physics: SecondaryPhysics;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly curl: { bone: THREE.Bone; q: THREE.Quaternion }[] = [];

  constructor(god: string | object = 'zeus', variant?: string) {
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
      const name = (mesh.material as THREE.Material).name;
      mesh.material = mats.get(name) ?? mats.get('default')!;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    });
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

    const castClip = clip(variant === 'melee' || this.id === 'thor' ? 'Punch_Cross' : 'Spell_Simple_Shoot');
    this.castDuration = castClip.duration;
    for (const t of castClip.tracks) {
      const [node, prop] = t.name.split('.');
      if (prop !== 'quaternion' || !UPPER.test(node!)) continue;
      const b = this.bones.get(node!);
      if (b) this.cast.push({ bone: b, interp: (t as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant() });
    }

    for (const c of this.asset.meta.curl ?? []) {
      const b = bone(c.bone);
      const axis = new THREE.Vector3().fromArray(c.axis).normalize();
      if (b) this.curl.push({ bone: b, q: new THREE.Quaternion().setFromAxisAngle(axis, c.angle) });
    }

    this.physics = new SecondaryPhysics(this.root, scene, this.asset.meta, this.bones, mats);
    this.mixer.update(0);
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
      if (!/^(gold|goldplain|steel)$/.test(src.name)) return;
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

  /** Drives animation and secondary physics. Call once per rendered frame after placing `root`. */
  animate(dt: number, s: LocomotionState): void {
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
    for (const l of this.loco) {
      const w = l === lo ? (lo === hi ? 1 : 1 - t) : l === hi ? t : 0;
      l.action.setEffectiveWeight(w * move * ground);
      l.action.time = this.phase * l.action.getClip().duration;
      l.action.timeScale = 0;
    }
    this.idle.setEffectiveWeight((1 - move) * ground * (this.held ? 0 : 1));
    if (this.held) {
      for (const l of this.loco) l.action.setEffectiveWeight(0);
      this.air.setEffectiveWeight(0);
    }
    this.idle.timeScale = 1;
    this.air.setEffectiveWeight(this.airWeight);
    this.mixer.update(dt);

    // strafing: legs turn toward the movement direction, the torso keeps aiming
    const strafeYaw = speed > 0.5 ? Math.atan2(s.localDir.x, Math.max(0.25, Math.abs(s.localDir.y))) * (backward ? -0.6 : 0.6) : 0;
    this.hipYaw += (strafeYaw - this.hipYaw) * k;
    this.root.updateMatrixWorld(true);
    if (Math.abs(this.hipYaw) > 1e-3) {
      this.rotateWorldY(this.hips, -this.hipYaw);
      this.rotateWorldY(this.bones.get('DEF-spine001')!, this.hipYaw * 0.6);
      this.rotateWorldY(this.bones.get('DEF-spine002')!, this.hipYaw * 0.4);
    }

    // cast overlay: restart the clip on each new cast
    if (this.castWeight > 0.5 && this.prevCast <= 0.5) this.castTime = 0;
    this.prevCast = this.castWeight;
    this.castTime += dt;
    const cw = this.castWeight;
    if (cw > 0.01) {
      const ct = Math.min(this.castTime * 1.6, this.castDuration * 0.95);
      for (const c of this.cast) {
        const v = c.interp.evaluate(ct);
        this.tmpQ.set(v[0]!, v[1]!, v[2]!, v[3]!);
        c.bone.quaternion.slerp(this.tmpQ, cw);
      }
    }
    // the weapon hand stays closed around its handle in every clip
    for (const c of this.curl) c.bone.quaternion.multiply(c.q);
    this.root.updateMatrixWorld(true);
    this.physics.update(dt);
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
