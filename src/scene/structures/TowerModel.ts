import * as THREE from 'three/webgpu';
import { rng } from '../../core/random';
import type { Team } from '../../map/ConquestLayout';
import { dot, mix, vec3 } from '../../render/tsl';
import { columnCapital, flutedShaft, roundedBox } from '../Architecture';
import type { MaterialLibrary } from '../Materials';
import { agedMarble, clamp01, crackedStone, ease, mergeStatic, Rubble, shieldMesh, showWear, TEAM_STYLE, TeamMaterials, wearUniforms } from './common';

/** What every structure view exposes to the combat code. */
export interface StructureModel {
  /** Ground center; the owner sets position and rotation.y. Front faces +Z. */
  readonly root: THREE.Group;
  /** Top of the structure, meters, for health bars. */
  readonly height: number;
  /** Where shots leave from. */
  readonly muzzle: THREE.Object3D;
  setShielded(on: boolean): void;
  /** Call on each shot. */
  pulseFire(): void;
  /** 0 = pristine, 1 = about to fall. */
  setDamage(d: number): void;
  /** 0 = standing, 1 = rubble. */
  setDestroyed(t: number): void;
  /** Height above the root that still blocks the follow camera: everything while standing, the rubble once fallen. */
  readonly solidTop: number;
  /** `camera` lets a model spend less on animation far from the view. */
  update(dt: number, time: number, camera?: THREE.Camera): void;
}

/** A square-tapered tower body (flat-shaded frustum), from y0 to y1. */
function frustum(bottom: number, top: number, y0: number, y1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(top / Math.SQRT2, bottom / Math.SQRT2, y1 - y0, 4, 6);
  g.rotateY(Math.PI / 4);
  g.translate(0, (y0 + y1) / 2, 0);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

const limestones = new WeakMap<MaterialLibrary, THREE.MeshStandardNodeMaterial>();

/**
 * Pale, sun-bleached limestone rather than orange sandstone, so the gold trim
 * and team colors carry the tower. One per library, shared by every tower.
 */
function limestone(lib: MaterialLibrary): THREE.MeshStandardNodeMaterial {
  let m = limestones.get(lib);
  if (!m) {
    m = lib.sandstone.clone() as THREE.MeshStandardNodeMaterial;
    const sand = lib.sandstone.colorNode as any;
    m.colorNode = mix(sand, vec3(dot(sand.rgb, vec3(0.3, 0.59, 0.11))), 0.7).mul(vec3(1.08, 1.02, 0.92));
    limestones.set(lib, m);
  }
  return m;
}

/**
 * Lane tower: a tapered sandstone keep with marble pilasters, an open
 * colonnaded crown under a pyramid roof, and a floating team crystal that
 * fires. Team banners hang front and back.
 */
export class TowerModel implements StructureModel {
  readonly root = new THREE.Group();
  readonly height = 11.8;
  get solidTop(): number {
    return this.destroyed > 0.5 ? 1.2 : Infinity;
  }
  readonly muzzle = new THREE.Object3D();
  private readonly upper = new THREE.Group();
  private readonly crystal: THREE.Mesh;
  private readonly light: THREE.PointLight;
  private readonly shield: THREE.Mesh;
  private readonly rubble: Rubble;
  private readonly wear = wearUniforms();
  private readonly seed: number;
  private fire = 0;
  private destroyed = 0;
  private dmg = 0;
  private crystalY = 0;

  constructor(lib: MaterialLibrary, team: Team, teamMats?: TeamMaterials, seed = 1) {
    this.seed = seed;
    const style = TEAM_STYLE[team];
    const tm = teamMats ?? new TeamMaterials(lib, style);
    const stone = crackedStone(limestone(lib), style.glow);
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    this.root.name = `tower-${team}`;
    const marble = agedMarble(lib);

    // Plinth: two stepped slabs.
    add(this.root, roundedBox(5.6, 0.5, 5.6, 0.08), marble, 0, 0.25);
    add(this.root, roundedBox(4.7, 0.42, 4.7, 0.06), stone, 0, 0.71);
    this.root.add(this.upper);

    // Keep: tapered body with gold bands top and bottom.
    const y0 = 0.92;
    const y1 = 6.4;
    const wb = 3.7;
    const wt = 2.9;
    add(this.upper, frustum(wb, wt, y0, y1), stone);
    add(this.upper, frustum(wb + 0.22, wb + 0.16, y0, y0 + 0.28), tm.trim);
    add(this.upper, frustum(wt + 0.26, wt + 0.3, y1 - 0.3, y1), tm.trim);
    // Corner pilasters follow the taper.
    const lean = Math.atan(((wb - wt) / 2) / (y1 - y0));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const half = (wb + wt) / 4 + 0.05;
        const p = add(this.upper, roundedBox(0.42, y1 - y0 + 0.1, 0.42, 0.05), marble, sx * half, (y0 + y1) / 2, sz * half);
        p.rotation.set(sz * lean, 0, -sx * lean);
      }
    }
    // A glowing team frieze under the top band, studded with gold.
    add(this.upper, frustum(wt + 0.12, wt + 0.1, y1 - 0.75, y1 - 0.55), tm.runes).castShadow = false;
    for (const [x, z] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      for (let i = -2; i <= 2; i++) {
        const along = i * 0.55;
        add(this.upper, new THREE.SphereGeometry(0.07, 8, 6), tm.trim, x * (wt / 2 + 0.1) + z * along, y1 - 0.65, z * (wt / 2 + 0.1) + x * along).castShadow = false;
      }
    }

    // Team banners on all four faces, hanging just off the taper.
    for (const [x, z] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const g = new THREE.PlaneGeometry(1.4, 3.0, 4, 10);
      g.translate(0, -1.5, 0);
      const b = add(this.upper, g, tm.banner, x * (wt / 2 + 0.22), 5.55, z * (wt / 2 + 0.22));
      // yaw to face outward, then lean back with the tapered wall
      b.rotation.set(-lean, Math.atan2(x, z), 0, 'YXZ');
      const rod = add(this.upper, new THREE.CylinderGeometry(0.05, 0.05, 1.7, 8).rotateZ(Math.PI / 2), tm.trim, x * (wt / 2 + 0.24), 5.58, z * (wt / 2 + 0.24));
      rod.rotation.y = Math.atan2(x, z);
      rod.castShadow = false;
    }

    // Crown: slab, four columns, entablature and pyramid roof.
    add(this.upper, roundedBox(4.5, 0.45, 4.5, 0.06), marble, 0, y1 + 0.22);
    const colH = 2.5;
    const cy = y1 + 0.45;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        add(this.upper, flutedShaft(0.2, colH, 12, 36, 6), marble, sx * 1.75, cy, sz * 1.75);
        const cap = add(this.upper, columnCapital(0.2), tm.trim, sx * 1.75, cy + colH - 0.05, sz * 1.75);
        cap.scale.setScalar(1.1);
      }
    }
    const top = cy + colH + 0.45;
    add(this.upper, roundedBox(4.6, 0.4, 4.6, 0.06), marble, 0, top - 0.2);
    add(this.upper, frustum(4.75, 4.7, top - 0.02, top + 0.16), tm.trim);
    const roof = new THREE.ConeGeometry(3.25, 2.1, 4, 1);
    roof.rotateY(Math.PI / 4);
    const roofFlat = roof.toNonIndexed();
    roofFlat.computeVertexNormals();
    add(this.upper, roofFlat, team === 'order' ? lib.bronze : tm.trim, 0, top + 0.16 + 1.05);
    add(this.upper, new THREE.SphereGeometry(0.22, 16, 12), tm.trim, 0, top + 2.3);
    add(this.upper, new THREE.ConeGeometry(0.1, 0.9, 8), tm.trim, 0, top + 2.8);

    // Floating crystal: the tower's weapon.
    const cg = new THREE.OctahedronGeometry(0.5, 0);
    cg.scale(1, 1.7, 1);
    this.crystal = add(this.upper, cg, tm.crystal, 0, cy + 1.3);
    this.crystal.castShadow = false;
    this.crystalY = cy + 1.3;
    this.crystal.add(this.muzzle);
    this.light = new THREE.PointLight(style.fire.light, 30, 16, 2);
    this.light.position.y = cy + 1.3;
    this.upper.add(this.light);

    this.shield = shieldMesh(4.4, this.height + 1, style.glow);
    this.root.add(this.shield);
    this.rubble = new Rubble(4.2, 22, [stone, marble, lib.sandstone], 300 + seed);
    this.root.add(this.rubble.group);
    mergeStatic(this.upper, [this.crystal]);
    mergeStatic(this.root, [this.upper, this.shield, this.rubble.group]);
    showWear(this.root, stone, this.wear);
  }

  setShielded(on: boolean): void {
    this.shield.visible = on && this.destroyed < 1;
  }

  pulseFire(): void {
    this.fire = 1;
  }

  setDamage(d: number): void {
    this.dmg = clamp01(d);
    this.wear.damage = this.dmg;
  }

  setDestroyed(t: number): void {
    this.destroyed = clamp01(t);
    // The upper keep sinks and leans as it collapses into the rubble.
    const fall = ease(this.destroyed * 1.25);
    const r = rng(this.seed);
    this.upper.position.y = -fall * 6.5;
    this.upper.rotation.set(fall * (0.25 + r() * 0.2), 0, fall * (r() - 0.5) * 0.4);
    this.upper.scale.setScalar(1 - fall * 0.35);
    this.upper.visible = this.destroyed < 0.8;
    this.rubble.setGrowth(this.destroyed * 1.4);
    if (this.destroyed > 0) this.shield.visible = false;
  }

  update(dt: number, time: number): void {
    this.fire = Math.max(0, this.fire - dt * 4);
    const alive = 1 - this.destroyed;
    const flicker = this.dmg > 0.5 ? 0.75 + 0.25 * Math.sin(time * 23 + this.seed) * Math.sin(time * 7) : 1;
    this.crystal.rotation.y = time * 0.8;
    this.crystal.position.y = this.crystalY + Math.sin(time * 1.6 + this.seed) * 0.12;
    this.crystal.scale.setScalar(1 + this.fire * 0.35);
    this.light.intensity = (30 + this.fire * 160) * flicker * alive;
  }
}
