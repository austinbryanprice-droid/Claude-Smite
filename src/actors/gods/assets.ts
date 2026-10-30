import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeSkinned } from '../../scene/merge';

/** Gods with a built model in public/models/gods (see tools/gods/build.py). */
export const GOD_IDS = ['zeus', 'thor', 'odin', 'loki', 'anubis'] as const;
export type GodId = (typeof GOD_IDS)[number];

export interface GodAsset {
  id: GodId;
  scene: THREE.Group;
  /** Clips retargeted for this god (hips translation scaled to its size). */
  clips: Map<string, THREE.AnimationClip>;
  meta: GodMeta;
}

/** Per-god data the build script stores in the GLB (`extras` on the root node). */
export interface GodMeta {
  hipsScale: number;
  height: number;
  /** Hands that close around a held weapon ('L', 'R'). */
  grip?: string[];
  /** Finger rotations applied on top of every clip to close the gripping hand: bone-local axis, radians. */
  curl?: { bone: string; axis: number[]; angle: number }[];
  /** Simulated cloth and hair sheets (see Physics.ts). */
  cloths?: ClothSpec[];
  /** Capsules the sheets collide with: two points in model (bind) space on one bone. */
  colliders?: { bone: string; a: number[]; b: number[]; r: number }[];
}

export interface ClothSpec {
  name: string;
  material: string;
  rows: number;
  cols: number;
  /** rows * cols rest points in model (bind) space, row-major, row 0 at the pinned edge. */
  points: number[][];
  uvs?: number[][];
  /** Bones the particles follow, and each particle's index into `drive`. */
  drive: string[];
  driveIndex: number[];
  /** Per particle: 1 = pinned, else how strongly it is pulled back to its animated rest point. */
  stiffness: number[];
  gravity?: number;
  damping?: number;
}

const assets = new Map<GodId, GodAsset>();
let loading: Promise<void> | null = null;

/** Loads every god model and the shared clips once. Await before creating god models. */
export function preloadGodAssets(onProgress?: (fraction: number) => void): Promise<void> {
  loading ??= (async () => {
    const loader = new GLTFLoader();
    const base = `${import.meta.env.BASE_URL}models/gods/`;
    let done = 0;
    const tick = () => onProgress?.(++done / (GOD_IDS.length + 1));
    const clipsGltf = await loader.loadAsync(`${base}clips.glb`);
    tick();
    await Promise.all(GOD_IDS.map(async (id) => {
      let gltf;
      try {
        gltf = await loader.loadAsync(`${base}${id}.glb`);
      } catch {
        // not built yet: fall back to Zeus's body
        gltf = null;
      }
      tick();
      if (!gltf) return;
      widenVertexFormats(gltf.scene);
      // one draw per material instead of one per armor piece
      mergeSkinned(gltf.scene);
      const root = gltf.scene.getObjectByName('god') ?? gltf.scene;
      const meta = root.userData as GodMeta;
      const clips = new Map<string, THREE.AnimationClip>();
      for (const c of clipsGltf.animations) {
        const clip = c.clone();
        for (const t of clip.tracks) {
          if (t.name.endsWith('.position')) {
            // clone() shares the value array between clips, so replace it
            t.values = Float32Array.from(t.values, (x) => x * meta.hipsScale);
          }
        }
        clips.set(clip.name, clip);
      }
      assets.set(id, { id, scene: gltf.scene, clips, meta });
    }));
  })();
  return loading;
}

/**
 * WebGPU has no one- or three-component 8/16-bit vertex formats (three.js
 * throws "Vertex format not supported yet" and nothing draws), so attributes
 * like the baked `_ao` (normalized uint8 scalar) become plain floats.
 */
function widenVertexFormats(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!geo) return;
    for (const [name, attr] of Object.entries(geo.attributes)) {
      if (!(attr instanceof THREE.BufferAttribute) || attr.array instanceof Float32Array) continue;
      if (attr.itemSize !== 1 && attr.itemSize !== 3) continue;
      const out = new Float32Array(attr.count * attr.itemSize);
      for (let i = 0; i < attr.count; i++) {
        for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
      }
      geo.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
    }
  });
}

export function godAsset(id: string): GodAsset {
  const a = assets.get(id as GodId) ?? assets.get('zeus');
  if (!a) throw new Error('God models not loaded: await preloadGodAssets() first');
  return a;
}
