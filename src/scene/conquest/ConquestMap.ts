import * as THREE from 'three/webgpu';
import { rng } from '../../core/random';
import { baseOf, ConquestLayout as L } from '../../map/ConquestLayout';
import type { QualitySettings } from '../../render/Quality';
import type { Collider, CollisionWorld } from '../Collision';
import { Fountain } from '../structures/Fountain';
import { PhoenixModel } from '../structures/PhoenixModel';
import { TitanModel } from '../structures/TitanModel';
import { TowerModel, type StructureModel } from '../structures/TowerModel';
import { TEAM_STYLE, TeamMaterials } from '../structures/common';
import type { Fire } from '../Effects';
import { Flowers, type FlowerInstance } from '../Flowers';
import { Foliage, type FoliageInstance, type SpeciesName } from '../Foliage';
import type { MaterialLibrary } from '../Materials';
import type { Terrain } from '../Terrain';
import type { MapContent } from '../World';
import type { ConquestTerrainDef } from './ConquestTerrain';
import { ConquestProps } from './Props';

/** Spatial hash for rejecting placements that crowd each other. */
class Spacing {
  private readonly cells = new Map<number, { x: number; z: number; r: number }[]>();
  constructor(private readonly cell: number) {}

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  free(x: number, z: number, r: number): boolean {
    const i = Math.floor(x / this.cell);
    const j = Math.floor(z / this.cell);
    for (let a = i - 2; a <= i + 2; a++) {
      for (let b = j - 2; b <= j + 2; b++) {
        for (const p of this.cells.get(this.key(a, b)) ?? []) if (Math.hypot(p.x - x, p.z - z) < p.r + r) return false;
      }
    }
    return true;
  }

  add(x: number, z: number, r: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push({ x, z, r });
  }
}

/**
 * Everything static on the Conquest map: structures, jungle camps, foliage
 * and props, all placed from `ConquestLayout`.
 */
export class ConquestMap implements MapContent {
  readonly group = new THREE.Group();
  readonly dynamic = new THREE.Group();
  readonly fires: Fire[] = [];
  readonly lights: THREE.PointLight[] = [];
  readonly spawn = baseOf('order').spawn;
  readonly groundColor = new THREE.Color(0.14, 0.17, 0.08);
  readonly foliage: Foliage;
  /**
   * Tower, Phoenix and Titan views keyed by layout id (`order-mid-outer`,
   * `chaos-duo-phoenix`, `order-titan`). Combat drives their state hooks; this
   * map places them and calls their `update` every frame.
   */
  readonly structures = new Map<string, StructureModel>();
  private readonly cameraBlockers: { model: StructureModel; collider: Collider; ground: number }[] = [];
  private readonly fountains: Fountain[] = [];
  private readonly props: ConquestProps;

  constructor(
    readonly materials: MaterialLibrary,
    readonly terrain: Terrain,
    readonly collision: CollisionWorld,
    readonly def: ConquestTerrainDef,
    readonly sunDirection: THREE.Vector3,
  ) {
    this.group.name = 'conquest';
    this.foliage = new Foliage(materials.textures, sunDirection);
    this.group.add(this.foliage.group);
    this.buildStructures();
    this.props = new ConquestProps(materials, terrain, collision, def);
    this.group.add(this.props.group);
    this.group.add(new Flowers(this.placeFlowers()).root);
    this.fires.push(...this.props.fires);
    for (const g of [this.dynamic, this.group]) g.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight) this.lights.push(o as THREE.PointLight);
    });
  }

  private buildStructures(): void {
    const teamMats = { order: new TeamMaterials(this.materials, TEAM_STYLE.order), chaos: new TeamMaterials(this.materials, TEAM_STYLE.chaos) };
    const enemyBase = (team: 'order' | 'chaos') => baseOf(team === 'order' ? 'chaos' : 'order').titan;
    /** Yaw that turns a model's +Z front toward a point. */
    const face = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
    const place = (id: string, model: StructureModel, x: number, z: number, yaw: number) => {
      model.root.position.set(x, this.terrain.heightAt(x, z), z);
      model.root.rotation.y = yaw;
      this.structures.set(id, model);
      this.dynamic.add(model.root);
    };
    let seed = 1;
    for (const t of L.towers) {
      const [ex, ez] = enemyBase(t.team);
      const yaw = face(t.at[0], t.at[1], ex, ez);
      const model = new TowerModel(this.materials, t.team, teamMats[t.team], seed++);
      place(t.id, model, t.at[0], t.at[1], yaw);
      // the square plinth is 5.6 m across
      this.blockCamera(model, { kind: 'box', x: t.at[0], z: t.at[1], hx: 2.8, hz: 2.8, yaw, top: Infinity });
    }
    for (const p of L.phoenixes) {
      const [ex, ez] = enemyBase(p.team);
      const model = new PhoenixModel(this.materials, p.team, teamMats[p.team]);
      place(p.id, model, p.at[0], p.at[1], face(p.at[0], p.at[1], ex, ez));
      this.blockCamera(model, { kind: 'circle', x: p.at[0], z: p.at[1], r: L.radii.phoenix, top: Infinity });
    }
    for (const b of L.bases) {
      const [ex, ez] = enemyBase(b.team);
      const titan = new TitanModel(this.materials, b.team, teamMats[b.team]);
      place(`${b.team}-titan`, titan, b.titan[0], b.titan[1], face(b.titan[0], b.titan[1], ex, ez));
      this.blockCamera(titan, { kind: 'circle', x: b.titan[0], z: b.titan[1], r: L.radii.titan, top: Infinity });
      const f = new Fountain(this.materials, b.team, L.radii.fountain, teamMats[b.team]);
      f.group.position.set(b.fountain[0], this.terrain.heightAt(b.fountain[0], b.fountain[1]), b.fountain[1]);
      this.fountains.push(f);
      this.fires.push(...f.fires);
      this.group.add(f.group);
    }
  }

  /**
   * Keeps the follow camera out of a structure, which otherwise ends up inside
   * a keep looking at a wall of banner whenever one is behind the player.
   * Camera only: units and shots already treat structures in the sim.
   */
  private blockCamera(model: StructureModel, collider: Collider): void {
    this.collision.addCameraBlocker(collider);
    this.cameraBlockers.push({ model, collider, ground: model.root.position.y });
  }

  /** Dims a buff camp's crystal while its buff is taken; camp ids come from `ConquestLayout.camps`. */
  setCampActive(campId: string, active: boolean): void {
    this.props.setCampActive(campId, active);
  }

  applyQuality(q: QualitySettings): void {
    const density = q.name === 'low' ? 0.45 : q.name === 'medium' ? 0.7 : 1;
    this.foliage.shadowDistance = q.shadowDistance;
    this.foliage.drawDistance = q.name === 'low' ? 110 : q.name === 'medium' ? 150 : q.name === 'high' ? 200 : 260;
    this.foliage.setInstances(this.placeFoliage(density));
  }

  /** Patches of flowering spikes along the lane and path verges, kept off pads and camp clearings. */
  private placeFlowers(): FlowerInstance[] {
    const out: FlowerInstance[] = [];
    const rand = rng(5151);
    const E = L.halfExtent;
    const normal = new THREE.Vector3();
    for (let i = 0; i < 140000; i++) {
      const x = (rand() * 2 - 1) * E;
      const z = (rand() * 2 - 1) * E;
      const lane = this.def.laneDistance(x, z);
      const path = this.def.pathDistance(x, z);
      // off every paved surface, and close to at least one of them
      if (lane < 0.6 || path < 0.4 || (lane > 4.5 && path > 3.5)) continue;
      if (this.def.plazaDistance(x, z) < 2) continue;
      if (L.camps.some((c) => Math.hypot(x - c.at[0], z - c.at[1]) < (c.team === null ? L.radii.boss : L.radii.camp) + 1)) continue;
      // drifts of flowers rather than an even sprinkle
      const patch = Math.sin(x * 0.13 + Math.sin(z * 0.11) * 2) * Math.sin(z * 0.17 + x * 0.07);
      if (patch < 0.12 || rand() > (patch - 0.12) * 2.2) continue;
      this.terrain.normalAt(x, z, normal);
      if (normal.y < 0.85) continue;
      out.push({ x, y: this.terrain.heightAt(x, z) - 0.02, z, yaw: rand() * Math.PI * 2, scale: 0.95 + rand() * 0.55 });
    }
    return out;
  }

  /** Scatters trees on the jungle walls, undergrowth along their feet and ferns in the corridors. */
  private placeFoliage(density: number): FoliageInstance[] {
    const out: FoliageInstance[] = [];
    const rand = rng(7171);
    const spacing = new Spacing(6);
    const E = L.halfExtent + 45;
    const normal = new THREE.Vector3();
    const tries = Math.round(90000 * density);
    const pick = (table: [SpeciesName, number][]): SpeciesName => {
      let r = rand();
      for (const [s, w] of table) if ((r -= w) <= 0) return s;
      return table[table.length - 1]![0];
    };
    for (let i = 0; i < tries; i++) {
      const x = (rand() * 2 - 1) * E;
      const z = (rand() * 2 - 1) * E;
      const open = this.def.walkable(x, z);
      const lane = this.def.laneDistance(x, z);
      const plaza = this.def.plazaDistance(x, z);
      if (lane < 2 || plaza < 1) continue;
      let species: SpeciesName;
      if (open < -4) species = pick([['canopy', 0.55], ['slender', 0.25], ['bush', 0.2]]);
      else if (open < 0.4) species = pick([['bush', 0.5], ['fern', 0.3], ['canopy', 0.2]]);
      else if (open < 3.5) {
        if (rand() > 0.3) continue;
        species = pick([['fern', 0.75], ['bush', 0.25]]);
      } else {
        if (rand() > 0.04) continue;
        species = 'fern';
      }
      // palms ring the base courtyards
      if (plaza < 6 && open > 0 && rand() < 0.5 && L.bases.some((b) => Math.hypot(x - b.plaza.at[0], z - b.plaza.at[1]) < b.plaza.radius + 8)) species = 'palm';
      this.terrain.normalAt(x, z, normal);
      const tree = species === 'canopy' || species === 'slender';
      if (normal.y < (tree ? 0.72 : 0.6)) continue;
      const y = this.terrain.heightAt(x, z);
      if (y > 45) continue;
      const scale = 0.85 + rand() * 0.5;
      const r = this.foliage.radius(species) * scale * (tree ? 2.7 : 1.1);
      if (!spacing.free(x, z, r)) continue;
      spacing.add(x, z, r);
      out.push({ species, x, y: y - 0.05, z, yaw: rand() * Math.PI * 2, scale });
    }
    return out;
  }

  update(dt: number, t: number, camera: THREE.Camera): void {
    for (const f of this.fires) f.update(t);
    for (const s of this.structures.values()) s.update(dt, t);
    for (const { model, collider, ground } of this.cameraBlockers) collider.top = ground + model.solidTop;
    this.foliage.update(camera);
  }
}
