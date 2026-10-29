import * as THREE from 'three/webgpu';
import { GodModel, type LocomotionState } from '../../actors/GodModel';
import type { Team } from '../../map/ConquestLayout';
import { lathe } from '../Architecture';
import type { MaterialLibrary } from '../Materials';
import { clamp01, crackedStone, ease, mergeStatic, Rubble, shieldMesh, TEAM_STYLE, TeamMaterials } from './common';
import type { StructureModel } from './TowerModel';

/** Seconds from `attack()` to the moment the slam lands. */
export const TITAN_HIT_DELAY = 0.35;
const ATTACK_LENGTH = 1.1;
const SCALE = 4.2;
const DAIS_TOP = 1.05;

/**
 * The Titan: a colossal marble statue-god on a rune-ringed dais. It breathes,
 * slams its spear down when it attacks, and topples when destroyed.
 */
export class TitanModel implements StructureModel {
  readonly root = new THREE.Group();
  readonly height = DAIS_TOP + 2.45 * SCALE + 0.6;
  readonly muzzle = new THREE.Object3D();
  private readonly statue: GodModel;
  private readonly body = new THREE.Group();
  private readonly shield: THREE.Mesh;
  private readonly rubble: Rubble;
  private readonly damage: any;
  private readonly light: THREE.PointLight;
  private attackT = -1;
  private destroyed = 0;
  private readonly idle: LocomotionState = { speed: 0, localDir: new THREE.Vector2(), grounded: true, verticalSpeed: 0 };

  constructor(lib: MaterialLibrary, team: Team, teamMats?: TeamMaterials) {
    const style = TEAM_STYLE[team];
    const tm = teamMats ?? new TeamMaterials(lib, style);
    const { material: marble, damage } = crackedStone(lib.marble, style.glow);
    this.damage = damage;
    this.root.name = `titan-${team}`;

    const dais = new THREE.Mesh(lathe([
      [0.001, 0], [7.2, 0], [7.2, 0.35], [6.6, 0.35], [6.6, 0.7], [6.0, 0.7], [6.0, DAIS_TOP], [0.001, DAIS_TOP],
    ], 96), lib.marble);
    dais.castShadow = true;
    dais.receiveShadow = true;
    this.root.add(dais);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.07, 8, 96).rotateX(Math.PI / 2), tm.runes);
    ring.position.y = DAIS_TOP + 0.02;
    this.root.add(ring);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const glyph = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.18), tm.runes);
      glyph.position.set(Math.cos(a) * 4.9, DAIS_TOP + 0.02, Math.sin(a) * 4.9);
      glyph.rotation.y = -a;
      this.root.add(glyph);
    }

    // The statue reuses a god rig, re-dressed in stone, team trim and team cloth.
    this.statue = new GodModel('zeus');
    const dress: Record<string, THREE.Material> = {
      gold: tm.trim, goldplain: tm.trim, steel: tm.trim, leather: lib.bronze,
      cloth: tm.banner, clothplain: tm.banner, gem: tm.crystal, glow: tm.crystal,
    };
    this.statue.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.material = dress[(mesh.material as THREE.Material).name] ?? marble;
    });
    this.statue.root.scale.setScalar(SCALE);
    this.body.position.y = DAIS_TOP;
    this.body.add(this.statue.root);
    this.root.add(this.body);
    this.statue.rightHand.add(this.muzzle);
    this.statue.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    this.light = new THREE.PointLight(style.fire.light, 40, 22, 2);
    this.light.position.set(0, DAIS_TOP + 0.5, 0);
    this.root.add(this.light);
    this.shield = shieldMesh(7.6, this.height + 1.5, style.glow);
    this.root.add(this.shield);
    this.rubble = new Rubble(6.5, 30, [marble, lib.marble, lib.bronze], 700);
    this.rubble.group.position.y = DAIS_TOP;
    this.root.add(this.rubble.group);
    mergeStatic(this.root, [this.body, this.shield, this.rubble.group]);
  }

  setShielded(on: boolean): void {
    this.shield.visible = on && this.destroyed < 1;
  }

  pulseFire(): void {
    this.attack();
  }

  /** Spear slam; the blow lands `TITAN_HIT_DELAY` seconds after the call. */
  attack(): void {
    if (this.destroyed > 0) return;
    this.attackT = 0;
  }

  setDamage(d: number): void {
    this.damage.value = clamp01(d);
  }

  /** Topples backward off the dais and breaks apart. */
  setDestroyed(t: number): void {
    this.destroyed = clamp01(t);
    const fall = ease(this.destroyed * 1.3);
    this.body.rotation.x = -fall * 1.35;
    this.body.position.set(0, DAIS_TOP - fall * 2.2, -fall * 3);
    this.body.visible = this.destroyed < 0.95;
    this.rubble.setGrowth(Math.max(0, this.destroyed - 0.35) * 1.8);
    if (this.destroyed > 0) this.shield.visible = false;
  }

  update(dt: number, time: number): void {
    let cast = 0;
    let impact = 0;
    if (this.attackT >= 0) {
      this.attackT += dt;
      const a = this.attackT;
      const wind = TITAN_HIT_DELAY - 0.08;
      // raise the spear, drive it down on the beat, then recover
      if (a < wind) cast = ease(a / wind);
      else if (a < TITAN_HIT_DELAY) cast = 1 - (a - wind) / 0.08;
      else cast = 0;
      impact = a >= TITAN_HIT_DELAY && a < TITAN_HIT_DELAY + 0.25 ? 1 - (a - TITAN_HIT_DELAY) / 0.25 : 0;
      this.light.intensity = 40 + impact * 400;
      if (a > ATTACK_LENGTH) this.attackT = -1;
    } else {
      this.light.intensity = 40 * (1 - this.destroyed) * (0.9 + 0.1 * Math.sin(time * 1.3));
    }
    this.statue.castWeight = cast;
    if (this.destroyed < 0.95) this.statue.animate(dt, this.idle);
    this.statue.hips.position.y -= impact * 0.12;
  }
}
