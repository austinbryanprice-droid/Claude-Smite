import * as THREE from 'three/webgpu';
import {
  attribute, bool, cameraPosition, dFdx, dFdy, dot, float, floor, hash, length, log2, max, mix,
  normalViewGeometry, normalize, positionLocal, positionWorld, pow, screenCoordinate, sin, smoothstep, step, texture,
  time, uniform, uv, vec3,
} from '../render/tsl';
import { rng } from '../core/random';
import type { TextureLibrary } from './Materials';
import { hypot } from '../core/math';

/**
 * Procedural trees, bushes and ferns. Each species is grown on the CPU into a
 * few variant meshes (a bark trunk and leaf cards from the foliage atlas),
 * then drawn as instanced chunks so frustum and shadow culling still work.
 *
 * Leaf cards carry normals pointing out of their cluster, so each canopy
 * shades as one soft volume rather than a scatter of flat planes; this is the
 * usual trick for stylized foliage in UE and Unity games.
 */

export type SpeciesName = 'canopy' | 'slender' | 'palm' | 'bush' | 'fern';

/** Atlas tiles: 0 broadleaf sprig, 1 leaf clump, 2 fern frond, 3 long blades. */
type Tile = 0 | 1 | 2 | 3;

const TILE_OFFSET: Record<Tile, [number, number]> = { 0: [0, 0.5], 1: [0.5, 0.5], 2: [0, 0], 3: [0.5, 0] };

/** Collects vertex streams for one mesh. */
class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  /** 0 at the root, 1 at the swaying tips. */
  readonly sway: number[] = [];
  /** Baked occlusion: darker inside canopies and low down. */
  readonly shade: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, sway: number, shade: number): void {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.sway.push(sway);
    this.shade.push(shade);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setAttribute('shade', new THREE.Float32BufferAttribute(this.shade, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

interface Cluster {
  center: THREE.Vector3;
  radius: number;
}

/**
 * Sweeps a ring along a path (parallel-transport frames) into `b`.
 * `flare(t, theta)` scales the radius, for buttress roots.
 */
function tube(
  b: GeoBuilder, points: THREE.Vector3[], radii: number[], radial: number, swayOf: (p: THREE.Vector3) => number,
  flare?: (t: number, theta: number) => number,
): void {
  const n = points.length;
  const tangents = points.map((_, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const c = points[Math.min(n - 1, i + 1)]!;
    return c.clone().sub(a).normalize();
  });
  let normal = new THREE.Vector3(1, 0, 0);
  if (Math.abs(tangents[0]!.dot(normal)) > 0.9) normal.set(0, 0, 1);
  normal = normal.sub(tangents[0]!.clone().multiplyScalar(normal.dot(tangents[0]!))).normalize();
  const base = b.count;
  const uRepeat = Math.max(1, Math.round((Math.PI * 2 * radii[0]!) / 0.9));
  let along = 0;
  const p = new THREE.Vector3();
  const nv = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = tangents[i]!;
    if (i > 0) {
      along += points[i]!.distanceTo(points[i - 1]!);
      // parallel transport: remove the component along the new tangent
      normal.sub(t.clone().multiplyScalar(normal.dot(t))).normalize();
    }
    const binormal = t.clone().cross(normal).normalize();
    for (let j = 0; j <= radial; j++) {
      const theta = (j / radial) * Math.PI * 2;
      const r = radii[i]! * (flare ? flare(i / (n - 1), theta) : 1);
      nv.copy(normal).multiplyScalar(Math.cos(theta)).addScaledVector(binormal, Math.sin(theta));
      p.copy(points[i]!).addScaledVector(nv, r);
      b.vertex(p, nv, (j / radial) * uRepeat, along / 1.4, swayOf(p), 1);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * row + j;
      b.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
}

/** A curved limb from `start` heading along `dir`, drooping or rising with `gravity`. */
function limb(start: THREE.Vector3, dir: THREE.Vector3, length: number, segments: number, gravity: number, wobble: () => number): THREE.Vector3[] {
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  const p = start.clone();
  const step = length / segments;
  for (let i = 0; i < segments; i++) {
    d.y += gravity / segments;
    d.x += wobble() * 0.15;
    d.z += wobble() * 0.15;
    d.normalize();
    p.addScaledVector(d, step);
    pts.push(p.clone());
  }
  return pts;
}

/** Fills a cluster with leaf cards whose normals point out of the cluster. */
function leafCards(b: GeoBuilder, c: Cluster, count: number, size: number, tiles: Tile[], rand: () => number, swayOf: (p: THREE.Vector3) => number, heightRef: number): void {
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const p = new THREE.Vector3();
  const corner = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    // points biased toward the shell so the silhouette is full
    const dir = new THREE.Vector3(rand() * 2 - 1, rand() * 1.6 - 0.6, rand() * 2 - 1).normalize();
    const r = c.radius * (0.35 + 0.65 * Math.sqrt(rand()));
    p.copy(c.center).addScaledVector(dir, r);
    // card faces mostly outward, with some random tilt
    const face = dir.clone().add(new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(1.4)).normalize();
    u.set(0, 1, 0).cross(face);
    if (u.lengthSq() < 1e-4) u.set(1, 0, 0);
    u.normalize();
    v.copy(face).cross(u).normalize();
    const spin = rand() * Math.PI * 2;
    const cu = u.clone().multiplyScalar(Math.cos(spin)).addScaledVector(v, Math.sin(spin));
    const cv = face.clone().cross(cu).normalize();
    const s = size * (0.75 + rand() * 0.5);
    const tile = tiles[Math.floor(rand() * tiles.length)]!;
    const [ou, ov] = TILE_OFFSET[tile];
    const depth = r / c.radius;
    const base = b.count;
    for (const [a, bb] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      corner.copy(p).addScaledVector(cu, a * s).addScaledVector(cv, bb * s);
      // spherical normal, nudged up so canopies are lit from above
      nrm.copy(corner).sub(c.center).normalize();
      nrm.y += 0.35;
      nrm.normalize();
      const shade = (0.45 + 0.55 * depth) * (0.72 + 0.28 * Math.min(1, corner.y / heightRef));
      b.vertex(corner, nrm, ou + (a + 0.5) * 0.5, ov + (bb + 0.5) * 0.5, swayOf(corner), shade);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Arching fronds: ribbons that leave a point and droop, textured with one atlas tile. */
function fronds(b: GeoBuilder, origin: THREE.Vector3, count: number, length: number, width: number, tile: Tile, rise: number, droop: number, rand: () => number, swayOf: (p: THREE.Vector3) => number): void {
  const [ou, ov] = TILE_OFFSET[tile];
  const SEG = 6;
  for (let k = 0; k < count; k++) {
    const yaw = (k / count) * Math.PI * 2 + rand() * 0.5;
    const out = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const side = new THREE.Vector3(-out.z, 0, out.x);
    const len = length * (0.8 + rand() * 0.4);
    const r0 = rise * (0.7 + rand() * 0.6);
    const base = b.count;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      // parabola: rises, then droops under its own weight
      const c = origin.clone().addScaledVector(out, t * len);
      c.y += (r0 * t - droop * t * t) * len;
      const tangent = out.clone().multiplyScalar(len).add(new THREE.Vector3(0, (r0 - 2 * droop * t) * len, 0)).normalize();
      const n = side.clone().cross(tangent).normalize();
      if (n.y < 0) n.negate();
      n.y += 0.6;
      n.normalize();
      for (const s of [-1, 1]) {
        const p = c.clone().addScaledVector(side, (s * width) / 2);
        // atlas tiles are drawn base-down, so the frond runs along V
        b.vertex(p, n, ou + (s * 0.5 + 0.5) * 0.5, ov + t * 0.5, swayOf(p), 0.7 + 0.3 * t);
      }
    }
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2;
      b.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
}

interface Variant {
  trunk: THREE.BufferGeometry | null;
  leaves: THREE.BufferGeometry;
  /** Distant level of detail: fewer, larger cards and thinner tubes. */
  trunkLo: THREE.BufferGeometry | null;
  leavesLo: THREE.BufferGeometry;
  /** Footprint radius for spacing and collision. */
  radius: number;
}

function grow(species: SpeciesName, seed: number): Variant {
  const hi = growDetail(species, seed, 1);
  const lo = growDetail(species, seed, 0);
  return { trunk: hi.trunk, leaves: hi.leaves, trunkLo: lo.trunk, leavesLo: lo.leaves, radius: hi.radius };
}

/** Grows one level of detail; the shape (branches, clusters) is the same for both. */
function growDetail(species: SpeciesName, seed: number, detail: 0 | 1): { trunk: THREE.BufferGeometry | null; leaves: THREE.BufferGeometry; radius: number } {
  const rand = rng(seed);
  // cards draw from their own stream so both levels share the branch structure
  const cardRand = rng(seed + 7919);
  const nCards = (n: number) => Math.max(3, Math.round(n * (detail ? 1 : 0.3)));
  const cardSize = detail ? 1 : 1.55;
  const ring = (n: number) => (detail ? n : Math.max(4, Math.round(n / 2)));
  const wob = () => rand() * 2 - 1;
  const trunk = new GeoBuilder();
  const leaves = new GeoBuilder();

  if (species === 'canopy' || species === 'slender') {
    const tall = species === 'slender';
    const H = tall ? 13 + rand() * 4 : 9 + rand() * 3.5;
    const R = tall ? 0.3 + rand() * 0.06 : 0.42 + rand() * 0.1;
    const swayOf = (p: THREE.Vector3) => Math.pow(Math.max(0, p.y) / H, 1.6);
    const lean = new THREE.Vector3(wob() * 0.15, 1, wob() * 0.15);
    const stem = limb(new THREE.Vector3(0, -0.4, 0), lean, H + 0.4, 8, 0, () => wob() * 0.25);
    const radii = stem.map((_, i) => R * (1 - (i / (stem.length - 1)) * 0.72));
    const lobes = 4 + Math.floor(rand() * 3);
    const flare = (t: number, theta: number) => 1 + Math.pow(Math.max(0, 1 - t * 7), 2) * (0.9 + 0.7 * Math.max(0, Math.cos(theta * lobes)));
    // trunks are mostly hidden by the crowns from the game camera, so they stay light
    tube(trunk, stem, radii, ring(8), swayOf, flare);
    const clusters: Cluster[] = [];
    const branchN = tall ? 4 : 5 + Math.floor(rand() * 2);
    for (let i = 0; i < branchN; i++) {
      const t = tall ? 0.6 + (i / branchN) * 0.3 : 0.5 + rand() * 0.32;
      const at = stem[Math.round(t * (stem.length - 1))]!;
      const yaw = (i / branchN) * Math.PI * 2 + rand() * 0.8;
      const dir = new THREE.Vector3(Math.cos(yaw), tall ? 0.9 : 0.55 + rand() * 0.4, Math.sin(yaw));
      const len = (tall ? 2 : 3 + rand() * 1.5) * (1.1 - t * 0.4);
      const pts = limb(at, dir, len, 4, 0.25, wob);
      const r0 = R * 0.45 * (1.1 - t * 0.5);
      // far away the crown hides the branches, so the low level keeps only the stem
      if (detail) tube(trunk, pts, pts.map((_, k) => r0 * (1 - (k / (pts.length - 1)) * 0.75)), ring(5), swayOf);
      clusters.push({ center: pts[pts.length - 1]!.clone().add(new THREE.Vector3(0, 0.5, 0)), radius: tall ? 1.8 + rand() * 0.6 : 2.3 + rand() * 0.8 });
    }
    clusters.push({ center: stem[stem.length - 1]!.clone().add(new THREE.Vector3(0, 0.6, 0)), radius: tall ? 2.2 : 2.8 });
    if (tall) clusters.push({ center: stem[Math.round(stem.length * 0.75)]!.clone(), radius: 2.0 });
    for (const c of clusters) {
      leafCards(leaves, c, nCards(c.radius * c.radius * 6.5), (tall ? 1.5 : 1.8) * cardSize, [0, 1, 1], cardRand, swayOf, H);
    }
    return { trunk: trunk.build(), leaves: leaves.build(), radius: R * 1.8 };
  }

  if (species === 'palm') {
    const H = 6.5 + rand() * 3;
    const R = 0.26;
    const swayOf = (p: THREE.Vector3) => Math.pow(Math.max(0, p.y) / H, 1.4);
    const bendDir = new THREE.Vector3(wob(), 0, wob()).normalize();
    const stem: THREE.Vector3[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      stem.push(new THREE.Vector3(0, t * H - 0.3, 0).addScaledVector(bendDir, t * t * H * 0.28));
    }
    // ringed palm trunk: radius pulses every segment
    tube(trunk, stem, stem.map((_, i) => R * (1.25 - (i / 14) * 0.35) * (i % 2 ? 0.94 : 1.04)), ring(10), swayOf,
      (t, theta) => 1 + Math.pow(Math.max(0, 1 - t * 10), 2) * (0.6 + 0.3 * Math.cos(theta * 5)));
    const top = stem[stem.length - 1]!;
    fronds(leaves, top, detail ? 11 : 7, 4.2, 1.1 * (detail ? 1 : 1.3), 2, 0.5, 0.9, cardRand, swayOf);
    leafCards(leaves, { center: top.clone(), radius: 0.6 }, nCards(6), cardSize, [1], cardRand, swayOf, H);
    return { trunk: trunk.build(), leaves: leaves.build(), radius: 0.5 };
  }

  if (species === 'bush') {
    const H = 2.2;
    const swayOf = (p: THREE.Vector3) => Math.min(1, Math.max(0, p.y) / H) * 0.35;
    const n = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const d = i === 0 ? 0 : 0.6 + rand() * 0.6;
      const radius = 0.9 + rand() * 0.6;
      leafCards(leaves, { center: new THREE.Vector3(Math.cos(a) * d, radius * 0.75, Math.sin(a) * d), radius }, nCards(radius * radius * 11), 1.2 * cardSize, [1, 1, 0], cardRand, swayOf, H);
    }
    fronds(leaves, new THREE.Vector3(0, 0, 0), detail ? 6 : 3, 1.4, 0.45, 3, 1.6, 0.9, cardRand, swayOf);
    return { trunk: null, leaves: leaves.build(), radius: 1.4 };
  }

  // fern
  const swayOf = (p: THREE.Vector3) => Math.min(1, Math.max(0, p.y) / 1.2) * 0.5 + 0.1;
  fronds(leaves, new THREE.Vector3(0, 0.05, 0), (9 + Math.floor(rand() * 4)) * (detail ? 1 : 0.5), 1.4 + rand() * 0.5, 0.55, 2, 1.1, 1.0, cardRand, swayOf);
  return { trunk: null, leaves: leaves.build(), radius: 0.9 };
}

const VARIANTS: Record<SpeciesName, number> = { canopy: 3, slender: 2, palm: 2, bush: 2, fern: 2 };

export interface FoliageInstance {
  species: SpeciesName;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

/** The player's position, so foliage between the camera and them can fade out (y below -1000 turns it off). */
export const occlusionFocus = uniform(new THREE.Vector3(0, -1e4, 0));

/** 0..1: how much a fragment sits in the cone from the camera to the player's chest. */
function occlusionFade(): any {
  const target = occlusionFocus.add(vec3(0, 1.2, 0));
  const ab = target.sub(cameraPosition);
  const ap = positionWorld.sub(cameraPosition);
  const along = dot(ap, ab).div(max(dot(ab, ab), float(1e-4)));
  const t = along.clamp(0, 1);
  const d = length(ap.sub(ab.mul(t)));
  const radius = mix(float(0.8), float(2.4), t);
  // fade everything up to and around the player, but not the foliage behind them
  const reach = float(1).add(float(0.9).div(max(length(ab), float(1))));
  return float(1).sub(smoothstep(radius.mul(0.55), radius, d))
    .mul(float(1).sub(smoothstep(float(1), reach, along)))
    .mul(smoothstep(0.02, 0.08, along))
    .mul(step(-1000, occlusionFocus.y));
}

/**
 * False for fragments that hide the player: inside a cone from the camera to
 * the player's chest, foliage is screen-door dithered away (temporal AA turns
 * the stipple into a soft see-through). Shadows are not affected.
 */
function keepUnoccluded(): any {
  const noise = hash(floor(screenCoordinate.x).add(floor(screenCoordinate.y).mul(4093)));
  // keep a sparse stipple so the leaves still hint at where the bush is
  return occlusionFade().mul(0.85).lessThan(noise);
}

/** One instanced mesh of a batch, holding the instances currently in its range. */
interface Part {
  mesh: THREE.InstancedMesh;
  seed: THREE.InstancedBufferAttribute;
  /** Bounding-sphere radius of the geometry around the instance origin, at scale 1. */
  reach: number;
}

/** Every instance of one species variant's trunk or leaves, map-wide. */
interface Batch {
  /**
   * Near instances with the detailed geometry; farther ones, low detail, still
   * casting shadows; and, for species that cast, those beyond the shadow range.
   */
  parts: Part[];
  /** Every instance's matrix and stable seed, in placement order. */
  matrices: Float32Array;
  seeds: Float32Array;
  /** Encloses every instance, for `prime`. */
  bounds: THREE.Sphere;
}

const _box = new THREE.Box3();
const _point = new THREE.Vector3();
// per-part scratch for `split`
const _boxes = [new THREE.Box3(), new THREE.Box3(), new THREE.Box3()];
const _counts = [0, 0, 0];
const _scales = [0, 0, 0];

/** Instanced foliage for one map: per species variant, a near, a far and a beyond-the-shadows mesh. */
export class Foliage {
  readonly group = new THREE.Group();
  private readonly variants = new Map<SpeciesName, Variant[]>();
  private readonly bark: THREE.MeshStandardNodeMaterial;
  private readonly leaves: THREE.MeshStandardNodeMaterial;
  readonly wind = { strength: uniform(1) };
  private batches: Batch[] = [];
  /** Camera position (x, z) at the last split. */
  private readonly splitAt = new THREE.Vector2(NaN, NaN);
  /** Instances farther than this use the low-detail meshes. */
  lodDistance = 40;
  /** Instances farther than this from the camera are hidden (the fog covers the cut). */
  drawDistance = 200;
  /** Shadow range of the current quality; instances well beyond it stop casting. */
  shadowDistance = Infinity;

  /**
   * Instances are sorted into their meshes by distance as the camera moves,
   * rather than drawn as fixed map cells: three generates a shader per
   * instanced mesh per pass, so 356 cell meshes meant hundreds of shaders
   * generated mid-match as cells came into view or into the shadow cascades
   * (a freeze of up to seconds each time). One batch per variant is 54 meshes,
   * all of them drawn, and so prepared, during loading.
   */
  constructor(textures: TextureLibrary, private readonly sunDirection: THREE.Vector3) {
    this.group.name = 'foliage';
    let seed = 900;
    for (const s of Object.keys(VARIANTS) as SpeciesName[]) {
      this.variants.set(s, Array.from({ length: VARIANTS[s] }, () => grow(s, seed++)));
    }
    this.bark = this.buildBark(textures);
    this.leaves = this.buildLeaves(textures);
  }

  /** Footprint radius of a species, for spacing. */
  radius(species: SpeciesName): number {
    return Math.max(...this.variants.get(species)!.map((v) => v.radius));
  }

  /** Wind sway shared by trunks and leaves: bends with height, phase per instance. */
  private swayNode(extraFlutter: boolean): any {
    const s = attribute('sway', 'float');
    const phase = hash(attribute('seed', 'float')).mul(6.283);
    const t = time.mul(1.1).add(phase);
    const k = this.wind.strength.mul(s);
    let offset = vec3(sin(t).mul(0.22), 0, sin(t.mul(0.83).add(1.7)).mul(0.16)).mul(k);
    if (extraFlutter) {
      const f = sin(time.mul(5.3).add(positionLocal.x.mul(2.1)).add(positionLocal.z.mul(1.7)).add(phase)).mul(0.035);
      offset = offset.add(vec3(f, f.mul(0.6), f.negate())).mul(1);
    }
    return positionLocal.add(offset);
  }

  private buildBark(textures: TextureLibrary): THREE.MeshStandardNodeMaterial {
    const set = textures.get('bark');
    const mat = new THREE.MeshStandardNodeMaterial();
    const c = texture(set.albedo, uv());
    const nr = texture(set.nr, uv());
    mat.positionNode = this.swayNode(false);
    mat.colorNode = c.rgb.mul(mix(vec3(0.9, 0.86, 0.8), vec3(1.08, 1.0, 0.92), hash(attribute('seed', 'float').add(7))));
    mat.roughnessNode = nr.z;
    mat.metalnessNode = float(0);
    mat.maskNode = keepUnoccluded();
    mat.maskShadowNode = bool(true);
    mat.name = 'bark';
    return mat;
  }

  private buildLeaves(textures: TextureLibrary): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    const tex = texture(textures.foliage, uv());
    // Keep alpha-tested cards from thinning out in the distance: scale alpha
    // up with the mip level (Ben Golus's coverage fix).
    const texel = uv().mul(1024);
    const d = max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)));
    const mip = max(float(0), log2(d).mul(0.5));
    mat.opacityNode = tex.a.mul(float(1).add(mip.mul(0.3)));
    // As a node, not `alphaTest`: shadow passes copy `alphaTest` onto their
    // shared material, and every flip between 0 and non-zero bumps its version,
    // which made every shadow draw rebuild its material key, every frame.
    // (Shadows never used it: leaf cards cast with alpha 1 either way.)
    mat.alphaTestNode = float(0.5);
    mat.positionNode = this.swayNode(true);

    // Per-instance hue shift between yellow-green and blue-green.
    // (a stable seed, not instanceIndex: instances move between the near and far meshes)
    const seed = attribute('seed', 'float');
    const tint = mix(mix(vec3(1.0, 1.02, 0.6), vec3(0.82, 1.0, 0.84), smoothish(hash(seed))), vec3(0.7, 0.95, 1.0), smoothish(hash(seed.add(3))).mul(0.5));
    const shade = attribute('shade', 'float');
    // deep, cool greens with dark crown interiors, as in the reference jungle
    const col = tex.rgb.mul(tint).mul(0.88);
    mat.colorNode = col;
    mat.aoNode = shade.mul(shade);
    // Normals come from the cluster shape and must not flip on back faces.
    mat.normalNode = normalViewGeometry;
    mat.roughnessNode = float(0.62);
    mat.metalnessNode = float(0);
    // Fake subsurface: leaves glow when the sun is behind them.
    const viewDir = normalize(positionWorld.sub(cameraPosition));
    const sun = uniform(this.sunDirection);
    const back = pow(max(dot(viewDir, sun), float(0)), float(4)).mul(0.3).add(0.03);
    mat.emissiveNode = col.mul(vec3(1.0, 0.92, 0.55)).mul(back).mul(shade);
    mat.maskNode = keepUnoccluded();
    mat.maskShadowNode = bool(true);
    mat.name = 'leaves';
    return mat;

    function smoothish(x: any): any {
      return x.mul(x).mul(float(3).sub(x.mul(2)));
    }
  }

  update(camera: THREE.Camera): void {
    const p = camera.position;
    // re-sorting every instance is cheap, but re-uploads every matrix: do it every few meters
    if (hypot(p.x - this.splitAt.x, p.z - this.splitAt.y) <= 3) return;
    this.splitAt.set(p.x, p.z);
    for (const b of this.batches) this.split(b, p);
  }

  /**
   * Shows every mesh, each with at least one instance, until the next `update`,
   * so that drawing the loading frame prepares all of their shaders.
   */
  prime(): void {
    for (const b of this.batches) {
      for (const part of b.parts) {
        if (part.mesh.count > 0) continue;
        part.mesh.instanceMatrix.array.set(b.matrices.subarray(0, 16));
        part.seed.array[0] = b.seeds[0]!;
        part.mesh.instanceMatrix.needsUpdate = part.seed.needsUpdate = true;
        part.mesh.count = 1;
        part.mesh.visible = true;
        part.mesh.boundingSphere = b.bounds.clone();
      }
    }
    this.splitAt.set(NaN, NaN);
  }

  /** Sorts a batch's instances into its near, far and beyond-the-shadows meshes. */
  private split(b: Batch, cam: THREE.Vector3): void {
    const lod2 = this.lodDistance ** 2;
    // long evening shadows still reach the shadowed area from a little beyond it
    const shadow2 = (this.shadowDistance + 30) ** 2;
    const draw2 = this.drawDistance ** 2;
    const parts = b.parts;
    const beyond = parts.length > 2;
    const counts = _counts.fill(0);
    const scales = _scales.fill(0);
    const boxes = _boxes;
    for (const box of boxes) box.makeEmpty();
    const src = b.matrices;
    for (let i = 0; i < b.seeds.length; i++) {
      const o = i * 16;
      const x = src[o + 12]! - cam.x;
      const z = src[o + 14]! - cam.z;
      const d2 = x * x + z * z;
      if (d2 >= draw2) continue;
      const k = d2 < lod2 ? 0 : !beyond || d2 < shadow2 ? 1 : 2;
      const part = parts[k]!;
      // copied by hand: a subarray per instance is garbage on every re-split
      const dst = part.mesh.instanceMatrix.array as Float32Array;
      const at = counts[k]! * 16;
      for (let j = 0; j < 16; j++) dst[at + j] = src[o + j]!;
      (part.seed.array as Float32Array)[counts[k]!++] = b.seeds[i]!;
      boxes[k]!.expandByPoint(_point.set(src[o + 12]!, src[o + 13]!, src[o + 14]!));
      scales[k] = Math.max(scales[k]!, Math.sqrt(src[o]! ** 2 + src[o + 1]! ** 2 + src[o + 2]! ** 2));
    }
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]!;
      const n = counts[k]!;
      const mesh = part.mesh;
      mesh.count = n;
      mesh.visible = n > 0;
      if (n === 0) continue;
      // only the instances in use go to the GPU
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      part.seed.clearUpdateRanges();
      part.seed.addUpdateRange(0, n);
      part.seed.needsUpdate = true;
      const sphere = (mesh.boundingSphere ??= new THREE.Sphere());
      boxes[k]!.getBoundingSphere(sphere);
      sphere.radius += part.reach * scales[k]!;
    }
  }

  /** Replaces all instances. Call once after placement (or on quality change). */
  setInstances(list: FoliageInstance[]): void {
    for (const c of [...this.group.children]) this.group.remove(c);
    this.batches = [];
    this.splitAt.set(NaN, NaN);
    const buckets = new Map<string, { variant: Variant; items: FoliageInstance[] }>();
    for (const it of list) {
      const vs = this.variants.get(it.species)!;
      const vi = Math.floor(Math.abs(Math.sin(it.x * 12.9898 + it.z * 78.233) * 43758.5453) % 1 * vs.length);
      const key = `${it.species}:${vi}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { variant: vs[vi]!, items: [] }));
      b.items.push(it);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let seed = 0;
    for (const [key, { variant, items }] of buckets) {
      const species = key.split(':')[0] as SpeciesName;
      // ferns are too low and small to read in the shadow maps
      const castShadow = species !== 'fern';
      const matrices = new Float32Array(items.length * 16);
      const seeds = new Float32Array(items.length);
      _box.makeEmpty();
      let maxScale = 0;
      items.forEach((it, i) => {
        q.setFromAxisAngle(up, it.yaw);
        m.compose(p.set(it.x, it.y, it.z), q, s.setScalar(it.scale));
        m.toArray(matrices, i * 16);
        seeds[i] = seed++;
        _box.expandByPoint(p);
        maxScale = Math.max(maxScale, it.scale);
      });
      const make = (geo: THREE.BufferGeometry, lo: THREE.BufferGeometry, mat: THREE.Material) => {
        const part = (source: THREE.BufferGeometry, name: string, cast: boolean): Part => {
          // shares the vertex buffers; only the seed attribute is per mesh
          const g = new THREE.BufferGeometry();
          g.setIndex(source.index);
          for (const [attr, value] of Object.entries(source.attributes)) g.setAttribute(attr, value);
          g.boundingSphere = source.boundingSphere;
          g.boundingBox = source.boundingBox;
          const seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(items.length), 1);
          seedAttr.setUsage(THREE.DynamicDrawUsage);
          g.setAttribute('seed', seedAttr);
          const mesh = new THREE.InstancedMesh(g, mat, items.length);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.count = 0;
          mesh.visible = false;
          mesh.castShadow = cast;
          mesh.receiveShadow = true;
          mesh.name = `${key}:${name}`;
          this.group.add(mesh);
          const sphere = source.boundingSphere!;
          return { mesh, seed: seedAttr, reach: sphere.center.length() + sphere.radius };
        };
        const bounds = _box.getBoundingSphere(new THREE.Sphere());
        const parts = [part(geo, 'hi', castShadow), part(lo, 'lo', castShadow)];
        if (castShadow) parts.push(part(lo, 'far', false));
        bounds.radius += parts[0]!.reach * maxScale;
        this.batches.push({ parts, matrices, seeds, bounds });
      };
      if (variant.trunk) make(variant.trunk, variant.trunkLo!, this.bark);
      make(variant.leaves, variant.leavesLo, this.leaves);
    }
  }
}
