import * as THREE from 'three/webgpu';
import type { Team } from '../game/combatant';
import { color, float, mix, mx_noise_float, positionLocal, sin, time, uniform, vec3 } from '../render/tsl';
import { lathe } from '../scene/Architecture';
import type { StructureKind } from '../sim/factory';
import { createGodModel } from './godModels';
import { MUZZLE_HEIGHT } from './Vfx';

/**
 * What combat needs from a Tower, Phoenix or Titan mesh. The scene thread's
 * structure models implement the same hooks; until they land these
 * placeholders stand in, built from the same parts as the temple.
 */
export interface StructureModel {
  readonly root: THREE.Object3D;
  /** Top of the structure, for its health bar. */
  readonly height: number;
  setShielded(on: boolean): void;
  /** Called on every shot or stomp. */
  pulseFire(): void;
  /** 0 = intact, 1 = rubble. */
  setDestroyed(t: number): void;
  /** Phoenix rising from its rubble, 0..1. */
  setRebirth?(t: number): void;
  /** Wear from damage taken, 0..1. */
  setDamage?(d: number): void;
  /** The Titan's slam; its hit lands TITAN_WINDUP seconds later. */
  attack?(): void;
  /** Where shots leave from. */
  readonly muzzle?: THREE.Object3D;
  update(dt: number, time: number): void;
}

const TEAM: Record<Team, { trim: number; glow: number; cloth: number }> = {
  order: { trim: 0xd9a845, glow: 0x4fb2ff, cloth: 0x1f4fb8 },
  chaos: { trim: 0x3a2a22, glow: 0xff3524, cloth: 0x8e1016 },
};

function stoneMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82 });
  const n = mx_noise_float(positionLocal.mul(1.6)).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(14)).mul(0.5).add(0.5);
  m.colorNode = mix(vec3(0.5, 0.48, 0.44), vec3(0.78, 0.75, 0.68), n.mul(0.7).add(fine.mul(0.3)));
  return m;
}

/** A glowing crystal whose brightness the shield and firing drive. */
function crystal(team: Team, size: number): { mesh: THREE.Mesh; glow: ReturnType<typeof uniform> } {
  const glow = uniform(1);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.15, metalness: 0.1 });
  const c = new THREE.Color(TEAM[team].glow);
  m.colorNode = vec3(c.r, c.g, c.b).mul(0.6);
  m.emissiveNode = color(c).mul(glow.mul(sin(time.mul(2.4)).mul(0.2).add(1.4)));
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(size, 0).scale(0.7, 1.5, 0.7), m);
  return { mesh, glow };
}

class PillarStructure implements StructureModel {
  readonly root = new THREE.Group();
  readonly height: number;
  private readonly intact = new THREE.Group();
  private readonly rubble = new THREE.Group();
  private readonly gem: THREE.Mesh;
  private readonly glow: ReturnType<typeof uniform>;
  private readonly shield: THREE.Mesh;
  private readonly shieldOn = uniform(0);
  private fire = 0;
  private spin = 0;

  constructor(kind: 'tower' | 'phoenix', team: Team) {
    const stone = stoneMaterial();
    const trim = new THREE.MeshPhysicalNodeMaterial({ color: TEAM[team].trim, metalness: team === 'order' ? 1 : 0.5, roughness: 0.3 });
    const top = MUZZLE_HEIGHT[kind]!;
    this.height = top + 1.6;
    const r = kind === 'tower' ? 2.2 : 3;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, y = 0, parent: THREE.Object3D = this.intact) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.y = y;
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // stepped plinth, tapering shaft, ring of trim, open cradle at the top
    add(lathe([[0.001, 0], [r * 1.2, 0], [r * 1.2, 0.35], [r, 0.4], [r, 0.8], [r * 0.82, 0.85], [0.001, 0.85]], 8), stone);
    add(lathe([[r * 0.7, 0.85], [r * 0.55, top * 0.55], [r * 0.5, top - 1.6], [r * 0.68, top - 1.3], [r * 0.72, top - 1.0], [0.001, top - 1.0]], 8), stone);
    add(new THREE.TorusGeometry(r * 0.56, 0.12, 8, 8).rotateX(Math.PI / 2), trim, top * 0.55);
    add(new THREE.TorusGeometry(r * 0.66, 0.1, 8, 8).rotateX(Math.PI / 2), trim, top - 1.05);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const claw = add(new THREE.ConeGeometry(0.22, 1.9, 6), trim, top - 0.2);
      claw.position.x = Math.cos(a) * r * 0.55;
      claw.position.z = Math.sin(a) * r * 0.55;
      claw.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
    }
    if (kind === 'phoenix') {
      // wings of the firebird folded around the flame
      for (const sx of [-1, 1]) {
        const wing = add(new THREE.ConeGeometry(0.9, 3.4, 4, 1).scale(0.35, 1, 1), trim, top + 0.3);
        wing.position.x = sx * 1.3;
        wing.rotation.z = sx * 0.7;
      }
    }
    const c = crystal(team, kind === 'tower' ? 0.6 : 0.85);
    this.gem = c.mesh;
    this.glow = c.glow;
    this.gem.position.y = top;
    this.intact.add(this.gem);
    // protective dome while shielded
    const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const sc = new THREE.Color(TEAM[team].glow);
    const rim = mx_noise_float(positionLocal.mul(1.2).add(vec3(0, time.mul(0.6), 0))).mul(0.5).add(0.5);
    sm.colorNode = color(sc).mul(rim.mul(0.5).add(0.25)).mul(this.shieldOn);
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(r * 1.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, top / (r * 1.3), 1), sm);
    this.intact.add(this.shield);
    // rubble: tumbled blocks
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4;
      const d = r * (0.3 + (i % 3) * 0.35);
      const b = add(new THREE.BoxGeometry(1 + (i % 2) * 0.6, 0.6 + (i % 3) * 0.3, 0.9), stone, 0.3, this.rubble);
      b.position.set(Math.cos(a) * d, 0.3, Math.sin(a) * d);
      b.rotation.set(i * 0.4, a, i * 0.2);
    }
    this.rubble.visible = false;
    this.root.add(this.intact, this.rubble);
  }

  setShielded(on: boolean): void {
    this.shieldOn.value = on ? 1 : 0;
  }

  pulseFire(): void {
    this.fire = 1;
  }

  setDestroyed(t: number): void {
    // sink and tilt, then leave rubble
    this.intact.visible = t < 1;
    this.rubble.visible = t > 0.3;
    this.intact.position.y = -t * t * this.height;
    this.intact.rotation.z = t * 0.25;
  }

  setRebirth(t: number): void {
    this.setDestroyed(1 - t);
  }

  update(dt: number): void {
    this.fire = Math.max(0, this.fire - dt * 3);
    this.spin += dt * (0.6 + this.fire * 6);
    this.gem.rotation.y = this.spin;
    this.gem.scale.setScalar(1 + this.fire * 0.35);
    this.glow.value = 1 + this.fire * 5;
  }
}

/** The Titan placeholder: a colossal god statue in the team's colors. */
class TitanStructure implements StructureModel {
  readonly root = new THREE.Group();
  readonly height = 2.45 * 3.4;
  private readonly model = createGodModel('zeus');
  private readonly halo: THREE.Mesh;
  private readonly shieldOn = uniform(0);
  private slam = 0;
  private destroyed = 0;
  private readonly still = new THREE.Vector2();

  constructor(team: Team) {
    this.model.root.scale.setScalar(3.4);
    this.root.add(this.model.root);
    // the statue's armor in the team's metal (this instance only)
    this.model.tintMetal(TEAM[team].trim);
    const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    sm.colorNode = color(new THREE.Color(TEAM[team].glow)).mul(float(0.35)).mul(this.shieldOn);
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(7, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.4, 1), sm);
    this.root.add(this.halo);
  }

  setShielded(on: boolean): void {
    this.shieldOn.value = on ? 1 : 0;
  }

  pulseFire(): void {
    this.slam = 1;
  }

  setDestroyed(t: number): void {
    this.destroyed = t;
    this.model.root.rotation.x = -t * t * 1.4;
    this.model.root.position.y = -t * 2;
  }

  update(dt: number): void {
    this.slam = Math.max(0, this.slam - dt * 2.5);
    this.model.castWeight = this.slam;
    if (this.destroyed < 1) this.model.animate(dt, { speed: 0, localDir: this.still, grounded: true, verticalSpeed: 0 });
  }
}

/** One place to build structure meshes, so the scene's models can replace these. */
export function createStructureModel(kind: StructureKind, team: Team): StructureModel {
  return kind === 'titan' ? new TitanStructure(team) : new PillarStructure(kind, team);
}
