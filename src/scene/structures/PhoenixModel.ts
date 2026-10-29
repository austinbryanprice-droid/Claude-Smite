import * as THREE from 'three/webgpu';
import {
  color, float, mix, mx_noise_float, positionLocal, pow, smoothstep, time, uniform, vec3,
} from '../../render/tsl';
import type { Team } from '../../map/ConquestLayout';
import { lathe } from '../Architecture';
import { Fire } from '../Effects';
import type { MaterialLibrary } from '../Materials';
import { clamp01, crackedStone, ease, mergeStatic, Rubble, shieldMesh, TEAM_STYLE, TeamMaterials } from './common';
import type { StructureModel } from './TowerModel';

/** One feather: a long, flat, pointed blade along +Y from its root. */
function feather(length: number, width: number): THREE.BufferGeometry {
  const g = lathe([
    [0.001, 0], [width * 0.35, length * 0.06], [width * 0.5, length * 0.35], [width * 0.42, length * 0.7], [width * 0.18, length * 0.92], [0.001, length],
  ], 10);
  g.scale(1, 1, 0.16);
  return g;
}

/**
 * The Phoenix: a stepped marble pedestal holding a brazier, above which a
 * great bird of gilded, burning feathers spreads its wings. It dies into the
 * brazier's embers and rises again.
 */
export class PhoenixModel implements StructureModel {
  readonly root = new THREE.Group();
  readonly height = 8.2;
  readonly muzzle = new THREE.Object3D();
  private readonly bird = new THREE.Group();
  private readonly wings: THREE.Group[] = [];
  private readonly fire: Fire;
  private readonly shield: THREE.Mesh;
  private readonly rubble: Rubble;
  private readonly damage: any;
  private readonly heat = uniform(1);
  private shot = 0;
  private destroyed = 0;
  private rebirth = 1;
  private readonly birdY = 4.7;

  constructor(lib: MaterialLibrary, team: Team, teamMats?: TeamMaterials) {
    const style = TEAM_STYLE[team];
    const tm = teamMats ?? new TeamMaterials(lib, style);
    const { material: stone, damage } = crackedStone(lib.marble, style.glow);
    this.damage = damage;
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.root.name = `phoenix-${team}`;

    // Pedestal: three round steps, a fluted drum and a bronze brazier bowl.
    add(this.root, lathe([
      [0.001, 0], [3.7, 0], [3.7, 0.35], [3.2, 0.35], [3.2, 0.7], [2.7, 0.7], [2.7, 1.05], [0.001, 1.05],
    ], 64), stone);
    add(this.root, lathe([
      [0.001, 1.0], [1.55, 1.0], [1.55, 1.15], [1.35, 1.25], [1.25, 2.3], [1.45, 2.45], [1.5, 2.6], [0.001, 2.6],
    ], 48), stone);
    add(this.root, new THREE.TorusGeometry(1.42, 0.08, 10, 48).rotateX(Math.PI / 2), tm.trim, 0, 2.5);
    add(this.root, lathe([
      [0.001, 2.55], [0.7, 2.6], [1.5, 2.85], [1.95, 3.25], [2.0, 3.35], [1.85, 3.3], [1.4, 3.0], [0.001, 2.95],
    ], 48), lib.bronze);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      add(this.root, new THREE.BoxGeometry(0.3, 0.18, 0.04), tm.runes, Math.cos(a) * 2.98, 0.86, Math.sin(a) * 2.98).rotation.y = -a + Math.PI / 2;
    }
    this.fire = new Fire(new THREE.Vector3(0, 3.0, 0), 1.6, 3, 50, style.fire);
    this.root.add(this.fire.group);

    // The bird: gilded body whose feathers burn toward their tips.
    const birdMat = new THREE.MeshStandardNodeMaterial();
    const tip = smoothstep(0.4, 2.4, positionLocal.y.abs().add(positionLocal.z.abs().mul(0.6)));
    const flow = mx_noise_float(vec3(positionLocal.x.mul(1.8), positionLocal.y.mul(1.8).sub(time.mul(1.4)), positionLocal.z.mul(1.8))).mul(0.5).add(0.5);
    const burn = pow(tip.mul(flow.mul(0.6).add(0.6)), float(1.3)).clamp(0, 1);
    const fireCol = mix(color(style.fire.low), color(style.fire.high), flow.mul(0.45));
    birdMat.colorNode = mix(color(team === 'order' ? 0xd9a441 : 0x3a1a14), fireCol, burn.mul(0.6));
    birdMat.metalnessNode = float(1).sub(burn);
    birdMat.roughnessNode = float(0.28);
    birdMat.emissiveNode = fireCol.mul(burn.mul(3).add(0.15)).mul(this.heat);

    this.bird.position.y = this.birdY;
    this.root.add(this.bird);
    // body and neck along +Z
    const body = lathe([[0.001, -1.0], [0.3, -0.85], [0.55, -0.35], [0.6, 0.1], [0.45, 0.55], [0.26, 0.9], [0.001, 1.05]], 24);
    body.rotateX(Math.PI / 2);
    add(this.bird, body, birdMat);
    const head = add(this.bird, new THREE.SphereGeometry(0.3, 20, 14).scale(0.9, 1, 1.2), birdMat, 0, 0.55, 1.15);
    add(head, new THREE.ConeGeometry(0.1, 0.45, 10).rotateX(Math.PI / 2), tm.trim, 0, -0.06, 0.45);
    for (const sx of [-1, 1]) {
      const eye = add(head, new THREE.SphereGeometry(0.05, 8, 6), tm.crystal, sx * 0.15, 0.06, 0.24);
      eye.castShadow = false;
    }
    for (let i = 0; i < 3; i++) {
      const crest = add(head, feather(0.9 - i * 0.15, 0.22), birdMat, 0, 0.18, -0.1 - i * 0.12);
      crest.rotation.x = -0.9 - i * 0.25;
    }
    this.bird.add(this.muzzle);
    this.muzzle.position.set(0, 0.5, 1.65);
    // neck
    add(this.bird, new THREE.CylinderGeometry(0.18, 0.3, 0.8, 12).rotateX(-0.9), birdMat, 0, 0.32, 0.8);

    // wings: fans of feathers from a shoulder pivot
    for (const sx of [-1, 1]) {
      const wing = new THREE.Group();
      wing.position.set(sx * 0.4, 0.25, 0.2);
      this.bird.add(wing);
      this.wings.push(wing);
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const len = 1.4 + Math.sin(t * Math.PI * 0.85) * 1.6;
        const f = add(wing, feather(len, 0.42), birdMat);
        // fan from nearly up to out-and-back
        f.rotation.set(-0.15 - t * 0.5, 0, -sx * (0.35 + t * 1.15));
        f.position.set(sx * t * 0.9, t * 0.15, -t * 0.35);
      }
    }
    // tail: long trailing feathers fanned behind and down
    for (let i = 0; i < 5; i++) {
      const f = add(this.bird, feather(2.6 - Math.abs(i - 2) * 0.35, 0.36), birdMat, (i - 2) * 0.12, -0.1, -0.85);
      f.rotation.set(-2.0 - Math.abs(i - 2) * 0.05, 0, (i - 2) * 0.22);
    }

    this.shield = shieldMesh(4.6, this.height + 0.8, style.glow);
    this.root.add(this.shield);
    this.rubble = new Rubble(3.2, 12, [stone, lib.bronze], 500);
    this.rubble.group.position.y = 1.0;
    this.root.add(this.rubble.group);
    for (const w of this.wings) mergeStatic(w);
    mergeStatic(this.bird, this.wings);
    mergeStatic(this.root, [this.bird, this.fire.group, this.shield, this.rubble.group]);
  }

  setShielded(on: boolean): void {
    this.shield.visible = on && this.destroyed < 1;
  }

  pulseFire(): void {
    this.shot = 1;
  }

  setDamage(d: number): void {
    this.damage.value = clamp01(d);
  }

  /** 0 = alive, 1 = burnt out: the bird flares, then collapses into the brazier. */
  setDestroyed(t: number): void {
    this.destroyed = clamp01(t);
    this.rebirth = 1 - this.destroyed;
    this.applyLife();
    this.rubble.setGrowth(this.destroyed > 0.3 ? (this.destroyed - 0.3) * 1.6 : 0);
    if (this.destroyed > 0) this.shield.visible = false;
  }

  /** 0 = embers, 1 = fully risen. */
  setRebirth(t: number): void {
    this.rebirth = clamp01(t);
    this.destroyed = 1 - this.rebirth;
    this.applyLife();
    this.rubble.setGrowth((1 - this.rebirth) * 1.2);
  }

  private applyLife(): void {
    const life = ease(this.rebirth);
    this.bird.visible = life > 0.02;
    this.bird.scale.setScalar(Math.max(0.02, life));
    this.fire.strength.value = 0.35 + 0.65 * life;
  }

  update(dt: number, time: number): void {
    this.shot = Math.max(0, this.shot - dt * 3);
    this.fire.update(time);
    const life = ease(this.rebirth);
    // A dying or rising Phoenix burns hotter.
    const flare = 1 + (1 - Math.abs(life * 2 - 1)) * 3 * (life < 1 && life > 0 ? 1 : 0);
    this.heat.value = (1 + this.shot * 2.5) * flare;
    const flap = Math.sin(time * 1.4) * 0.22 + this.shot * 0.3;
    this.wings[0]!.rotation.set(0, 0, -flap);
    this.wings[1]!.rotation.set(0, 0, flap);
    this.bird.position.y = this.birdY + Math.sin(time * 1.4 - 0.6) * 0.18 + (1 - life) * -1.6;
    this.bird.rotation.y = (1 - life) * 6;
  }
}
