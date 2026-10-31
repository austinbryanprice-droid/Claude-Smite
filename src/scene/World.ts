import * as THREE from 'three/webgpu';
import { Arena } from './ArenaLayout';
import { arenaTerrain } from './ArenaTerrain';
import { CollisionWorld } from './Collision';
import { ConquestMap } from './conquest/ConquestMap';
import { conquestTerrain } from './conquest/ConquestTerrain';
import { DustMotes, FireBatch, type Fire } from './Effects';
import { Environment } from './Environment';
import { occlusionFocus } from './Foliage';
import { Grass } from './Grass';
import { MaterialLibrary, TextureLibrary } from './Materials';
import { Temple } from './Temple';
import { Terrain } from './Terrain';
import type { QualitySettings } from '../render/Quality';
import { hypot } from '../core/math';
import { slice } from '../core/slices';

export type MapName = 'arena' | 'conquest';

/** The map picked by the `?map=` URL parameter (the temple arena by default). */
export function mapFromUrl(): MapName {
  return new URLSearchParams(location.search).get('map') === 'conquest' ? 'conquest' : 'arena';
}

/** Number of point lights reserved for spells. Fixed so the light count never changes (which would recompile shaders). */
export const SPELL_LIGHTS = 4;

/** The static content of one map: architecture, props and foliage. */
export interface MapContent {
  readonly group: THREE.Group;
  /** Braziers and other flickering lights; only the nearest few get real lights. */
  readonly fires: Fire[];
  /** All flickering point lights, if more than the fires'; only the nearest few are switched on. */
  readonly lights?: THREE.PointLight[];
  readonly spawn: { x: number; z: number; yaw: number };
  /** Approximate sunlit ground color, for the environment's lower hemisphere. */
  readonly groundColor: THREE.Color;
  /** Animated scenery that must keep updating its matrices (not frozen like `group`). */
  readonly dynamic?: THREE.Group;
  applyQuality?(q: QualitySettings): void;
  update(dt: number, t: number, camera: THREE.Camera): void;
  /** Until the next `update`, shows the meshes that stay empty until the camera comes near. */
  prime?(): void;
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
  // set by `create`, which builds them in slices
  terrain!: Terrain;
  grass!: Grass;
  content!: MapContent;
  readonly materials: MaterialLibrary;
  collision!: CollisionWorld;
  dust!: DustMotes;
  /** The flames and embers of every fire on the map, drawn together. */
  private readonly fireBatch = new FireBatch();
  /**
   * Point lights the combat effects move onto the brightest spells each frame.
   * They belong to the map, not the match, so the shaders prepared while
   * loading (even behind the title screen, before the match exists) are built
   * for these very lights: three keys a lit shader on the exact light objects.
   */
  readonly spellLights: THREE.PointLight[] = [];
  private readonly updaters: ((dt: number, t: number) => void)[] = [];

  private constructor(textures: TextureLibrary, readonly camera: THREE.PerspectiveCamera, readonly map: MapName) {
    this.static.name = 'static';
    this.actors.name = 'actors';
    this.vfx.name = 'vfx';
    this.scene.add(this.static, this.actors, this.vfx);

    this.environment = new Environment(this.scene, camera);
    this.materials = new MaterialLibrary(textures);
  }

  /**
   * Builds the map a little at a time (see `slice`): it takes seconds on a
   * slow laptop, behind a title screen that should keep playing meanwhile.
   */
  static async create(textures: TextureLibrary, camera: THREE.PerspectiveCamera, map: MapName = 'arena'): Promise<World> {
    const w = new World(textures, camera, map);
    const conquest = map === 'conquest' ? await conquestTerrain() : null;
    w.terrain = await Terrain.create(textures, conquest ?? arenaTerrain());
    w.static.add(w.terrain.root);
    w.collision = new CollisionWorld((x, z) => w.terrain.heightAt(x, z));
    if (conquest) {
      w.collision.setWalkable(conquest.walkable);
      w.content = await ConquestMap.create(w.materials, w.terrain, w.collision, conquest, w.environment.sunDirection);
      w.grass = new Grass(w.terrain, w.environment.sunDirection, conquest.grass);
    } else {
      w.content = await Temple.create(w.materials, w.terrain, w.collision);
      const plazaR = Arena.plaza.baseRadius + 0.6;
      w.grass = new Grass(w.terrain, w.environment.sunDirection, {
        extent: Arena.valleyRadius + 14,
        round: true,
        density: 1,
        maxHeight: 7,
        reject: (x, z) => hypot(x, z) < plazaR,
      });
    }
    await slice();
    w.static.add(w.content.group, w.grass.group);
    if (w.content.dynamic) w.scene.add(w.content.dynamic);
    w.dust = new DustMotes(600, w.environment.sunDirection);
    w.vfx.add(w.dust.sprite, w.fireBatch.group);
    for (let i = 0; i < SPELL_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 14, 2);
      l.castShadow = false;
      w.spellLights.push(l);
      w.vfx.add(l);
    }

    // Static geometry never moves: skip per-frame matrix updates.
    w.static.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    w.static.updateMatrixWorld(true);
    w.fireBatch.update();
    return w;
  }

  async applyQuality(renderer: THREE.WebGPURenderer, q: QualitySettings): Promise<void> {
    this.environment.applyQuality(renderer, q);
    await this.grass.build(q);
    this.content.applyQuality?.(q);
    this.static.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    this.static.updateMatrixWorld(true);
    (this.dust.sprite as any).count = Math.round(600 * q.particles);
    // only the nearest fires get real lights on lower presets
    this.setLightPool(q.maxDynamicLights);
  }

  /**
   * The real point lights, a fixed set that moves to the nearest fires each
   * frame. Shaders are built for one exact set of lights, so switching which
   * fires are lit as the player walks would rebuild every material's shader.
   */
  private readonly pool: THREE.PointLight[] = [];
  /** Reused every frame: one entry per map light that is on. */
  private readonly spots: LightSpot[] = [];
  private readonly near: LightSpot[] = [];
  private fireLights: THREE.PointLight[] | null = null;

  private setLightPool(n: number): void {
    while (this.pool.length > n) this.pool.pop()!.removeFromParent();
    while (this.pool.length < n) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      this.pool.push(l);
      this.scene.add(l);
    }
  }

  /**
   * Makes frames draw everything on the map, in view or not, so that drawing
   * them prepares every shader (with `environment.redrawShadows` each frame for
   * the shadow cascades); the returned function restores normal culling. three
   * generates an object's shader the first time it is drawn in each pass, and
   * doing that mid-match froze the frame.
   */
  showEverything(): () => void {
    this.content.prime?.();
    const culled: THREE.Object3D[] = [];
    // hidden parts marked `userData.shownLater` (structure shields) are shown too
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.userData.shownLater && !o.visible) {
        o.visible = true;
        hidden.push(o);
      }
      if (!o.frustumCulled) return;
      o.frustumCulled = false;
      culled.push(o);
    });
    return () => {
      for (const o of culled) o.frustumCulled = true;
      for (const o of hidden) o.visible = false;
    };
  }

  bakeLighting(renderer: THREE.WebGPURenderer): void {
    this.environment.bakeEnvironment(renderer, this.content.groundColor);
  }

  onUpdate(fn: (dt: number, t: number) => void): void {
    this.updaters.push(fn);
  }

  update(dt: number, t: number, focus: THREE.Vector3): void {
    occlusionFocus.value.copy(focus);
    this.environment.update();
    this.content.update(dt, t, this.camera);
    this.fireBatch.update();
    this.grass.update(this.camera, focus);
    // the map's own lights only say where the light is; the pool does the lighting
    const near = this.near;
    near.length = 0;
    for (const l of this.content.lights ?? (this.fireLights ??= this.content.fires.map((f) => f.light))) {
      l.visible = false;
      if (l.intensity <= 0 || !shown(l.parent)) continue;
      const s = (this.spots[near.length] ??= { l, p: new THREE.Vector3(), d: 0 });
      s.l = l;
      s.d = l.getWorldPosition(s.p).distanceToSquared(focus);
      near.push(s);
    }
    near.sort(closest);
    for (let i = 0; i < this.pool.length; i++) {
      const light = this.pool[i]!;
      const s = near[i];
      light.intensity = s ? s.l.intensity : 0;
      if (!s) continue;
      light.position.copy(s.p);
      light.color.copy(s.l.color);
      light.distance = s.l.distance;
      light.decay = s.l.decay;
    }
    for (const u of this.updaters) u(dt, t);
  }

  get spawn() {
    return this.content.spawn;
  }
}

interface LightSpot {
  l: THREE.PointLight;
  p: THREE.Vector3;
  /** Squared distance to the focus. */
  d: number;
}

const closest = (a: LightSpot, b: LightSpot) => a.d - b.d;

/** True when the object and all its ancestors are visible. */
function shown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
