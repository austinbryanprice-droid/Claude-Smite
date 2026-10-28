import * as THREE from 'three/webgpu';
import type { Input } from '../core/Input';
import type { Updatable } from '../core/Loop';
import type { GodModel } from '../actors/GodModel';
import type { CollisionWorld } from '../scene/Collision';

/**
 * Smite-style movement: the god always faces where the camera aims (mouse
 * turns the god), WASD moves relative to that facing, strafing and backpedal
 * are slower than running forward. Runs on the fixed simulation step.
 */
export class PlayerController implements Updatable {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Facing / aim yaw in radians (0 = looking toward -Z). */
  yaw = 0;
  /** Camera pitch, radians; positive looks down. */
  pitch = 0.32;
  grounded = true;

  moveSpeed = 6.6;
  /**
   * Set by gameplay each step: the god's current speed (slows, buffs) and
   * whether input may move it at all (crowd control, dashes, death).
   */
  movement: { speed: number; canMove: boolean } | null = null;
  readonly radius = 0.55;
  private readonly prevPosition = new THREE.Vector3();
  private readonly localDir = new THREE.Vector2();
  private verticalSpeed = 0;
  mouseSensitivity = 0.0022;

  constructor(
    private readonly input: Input,
    private readonly collision: CollisionWorld,
    readonly model: GodModel,
  ) {}

  spawn(x: number, z: number, yaw: number): void {
    this.position.set(x, this.collision.groundAt(x, z), z);
    this.prevPosition.copy(this.position);
    this.yaw = yaw;
  }

  /** Mouse look is applied every frame (not fixed step) so aiming feels immediate. */
  look(): void {
    const d = this.input.consumeMouseDelta();
    this.yaw -= d.x * this.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch + d.y * this.mouseSensitivity, -0.35, 1.05);
  }

  update(dt: number): void {
    const i = this.input;
    const free = this.movement?.canMove ?? true;
    const f = free ? (i.isDown('KeyW') ? 1 : 0) - (i.isDown('KeyS') ? 1 : 0) : 0;
    const r = free ? (i.isDown('KeyD') ? 1 : 0) - (i.isDown('KeyA') ? 1 : 0) : 0;
    this.localDir.set(r, f);
    if (this.localDir.lengthSq() > 1) this.localDir.normalize();

    // backpedal and strafe penalties, like Smite
    const penalty = f < 0 ? 0.6 : f === 0 && r !== 0 ? 0.8 : 1;
    const speed = (this.movement?.speed ?? this.moveSpeed) * penalty;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    const wx = (-sin * this.localDir.y + cos * this.localDir.x) * speed;
    const wz = (-cos * this.localDir.y - sin * this.localDir.x) * speed;
    const accel = this.grounded ? 14 : 3;
    const k = 1 - Math.exp(-accel * dt);
    this.velocity.x += (wx - this.velocity.x) * k;
    this.velocity.z += (wz - this.velocity.z) * k;

    if (free && this.grounded && i.wasPressed('Space')) {
      this.verticalSpeed = 5.2;
      this.grounded = false;
    }
    this.verticalSpeed -= 16 * dt;

    this.prevPosition.copy(this.position);
    let nx = this.position.x + this.velocity.x * dt;
    let nz = this.position.z + this.velocity.z * dt;
    const resolved = this.collision.resolve(nx, nz, this.radius, this.position.y);
    nx = resolved.x;
    nz = resolved.z;
    const ground = this.collision.groundAt(nx, nz);
    let ny = this.position.y + this.verticalSpeed * dt;
    if (ny <= ground) {
      // snap up steps / slopes, land from jumps
      ny = ground;
      this.verticalSpeed = 0;
      this.grounded = true;
    } else if (this.grounded && ny - ground < 0.45) {
      // stay glued when walking down steps
      ny = ground;
      this.verticalSpeed = 0;
    } else {
      this.grounded = false;
    }
    this.position.set(nx, ny, nz);
    this.velocity.x = (nx - this.prevPosition.x) / dt;
    this.velocity.z = (nz - this.prevPosition.z) / dt;
  }

  /** Per-frame: place the model (interpolated) and animate it. */
  render(dt: number, alpha: number): void {
    const m = this.model.root;
    m.position.lerpVectors(this.prevPosition, this.position, alpha);
    m.rotation.y = this.yaw + Math.PI; // the model is built facing +Z
    this.model.animate(dt, {
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      localDir: this.localDir,
      grounded: this.grounded,
      verticalSpeed: this.verticalSpeed,
    });
  }
}
