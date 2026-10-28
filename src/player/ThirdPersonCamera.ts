import * as THREE from 'three/webgpu';
import type { PlayerController } from './PlayerController';
import type { CollisionWorld } from '../scene/Collision';

/**
 * Smite's over-the-shoulder camera: behind and above the god, centered on
 * the god slightly above the head so the crosshair sits ahead of them. Pitch
 * pulls the camera closer as it looks up. Collides with architecture.
 */
export class ThirdPersonCamera {
  distance = 7.2;
  height = 2.9;
  /** Small right shoulder offset; Smite keeps the god near screen center. */
  shoulder = 0.0;
  private current = new THREE.Vector3();
  private currentDistance = 7.2;
  private initialized = false;
  private shake = 0;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly player: PlayerController,
    private readonly collision: CollisionWorld,
  ) {}

  zoom(steps: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + steps * 0.6, 4.5, 11);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt: number): void {
    const p = this.player;
    const target = p.model.root.position;
    const yaw = p.yaw;
    const pitch = p.pitch;
    const focus = new THREE.Vector3(target.x, target.y + this.height, target.z);
    // direction from focus to camera
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    );
    // looking up brings the camera in so the ground doesn't swallow it
    let dist = this.distance * THREE.MathUtils.clamp(0.75 + pitch * 0.5, 0.6, 1.2);
    const hit = this.collision.raycast(focus.x, focus.y, focus.z, dir.x, dir.y, dir.z, dist, 0.35);
    dist = Math.max(1.2, hit);
    // pull in fast, ease back out
    const rate = dist < this.currentDistance ? 30 : 4;
    this.currentDistance += (dist - this.currentDistance) * (1 - Math.exp(-rate * dt));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const desired = focus.clone().addScaledVector(dir, this.currentDistance).addScaledVector(right, this.shoulder);
    if (!this.initialized) {
      this.current.copy(desired);
      this.initialized = true;
    }
    this.current.lerp(desired, 1 - Math.exp(-dt * 25));
    this.camera.position.copy(this.current);
    // aim point: ahead of the god, so the god sits a bit below screen center
    const aim = focus.clone().addScaledVector(new THREE.Vector3(-dir.x, 0, -dir.z).normalize(), 6);
    aim.y = focus.y - 0.4 - Math.sin(pitch) * 4;
    this.camera.lookAt(aim);
    if (this.shake > 0) {
      const s = this.shake * this.shake * 0.08;
      this.camera.rotation.x += (Math.random() - 0.5) * s;
      this.camera.rotation.y += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
  }
}
