import * as THREE from 'three/webgpu';
import {
  abs, float, normalWorld, positionWorld, sqrt, texture, transformNormalToView, uniform, vec3,
} from '../render/tsl';

/** Names of the generated PBR sets in public/textures/pbr (see tools/textures/gen.py). */
export type PbrName = 'flagstone' | 'marble' | 'sandstone_blocks' | 'rock' | 'grass_ground' | 'dirt' | 'bark';

export interface PbrSet {
  /** sRGB base color with baked cavity occlusion. */
  albedo: THREE.Texture;
  /** R,G = tangent normal XY, B = roughness. */
  nr: THREE.Texture;
}

const ALL: PbrName[] = ['flagstone', 'marble', 'sandstone_blocks', 'rock', 'grass_ground', 'dirt', 'bark'];

/**
 * Loads and caches texture sets. Call `load()` once at startup; afterwards
 * `get()` is synchronous so scene builders don't have to await.
 */
export class TextureLibrary {
  private readonly sets = new Map<PbrName, PbrSet>();
  private readonly loader = new THREE.TextureLoader();
  /** 2x2 atlas of leaf sprigs with alpha (see `foliage_atlas` in gen.py). */
  foliage!: THREE.Texture;

  constructor(private readonly anisotropy: number) {}

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    let done = 0;
    const total = ALL.length * 2 + 1;
    const tick = () => onProgress?.(++done / total);
    const foliage = this.loader.loadAsync(`${import.meta.env.BASE_URL}textures/pbr/foliage_atlas.png`).then((t) => {
      tick();
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = this.anisotropy;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      this.foliage = t;
    });
    await Promise.all(ALL.map(async (name) => {
      const base = `${import.meta.env.BASE_URL}textures/pbr/${name}`;
      const [albedo, nr] = await Promise.all([
        this.loader.loadAsync(`${base}_albedo.jpg`).then((t) => (tick(), t)),
        this.loader.loadAsync(`${base}_nr.jpg`).then((t) => (tick(), t)),
      ]);
      albedo.colorSpace = THREE.SRGBColorSpace;
      for (const t of [albedo, nr]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = this.anisotropy;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
      }
      this.sets.set(name, { albedo, nr });
    }));
    await foliage;
  }

  get(name: PbrName): PbrSet {
    const s = this.sets.get(name);
    if (!s) throw new Error(`Texture set ${name} not loaded`);
    return s;
  }
}

export interface SurfaceNodes {
  color: any;
  /** World-space shading normal. */
  normal: any;
  roughness: any;
  ao: any;
}

/**
 * Triplanar projection of a PBR set in world space, with whiteout normal
 * blending. Lets procedural architecture and cliffs be textured with no UVs
 * and constant texel density (the same trick UE uses for world-aligned materials).
 */
export function triplanar(set: PbrSet, scale: any, sharpness = 4, positionNode: any = positionWorld, normalNode: any = normalWorld): SurfaceNodes {
  const p = positionNode.mul(scale);
  const n = normalNode.normalize();
  const w0 = abs(n).pow(float(sharpness));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const uvX = p.zy;
  const uvY = p.xz;
  const uvZ = p.xy;

  const cx = texture(set.albedo, uvX);
  const cy = texture(set.albedo, uvY);
  const cz = texture(set.albedo, uvZ);
  const nx = texture(set.nr, uvX);
  const ny = texture(set.nr, uvY);
  const nz = texture(set.nr, uvZ);

  const color = cx.rgb.mul(w.x).add(cy.rgb.mul(w.y)).add(cz.rgb.mul(w.z));
  const rough = nx.z.mul(w.x).add(ny.z.mul(w.y)).add(nz.z.mul(w.z));

  const tnx = unpackNormal(nx);
  const tny = unpackNormal(ny);
  const tnz = unpackNormal(nz);
  const bx = vec3(tnx.xy.add(n.zy), abs(tnx.z).mul(n.x));
  const by = vec3(tny.xy.add(n.xz), abs(tny.z).mul(n.y));
  const bz = vec3(tnz.xy.add(n.xy), abs(tnz.z).mul(n.z));
  const normal = bx.zyx.mul(w.x).add(by.xzy.mul(w.y)).add(bz.xyz.mul(w.z)).normalize();

  return { color, normal, roughness: rough, ao: float(1) };
}

/** Tangent normal from the RG channels, rebuilding Z. */
function unpackNormal(sampleNode: any): any {
  const xy = sampleNode.xy.mul(2).sub(1);
  return vec3(xy, sqrt(float(1).sub(xy.dot(xy)).max(0)));
}

/**
 * Planar (top-down) projection for ground layers. Returns a world-space normal
 * built with UDN blending against the geometry normal.
 */
export function planar(set: PbrSet, uvNode: any, geomNormal: any = normalWorld): SurfaceNodes {
  const c = texture(set.albedo, uvNode);
  const nr = texture(set.nr, uvNode);
  const t = unpackNormal(nr);
  const n = geomNormal.normalize();
  const normal = vec3(t.x.add(n.x), n.y, t.y.add(n.z)).normalize();
  return { color: c.rgb, normal, roughness: nr.z, ao: float(1) };
}

export function applySurface(mat: THREE.MeshStandardNodeMaterial, s: SurfaceNodes, opts: { tint?: any; roughnessMul?: any; aoStrength?: number } = {}): void {
  mat.colorNode = opts.tint ? s.color.mul(opts.tint) : s.color;
  mat.normalNode = transformNormalToView(s.normal);
  mat.roughnessNode = opts.roughnessMul ? s.roughness.mul(opts.roughnessMul) : s.roughness;
  const k = opts.aoStrength ?? 1;
  mat.aoNode = k === 1 ? s.ao : float(1).sub(float(1).sub(s.ao).mul(k));
  mat.metalnessNode = float(0);
}

/** Library of shared materials used by the architecture. */
export class MaterialLibrary {
  readonly marble: THREE.MeshStandardNodeMaterial;
  readonly sandstone: THREE.MeshStandardNodeMaterial;
  readonly flagstone: THREE.MeshStandardNodeMaterial;
  readonly rock: THREE.MeshStandardNodeMaterial;
  readonly bronze: THREE.MeshStandardNodeMaterial;
  readonly gold: THREE.MeshStandardNodeMaterial;
  /** Global wetness/darkening knob for weather later. */
  readonly grime = uniform(1);

  constructor(readonly textures: TextureLibrary) {
    this.marble = this.make('marble', 0.42, { tint: vec3(1.0, 0.985, 0.96) });
    this.sandstone = this.make('sandstone_blocks', 0.25);
    this.flagstone = this.make('flagstone', 0.2);
    this.rock = this.make('rock', 0.11, { aoStrength: 1.2 });
    this.bronze = this.metal(new THREE.Color(0x8c5a32), 0.38, true);
    this.gold = this.metal(new THREE.Color(0xd9a441), 0.26, false);
  }

  private make(name: PbrName, scale: number, opts: { tint?: any; aoStrength?: number } = {}): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial();
    applySurface(mat, triplanar(this.textures.get(name), scale), opts);
    mat.name = name;
    return mat;
  }

  /** Metals reuse the rock texture's detail as a subtle wear/patina mask. */
  private metal(base: THREE.Color, roughness: number, patina: boolean): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial();
    const s = triplanar(this.textures.get('rock'), 0.9);
    const wear = s.color.r.mul(2.2).clamp(0, 1);
    const baseCol = vec3(base.r, base.g, base.b);
    let col: any = baseCol.mul(wear.mul(0.35).add(0.75));
    const patinaMask = float(1).sub(s.color.r.mul(4)).clamp(0, 0.6);
    if (patina) col = col.mix(vec3(0.16, 0.36, 0.3), patinaMask);
    mat.colorNode = col;
    mat.metalnessNode = patina ? float(1).sub(patinaMask) : float(1);
    mat.roughnessNode = float(roughness).add(s.roughness.sub(0.8).mul(0.4));
    mat.normalNode = transformNormalToView(s.normal.mix(normalWorld, 0.6).normalize());
    return mat;
  }
}
