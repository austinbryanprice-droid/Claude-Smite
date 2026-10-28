import * as THREE from 'three/webgpu';
import { Arena } from './ArenaLayout';
import { CollisionWorld } from './Collision';
import { DustMotes } from './Effects';
import { Environment } from './Environment';
import { Grass } from './Grass';
import { MaterialLibrary, TextureLibrary } from './Materials';
import { Temple } from './Temple';
import { Terrain } from './Terrain';
import type { QualitySettings } from '../render/Quality';

/**
 * The arena scene graph. Gameplay plugs in through:
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
  readonly temple: Temple;
  readonly materials: MaterialLibrary;
  readonly collision: CollisionWorld;
  readonly dust: DustMotes;
  private readonly updaters: ((dt: number, t: number) => void)[] = [];

  constructor(textures: TextureLibrary, readonly camera: THREE.PerspectiveCamera) {
    this.static.name = 'static';
    this.actors.name = 'actors';
    this.vfx.name = 'vfx';
    this.scene.add(this.static, this.actors, this.vfx);

    this.environment = new Environment(this.scene, camera);
    this.materials = new MaterialLibrary(textures);
    this.terrain = new Terrain(textures);
    this.static.add(this.terrain.mesh);
    this.collision = new CollisionWorld((x, z) => this.terrain.heightAt(x, z));
    this.temple = new Temple(this.materials, this.terrain, this.collision);
    this.static.add(this.temple.group);
    this.grass = new Grass(this.terrain, this.environment.sunDirection);
    this.static.add(this.grass.group);
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
    this.grass.group.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    this.grass.group.updateMatrixWorld(true);
    (this.dust.sprite as any).count = Math.round(600 * q.particles);
    // only the nearest fires get real lights on lower presets
    this.maxLights = q.maxDynamicLights;
  }

  private maxLights = 8;

  bakeLighting(renderer: THREE.WebGPURenderer): void {
    // Approximate average sunlit ground radiance for the environment's lower hemisphere.
    this.environment.bakeEnvironment(renderer, new THREE.Color(0.16, 0.17, 0.09));
  }

  onUpdate(fn: (dt: number, t: number) => void): void {
    this.updaters.push(fn);
  }

  update(dt: number, t: number, focus: THREE.Vector3): void {
    this.environment.update();
    this.temple.update(t);
    this.grass.update(this.camera, focus);
    // enable only the closest N fire lights
    const fires = this.temple.fires;
    const sorted = fires
      .map((f) => ({ f, d: f.group.position.distanceToSquared(focus) }))
      .sort((a, b) => a.d - b.d);
    sorted.forEach(({ f }, i) => (f.light.visible = i < this.maxLights));
    for (const u of this.updaters) u(dt, t);
  }

  get spawn() {
    return Arena.spawn;
  }
}
