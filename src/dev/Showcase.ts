import * as THREE from 'three/webgpu';
import { GodModel } from '../actors/GodModel';
import { GOD_IDS } from '../actors/gods/assets';

/**
 * `?showcase` dev view for comparing god models: a lineup in front of the
 * spawn with a fixed camera. Options (all optional):
 *   showcase=zeus,thor   which gods (default: all)
 *   pose=idle|walk|jog|sprint|cast
 *   view=front|back|side|close|three
 */
export class Showcase {
  readonly gods: GodModel[] = [];
  private readonly state = { speed: 0, localDir: new THREE.Vector2(), grounded: true, verticalSpeed: 0 };
  private readonly pose: string;
  private t = 0;
  private readonly view: string;

  constructor(params: URLSearchParams, parent: THREE.Object3D, spawn: { x: number; z: number; yaw: number }, ground: (x: number, z: number) => number, private readonly camera: THREE.PerspectiveCamera) {
    const list = (params.get('showcase') || GOD_IDS.join(',')).split(',').filter(Boolean);
    this.pose = params.get('pose') ?? 'idle';
    const view = params.get('view') ?? 'front';
    this.view = view;
    // `flip` turns the lineup around so the sun lights the fronts
    const yaw = spawn.yaw + (params.has('flip') ? Math.PI : 0);
    // forward (-sin, -cos), right (cos, -sin), like the player controller
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const center = new THREE.Vector3(spawn.x, 0, spawn.z).addScaledVector(fwd, 6);
    const gap = 1.7;
    list.forEach((id, i) => {
      const g = new GodModel(id);
      const off = (i - (list.length - 1) / 2) * gap;
      const p = center.clone().addScaledVector(right, off);
      p.y = ground(p.x, p.z);
      g.root.position.copy(p);
      // face back toward the spawn (the camera)
      g.root.rotation.y = yaw + Math.PI + Math.PI;
      if (view === 'back') g.root.rotation.y += Math.PI;
      if (view === 'side') g.root.rotation.y += Math.PI / 2;
      if (view === 'three') g.root.rotation.y += 0.6;
      if (this.pose.startsWith('clip:')) g.debugClip(this.pose.slice(5), Number(params.get('t') ?? 0));
      const hide = (params.get('hide') ?? '').split(',').filter(Boolean);
      if (hide.length) g.root.traverse((o) => { if (hide.some((h) => o.name.startsWith(h))) o.visible = false; });
      parent.add(g.root);
      this.gods.push(g);
    });
    const width = list.length * gap;
    const close = view === 'close' || view === 'portrait';
    const dist = view === 'portrait' ? 1.1 : close ? 2.9 : Math.max(4.2, width * 1.05);
    const h = view === 'portrait' ? 2.12 : close ? 1.4 : 1.35;
    const cam = center.clone().addScaledVector(fwd, -dist);
    cam.y = ground(center.x, center.z) + h + (close ? 0.05 : 0.25);
    camera.position.copy(cam);
    camera.lookAt(center.x, ground(center.x, center.z) + h, center.z);
    if (this.pose === 'walk') this.state.speed = 1.8;
    if (this.pose === 'jog') this.state.speed = 4.6;
    if (this.pose === 'sprint') this.state.speed = 7;
    if (this.state.speed) this.state.localDir.set(0, 1);
  }

  update(dt: number): void {
    this.t += dt;
    for (const g of this.gods) {
      if (this.pose === 'cast') g.castWeight = 1;
      g.animate(dt, this.state);
    }
    const g = this.gods[0];
    if (this.view === 'portrait' && g) {
      // frame the face: in front of the head bone, slightly above eye level
      const head = g.head.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(g.root.quaternion);
      head.y += 0.1;
      this.camera.position.copy(head).addScaledVector(fwd, 1.05).add(new THREE.Vector3(0, 0.04, 0));
      this.camera.lookAt(head.x, head.y - 0.06, head.z);
    }
  }
}
