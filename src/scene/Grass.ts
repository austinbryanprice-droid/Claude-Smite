import * as THREE from 'three/webgpu';
import { Layers } from '../render/Layers';
import {
  attribute, cameraPosition, clamp, cos, dot, faceDirection, float, fract, mix, mx_noise_float, normalize, positionLocal, pow, sin,
  smoothstep, step, time, transformNormalToView, uniform, vec2, vec3,
} from '../render/tsl';
import { rng } from '../core/random';
import type { Terrain } from './Terrain';
import type { QualitySettings } from '../render/Quality';
import { hypot } from '../core/math';

/** Side of the square chunks the field is drawn in, meters. */
const CHUNK = 28;
/** Blades per square meter at density 1. */
const BASE_DENSITY = 34;
const SEGMENTS = 4;

interface Chunk {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  center: THREE.Vector3;
  /** Each blade's `thinRank`, ascending: blades are stored in this order. */
  ranks: Float32Array;
}

/**
 * The order in which blades thin out with distance, uniform in [0, 1) and
 * unrelated to the colour `variation` it's computed from. The shader computes
 * the same in 32-bit floats.
 */
function thinRank(variation: number): number {
  const x = Math.fround(variation) * 61.8;
  return x - Math.floor(x);
}

/**
 * GPU-animated grass. Each blade is one instance of a tapered, curved strip;
 * all placement, bending and wind happen in the vertex shader. The field is
 * split into chunks so off-screen chunks are culled, and blades thin out
 * one by one with distance (the ground texture underneath carries the look
 * far away): a chunk draws the blades its nearest point keeps, and the
 * shader folds away those its own distance drops.
 */
/** Where a map wants grass. */
export interface GrassField {
  /** Half-size of the area covered with chunks, meters. */
  extent: number;
  /** Skip chunks outside the circle of radius `extent`. */
  round: boolean;
  /** Multiplier on the preset's blade density. */
  density: number;
  /** No blades above this terrain height. */
  maxHeight: number;
  /** True where no grass may grow (plazas, structures). */
  reject(x: number, z: number): boolean;
}

export class Grass {
  readonly group = new THREE.Group();
  readonly wind = {
    direction: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    strength: uniform(0.55),
    speed: uniform(0.9),
  };
  /** World position of the player; blades bend away from it. */
  readonly pusher = uniform(new THREE.Vector3(0, -100, 0));
  private chunks: Chunk[] = [];
  private material: THREE.MeshStandardNodeMaterial;
  private bladeGeometry: THREE.BufferGeometry;
  /** The main camera's position: blades thin out with distance from it, in the shadow passes too. */
  private readonly viewer = uniform(new THREE.Vector3());
  /** Blades start thinning out beyond `fullDistance` and are all gone at `maxDistance`. */
  private readonly fullDistance = uniform(25);
  private readonly maxDistance = uniform(65);

  constructor(private readonly terrain: Terrain, private readonly sunDirection: THREE.Vector3, private readonly field: GrassField) {
    this.group.name = 'grass';
    this.bladeGeometry = Grass.buildBlade();
    this.material = this.buildMaterial();
  }

  /** A blade in the XY plane: x in [-0.5, 0.5] (width), y in [0, 1] (height). */
  private static buildBlade(): THREE.BufferGeometry {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const w = 1 - Math.pow(t, 1.6) * 0.85;
      pos.push(-0.5 * w, t, 0, 0.5 * w, t, 0);
    }
    pos.push(0, 1, 0);
    for (let i = 0; i < SEGMENTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const last = (SEGMENTS - 1) * 2;
    idx.push(last, last + 1, SEGMENTS * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    g.setIndex(idx);
    return g;
  }

  private buildMaterial(): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    const a = attribute('bladeA', 'vec4'); // x, y, z, yaw
    const b = attribute('bladeB', 'vec4'); // height, width, lean, variation
    const root = a.xyz;
    const yaw = a.w;
    const h = positionLocal.y;
    const variation = b.w;
    // thinning: a blade beyond the distance that keeps it folds to a point
    const far = clamp(root.xz.sub(this.viewer.xz).length().sub(this.fullDistance).div(this.maxDistance.sub(this.fullDistance)), 0, 1);
    const keep = step(fract(variation.mul(61.8)), float(1).sub(far).pow(2));
    const height = b.x.mul(keep);
    const width = b.y.mul(keep);
    const lean = b.z;

    // Wind: two octaves of drifting noise, gusts sweep across the field.
    const t = time.mul(this.wind.speed);
    const windUV = root.xz.mul(0.045).sub(vec2(this.wind.direction).mul(t.mul(0.6)));
    const gust = mx_noise_float(vec3(windUV, t.mul(0.15))).mul(0.5).add(0.5);
    const flutter = sin(t.mul(4.5).add(variation.mul(40)).add(root.x.mul(0.7))).mul(0.12);
    const windAmt = gust.mul(this.wind.strength).add(flutter.mul(this.wind.strength));

    // Push away from the player as they walk through.
    const toBlade = root.sub(this.pusher);
    const pushDist = toBlade.xz.length();
    const push = smoothstep(1.4, 0.2, pushDist).mul(0.9);
    const pushDir = toBlade.xz.div(pushDist.max(1e-3));

    const dirX = cos(yaw);
    const dirZ = sin(yaw);
    const bendCurve = pow(h, float(1.8));
    const local = vec3(
      positionLocal.x.mul(width).mul(dirX),
      h.mul(height),
      positionLocal.x.mul(width).mul(dirZ),
    );
    // Facing direction is perpendicular to the blade's width axis.
    const facing = vec2(dirZ.negate(), dirX);
    const bendXZ = facing.mul(lean)
      .add(vec2(this.wind.direction).mul(windAmt))
      .add(pushDir.mul(push))
      .mul(bendCurve).mul(height);
    // Keep blade length roughly constant when bending.
    const sag = bendXZ.length().mul(bendXZ.length()).mul(0.35).div(height.max(0.1));
    const pos = root.add(vec3(local.x.add(bendXZ.x), local.y.sub(sag.mul(h)), local.z.add(bendXZ.y)));
    mat.positionNode = pos;

    // Normal: blade face normal blended toward up (softer, like a grass "card" in UE).
    const faceN = vec3(facing.x, 0.4, facing.y).normalize();
    mat.normalNode = transformNormalToView(normalize(mix(faceN.mul(faceDirection), vec3(0, 1, 0), 0.75)));

    const base = mix(vec3(0.05, 0.13, 0.03), vec3(0.08, 0.17, 0.035), variation);
    // sunlit tips must stay close to the ground's albedo, or exposed ridges glow
    const tipGreen = mix(vec3(0.13, 0.3, 0.045), vec3(0.2, 0.34, 0.06), smoothstep(0.6, 0.97, variation));
    const col = mix(base, tipGreen, pow(h, float(0.9)));
    mat.colorNode = col;
    // rough enough that blades on sunward ridges don't flare with specular
    mat.roughnessNode = float(0.82).add(h.mul(0.1));
    mat.metalnessNode = float(0);
    mat.aoNode = mix(float(0.55), float(1), smoothstep(0.0, 0.6, h));
    // Fake subsurface: blades glow when the sun is behind them.
    const viewDir = normalize(pos.sub(cameraPosition));
    const sun = uniform(this.sunDirection);
    const back = pow(dot(viewDir, sun).max(0), float(3)).mul(h).mul(0.05);
    mat.emissiveNode = col.mul(vec3(1.0, 0.95, 0.7)).mul(back).mul(1.0);
    return mat;
  }

  build(q: QualitySettings): void {
    for (const c of this.chunks) {
      c.geometry.dispose();
      this.group.remove(c.mesh);
    }
    this.chunks = [];
    this.fullDistance.value = q.grassDistance * 0.35;
    this.maxDistance.value = q.grassDistance;
    const density = BASE_DENSITY * q.grassDensity * this.field.density;
    const extent = this.field.extent;
    const n = Math.ceil((extent * 2) / CHUNK);
    const random = rng(4242);
    const normal = new THREE.Vector3();

    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        const x0 = -extent + cx * CHUNK;
        const z0 = -extent + cz * CHUNK;
        if (this.field.round && hypot(x0 + CHUNK / 2, z0 + CHUNK / 2) > extent + CHUNK) continue;
        const tries = Math.round(CHUNK * CHUNK * density);
        const A: number[] = [];
        const B: number[] = [];
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < tries; i++) {
          const x = x0 + random() * CHUNK;
          const z = z0 + random() * CHUNK;
          if (this.field.reject(x, z)) continue;
          const m = this.terrain.maskAt(x, z);
          const bare = Math.max(m.paved * 1.5, m.dirt);
          if (random() < bare * 1.15) continue;
          this.terrain.normalAt(x, z, normal);
          if (normal.y < 0.86) continue;
          const y = this.terrain.heightAt(x, z);
          if (y > this.field.maxHeight) continue;
          // clumping: density modulated by low-frequency hash
          const clump = 0.55 + 0.45 * Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2.0) * Math.sin(z * 0.27 + x * 0.05);
          if (random() > clump + 0.45) continue;
          const edge = 1 - bare; // shorter grass at path edges
          const height = (0.32 + random() * 0.38) * (0.5 + 0.5 * edge) * (0.8 + clump * 0.4);
          A.push(x, y - 0.03, z, random() * Math.PI * 2);
          B.push(height, 0.12 + random() * 0.1, (random() - 0.2) * 0.45, random());
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y + height);
        }
        const count = A.length / 4;
        if (count === 0) continue;
        // in thinning order, so the blades a chunk keeps are its first ones
        const order = Array.from({ length: count }, (_, i) => i).sort((i, j) => thinRank(B[i * 4 + 3]!) - thinRank(B[j * 4 + 3]!));
        const bladeA = new Float32Array(count * 4);
        const bladeB = new Float32Array(count * 4);
        order.forEach((from, to) => {
          for (let k = 0; k < 4; k++) {
            bladeA[to * 4 + k] = A[from * 4 + k]!;
            bladeB[to * 4 + k] = B[from * 4 + k]!;
          }
        });
        const ranks = Float32Array.from(order, (i) => thinRank(B[i * 4 + 3]!));
        const geo = new THREE.InstancedBufferGeometry();
        // own copies of the (tiny) blade buffers: disposing a chunk on a quality
        // change destroys its GPU buffers, which must not be shared with others
        geo.index = this.bladeGeometry.index!.clone();
        geo.setAttribute('position', this.bladeGeometry.getAttribute('position').clone());
        geo.setAttribute('normal', this.bladeGeometry.getAttribute('normal').clone());
        geo.setAttribute('bladeA', new THREE.InstancedBufferAttribute(bladeA, 4));
        geo.setAttribute('bladeB', new THREE.InstancedBufferAttribute(bladeB, 4));
        geo.instanceCount = count;
        const center = new THREE.Vector3(x0 + CHUNK / 2, (minY + maxY) / 2, z0 + CHUNK / 2);
        geo.boundingSphere = new THREE.Sphere(center.clone(), Math.hypot(CHUNK / 2, CHUNK / 2, (maxY - minY) / 2) + 1.5);
        geo.boundingBox = new THREE.Box3(
          new THREE.Vector3(x0 - 1, minY - 1, z0 - 1),
          new THREE.Vector3(x0 + CHUNK + 1, maxY + 1, z0 + CHUNK + 1),
        );
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.castShadow = q.grassShadows;
        mesh.layers.set(Layers.NEAR_SHADOW);
        mesh.receiveShadow = true;
        mesh.name = 'grass-chunk';
        this.group.add(mesh);
        this.chunks.push({ mesh, geometry: geo, center, ranks });
      }
    }
  }

  /** Distance-based thinning; call once per frame. */
  update(camera: THREE.Camera, playerPosition?: THREE.Vector3): void {
    if (playerPosition) this.pusher.value.copy(playerPosition);
    const p = this.viewer.value.copy(camera.position);
    const full = this.fullDistance.value;
    const max = this.maxDistance.value;
    for (const c of this.chunks) {
      // the chunk's nearest point keeps the most blades
      const d = Math.max(0, hypot(c.center.x - p.x, c.center.z - p.z) - CHUNK * Math.SQRT1_2);
      const k = Math.max(0, Math.min(1, 1 - (d - full) / (max - full)));
      const kept = k > 0 ? upperBound(c.ranks, k * k + 1e-4) : 0;
      c.mesh.visible = kept > 0;
      c.geometry.instanceCount = kept;
    }
  }

  get bladeCount(): number {
    return this.chunks.reduce((s, c) => s + (c.mesh.visible ? c.geometry.instanceCount : 0), 0);
  }
}

/** The number of values in ascending `sorted` that are at most `x`. */
function upperBound(sorted: Float32Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
