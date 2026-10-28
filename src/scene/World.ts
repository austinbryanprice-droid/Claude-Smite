import * as THREE from 'three/webgpu';
import { Arena } from './ArenaLayout';
import { arenaTerrain } from './ArenaTerrain';
import { CollisionWorld } from './Collision';
import { ConquestMap } from './conquest/ConquestMap';
import { conquestTerrain } from './conquest/ConquestTerrain';
import { DustMotes, type Fire } from './Effects';
import { Environment } from './Environment';
import { Grass } from './Grass';
import { MaterialLibrary, TextureLibrary } from './Materials';
import { Temple } from './Temple';
import { Terrain } from './Terrain';
import type { QualitySettings } from '../render/Quality';

export type MapName = 'arena' | 'conquest';

/** The map picked by the `?map=` URL parameter (the temple arena by default). */
export function mapFromUrl(): MapName {
  return new URLSearchParams(location.search).get('map') === 'conquest' ? 'conquest' : 'arena';
}

/** The static content of one map: architecture, props and foliage. */
export interface MapContent {
  readonly group: THREE.Group;
  /** Braziers and other flickering lights; only the nearest few get real lights. */
  readonly fires: Fire[];
  readonly spawn: { x: number; z: number; yaw: number };
  /** Approximate sunlit ground color, for the environment's lower hemisphere. */
  readonly groundColor: THREE.Color;
  /** Animated scenery that must keep updating its matrices (not frozen like `group`). */
  readonly dynamic?: THREE.Group;
  applyQuality?(q: QualitySettings): void;
  update(dt: number, t: number, camera: THREE.Camera): void;
}

/**
 * The scene graph for one map. Gameplay plugs in through:
 *  - `actors`: add god / minion / jungle camp objects here,
 *  - `vfx`: spell effects, projectiles, decals,
 *  - `collision`: ground height + static obstacles for movement and projectiles,
 *  - `onUpdate`: per-frame callbacks.
 */
export class World {
  readonly scene = new THREE.Scene();
  readonly static = new THREE.Group();
  readonly actors = new THREE.Group();
  readonly vfx = new THREE.Group();
  readonly environment: Environment;
  readonly terrain: Terrain;
  readonly grass: Grass;
  readonly content: MapContent;
  readonly materials: MaterialLibrary;
  readonly collision: CollisionWorld;
  readonly dust: DustMotes;
  private readonly updaters: ((dt: number, t: number) => void)[] = [];

  constructor(textures: TextureLibrary, readonly camera: THREE.PerspectiveCamera, readonly map: MapName = 'arena') {
    this.static.name = 'static';
    this.actors.name = 'actors';
    this.vfx.name = 'vfx';
    this.scene.add(this.static, this.actors, this.vfx);

    this.environment = new Environment(this.scene, camera);
    this.materials = new MaterialLibrary(textures);
    const conquest = map === 'conquest' ? conquestTerrain() : null;
    this.terrain = new Terrain(textures, conquest ?? arenaTerrain());
    this.static.add(this.terrain.mesh);
    this.collision = new CollisionWorld((x, z) => this.terrain.heightAt(x, z));
    if (conquest) {
      this.collision.setWalkable(conquest.walkable);
      this.content = new ConquestMap(this.materials, this.terrain, this.collision, conquest, this.environment.sunDirection);
      this.grass = new Grass(this.terrain, this.environment.sunDirection, conquest.grass);
    } else {
      this.content = new Temple(this.materials, this.terrain, this.collision);
      const plazaR = Arena.plaza.baseRadius + 0.6;
      this.grass = new Grass(this.terrain, this.environment.sunDirection, {
        extent: Arena.valleyRadius + 14,
        round: true,
        density: 1,
        maxHeight: 7,
        reject: (x, z) => Math.hypot(x, z) < plazaR,
      });
    }
    this.static.add(this.content.group, this.grass.group);
    if (this.content.dynamic) this.scene.add(this.content.dynamic);
    this.dust = new DustMotes(600, this.environment.sunDirection);
    this.vfx.add(this.dust.sprite);

    // Static geometry never moves: skip per-frame matrix updates.
    this.static.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    this.static.updateMatrixWorld(true);
  }

  async applyQuality(renderer: THREE.WebGPURenderer, q: QualitySettings): Promise<void> {
    this.environment.applyQuality(renderer, q);
    this.grass.build(q);
    this.content.applyQuality?.(q);
    this.static.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    this.static.updateMatrixWorld(true);
    (this.dust.sprite as any).count = Math.round(600 * q.particles);
    // only the nearest fires get real lights on lower presets
    this.maxLights = q.maxDynamicLights;
  }

  private maxLights = 8;

  bakeLighting(renderer: THREE.WebGPURenderer): void {
    this.environment.bakeEnvironment(renderer, this.content.groundColor);
  }

  onUpdate(fn: (dt: number, t: number) => void): void {
    this.updaters.push(fn);
  }

  update(dt: number, t: number, focus: THREE.Vector3): void {
    this.environment.update();
    this.content.update(dt, t, this.camera);
    this.grass.update(this.camera, focus);
    // enable only the closest N fire lights
    const sorted = this.content.fires
      .map((f) => ({ f, d: f.group.position.distanceToSquared(focus) }))
      .sort((a, b) => a.d - b.d);
    sorted.forEach(({ f }, i) => (f.light.visible = i < this.maxLights));
    for (const u of this.updaters) u(dt, t);
  }

  get spawn() {
    return this.content.spawn;
  }
}
