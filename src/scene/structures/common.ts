import * as THREE from 'three/webgpu';
import {
  abs, color, dot, float, fract, mix, mx_noise_float, normalView, normalize, positionLocal, positionView, positionWorld,
  pow, sin, smoothstep, step, time, uv, vec3,
} from '../../render/tsl';
import { objectUniforms, useUniforms } from '../../render/shared';
import { rng } from '../../core/random';
import type { Team } from '../../map/ConquestLayout';
import { boulder, chippedBlock } from '../Architecture';
import type { MaterialLibrary } from '../Materials';

/** Team colors: Order is blue and gold, Chaos crimson and black. */
export interface TeamStyle {
  team: Team;
  /** Banner and cloth color. */
  cloth: number;
  /** Emissive glow for crystals, runes and shields. */
  glow: number;
  /** Fire palette for braziers and the Phoenix. */
  fire: { low: number; high: number; ember: number; light: number };
}

export const TEAM_STYLE: Record<Team, TeamStyle> = {
  order: {
    team: 'order',
    cloth: 0x1f4fb8,
    glow: 0x4fb2ff,
    fire: { low: 0x1446ff, high: 0xc8ecff, ember: 0x7cc4ff, light: 0x6fb6ff },
  },
  chaos: {
    team: 'chaos',
    cloth: 0x8e1016,
    glow: 0xff3524,
    fire: { low: 0xff2208, high: 0xffa060, ember: 0xff4a1a, light: 0xff4a2a },
  },
};

/** Per-team materials shared by every structure of that team. */
export class TeamMaterials {
  /** Trim metal: gold for Order, blackened iron with a red sheen for Chaos. */
  readonly trim: THREE.MeshStandardNodeMaterial;
  readonly banner: THREE.MeshStandardNodeMaterial;
  readonly crystal: THREE.MeshBasicNodeMaterial;
  readonly runes: THREE.MeshBasicNodeMaterial;

  constructor(lib: MaterialLibrary, readonly style: TeamStyle) {
    if (style.team === 'order') {
      this.trim = lib.gold;
    } else {
      this.trim = new THREE.MeshStandardNodeMaterial();
      const n = mx_noise_float(positionWorld.mul(3.1)).mul(0.5).add(0.5);
      this.trim.colorNode = mix(color(0x1a1414), color(0x3a2222), n);
      this.trim.metalnessNode = float(0.9);
      this.trim.roughnessNode = float(0.38).add(n.mul(0.2));
    }
    this.banner = bannerMaterial(style);
    this.crystal = new THREE.MeshBasicNodeMaterial();
    this.crystal.colorNode = color(style.glow).mul(sin(time.mul(2.2)).mul(0.25).add(1.2)).mul(5);
    this.runes = new THREE.MeshBasicNodeMaterial();
    this.runes.colorNode = color(style.glow).mul(sin(time.mul(1.3).add(positionWorld.x.mul(0.3))).mul(0.3).add(1)).mul(3);
  }
}

/** Hanging banner: team cloth with a woven gold border and an emblem stripe, swaying gently. */
function bannerMaterial(style: TeamStyle): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const v = uv();
  const edge = smoothstep(0.06, 0.075, v.x).mul(smoothstep(0.94, 0.925, v.x)).mul(smoothstep(0.04, 0.055, v.y));
  const band = smoothstep(0.66, 0.67, v.y).mul(smoothstep(0.74, 0.73, v.y));
  const chevron = step(abs(v.x.sub(0.5)).mul(1.2).add(0.18), fract(v.y.mul(3.5))).mul(smoothstep(0.08, 0.1, v.y)).mul(smoothstep(0.6, 0.58, v.y));
  const gold = float(1).sub(edge).add(band).add(chevron.mul(0.6)).clamp(0, 1);
  const trim = style.team === 'order' ? color(0xe3b04b) : color(0x1a1414);
  mat.colorNode = mix(color(style.cloth).mul(mix(float(0.7), float(1.05), v.y)), trim, gold);
  mat.metalnessNode = gold.mul(style.team === 'order' ? 0.9 : 0.6);
  mat.roughnessNode = mix(float(0.85), float(0.35), gold);
  // sway: the hem moves, the top is fixed
  const down = float(1).sub(v.y);
  const sway = sin(time.mul(1.7).add(positionWorld.x.mul(0.4)).add(positionLocal.y.mul(1.3))).mul(0.12).mul(down.mul(down));
  mat.positionNode = positionLocal.add(vec3(0, 0, sway));
  return mat;
}

const shields = new Map<number, THREE.MeshBasicNodeMaterial>();

/** The shield dome's material, one per glow color. */
function shieldMaterial(glow: number): THREE.MeshBasicNodeMaterial {
  let mat = shields.get(glow);
  if (mat) return mat;
  // (like every additive glow: with no depth writes, one pass over both faces
  // adds up the same as three's default back-then-front pair of draws)
  mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true });
  const viewDir = normalize(positionView.negate());
  const fres = pow(float(1).sub(abs(dot(normalView, viewDir))), float(2.5));
  const bands = sin(positionLocal.y.mul(5).sub(time.mul(2.5))).mul(0.5).add(0.5);
  const hex = mx_noise_float(positionLocal.mul(2.2).add(vec3(0, time.mul(0.4), 0))).mul(0.5).add(0.5);
  // a faint rim and drifting hex sparkle, so the structure inside stays readable
  const a = fres.mul(0.55).add(bands.mul(0.02)).add(smoothstep(0.64, 0.7, hex).mul(0.05));
  mat.colorNode = color(glow).mul(a).mul(1.1);
  shields.set(glow, mat);
  return mat;
}

/** Translucent fresnel dome shown while a structure can't be damaged. */
export function shieldMesh(radius: number, height: number, glow: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  geo.scale(radius, height, radius);
  const m = new THREE.Mesh(geo, shieldMaterial(glow));
  m.renderOrder = 20;
  m.visible = false;
  // drawn while loading anyway, so raising it mid-match generates no shader
  m.userData.shownLater = true;
  m.name = 'shield';
  return m;
}

/** A structure's own wear (0 = pristine, 1 = about to fall) for the cracked stone its team shares. */
export const wearUniforms = () => ({ damage: 0 });
const cracked = new WeakMap<THREE.Material, Map<number, THREE.MeshStandardNodeMaterial>>();

/**
 * A stone material with glowing cracks that open as a structure takes damage.
 * One per stone and glow color, shared by every structure that uses it; each
 * shows its own wear through `showWear`.
 */
export function crackedStone(base: THREE.MeshStandardNodeMaterial, glow: number): THREE.MeshStandardNodeMaterial {
  let byGlow = cracked.get(base);
  if (!byGlow) cracked.set(base, (byGlow = new Map()));
  let mat = byGlow.get(glow);
  if (mat) return mat;
  const { damage } = objectUniforms(wearUniforms());
  mat = base.clone();
  const n = mx_noise_float(positionLocal.mul(1.3));
  const n2 = mx_noise_float(positionLocal.mul(3.7).add(5));
  const line = smoothstep(0.06, 0.0, abs(n)).max(smoothstep(0.04, 0.0, abs(n2)).mul(0.7));
  // cracks spread as damage rises: the noise threshold widens with damage
  const spread = smoothstep(float(1).sub(damage.mul(1.2)), float(1.05).sub(damage.mul(1.2)), mx_noise_float(positionLocal.mul(0.35)).mul(0.5).add(0.5));
  const crack = line.mul(spread).mul(step(0.01, damage));
  mat.colorNode = (base.colorNode as any).mul(float(1).sub(crack.mul(0.85)));
  mat.emissiveNode = color(glow).mul(crack).mul(damage).mul(1.5);
  byGlow.set(glow, mat);
  return mat;
}

/** Has every mesh under `root` drawn in `stone` (a `crackedStone`) show this wear. */
export function showWear(root: THREE.Object3D, stone: THREE.Material, wear: ReturnType<typeof wearUniforms>): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).material === stone) useUniforms(wear, o);
  });
}

/** A pile of broken blocks for the destroyed state, grown from 0 to full by `setGrowth`. */
export class Rubble {
  readonly group = new THREE.Group();
  private readonly pieces: { mesh: THREE.Mesh; delay: number }[] = [];

  constructor(radius: number, count: number, materials: THREE.Material[], seed: number) {
    const rand = rng(seed);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * radius;
      const s = 0.4 + rand() * 0.9;
      const geo = rand() < 0.6 ? chippedBlock(s * 1.4, s * 0.8, s, seed + i, 0.05) : boulder(s * 0.7, seed + i * 3, 2);
      const mesh = new THREE.Mesh(geo, materials[i % materials.length]);
      mesh.position.set(Math.cos(a) * d, s * 0.3, Math.sin(a) * d);
      mesh.rotation.set(rand() * 0.6, rand() * 6.28, rand() * 0.6);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.pieces.push({ mesh, delay: (d / radius) * 0.4 });
    }
    this.setGrowth(0);
  }

  setGrowth(t: number): void {
    this.group.visible = t > 0;
    for (const p of this.pieces) p.mesh.scale.setScalar(Math.max(0.001, Math.min(1, (t - p.delay) / 0.6)));
  }
}

const aged = new WeakMap<MaterialLibrary, THREE.MeshStandardNodeMaterial>();

/**
 * The library marble toned down to a warm, slightly aged cream with faint
 * grime in the crevices, so big marble masses don't blow out to white in sun.
 */
export function agedMarble(lib: MaterialLibrary): THREE.MeshStandardNodeMaterial {
  let m = aged.get(lib);
  if (!m) {
    m = lib.marble.clone() as THREE.MeshStandardNodeMaterial;
    const base = lib.marble.colorNode as any;
    const grime = mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5);
    // weathered, warm and a step darker than fresh marble, so it doesn't glare
    // white under the sun the way polished stone would
    m.colorNode = base.mul(vec3(0.66, 0.63, 0.58)).mul(mix(float(0.78), float(1.0), grime));
    aged.set(lib, m);
  }
  return m;
}

/** Smooth 0..1 easing. */
export const ease = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Disables matrix auto-update on children that never move. */
export function freeze(o: THREE.Object3D): void {
  o.traverse((c) => {
    c.updateMatrix();
    c.matrixAutoUpdate = false;
  });
}

export const vecUp = new THREE.Vector3(0, 1, 0);

export { mergeStatic } from '../merge';
