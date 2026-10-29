import * as THREE from 'three/webgpu';
import {
  dot, float, max, mix, normalWorld, positionWorld, sin, smoothstep, texture, transformNormalToView, vec2, vec3,
} from '../render/tsl';
import { planar, triplanar, type TextureLibrary } from './Materials';

/** Everything a map supplies to build its terrain. */
export interface TerrainDef {
  /** Side length of the square heightfield, meters, centered on the origin. */
  size: number;
  /** Grid cells per side. */
  segments: number;
  /** Side length of the centered region covered by the splat mask. */
  maskSize: number;
  /** Mask texels per side. */
  maskRes: number;
  height(x: number, z: number): number;
  /** Splat weights at a point, each 0..1: dirt, paved, damp, macro variation. */
  mask(x: number, z: number): readonly [number, number, number, number];
}

/** Grid cells per side of one terrain tile. */
const TILE_CELLS = 64;

/**
 * Heightfield terrain built from a map's `TerrainDef`: grass, dirt, paved and
 * rock layers blended by a splat mask and by slope. Heights live on the CPU
 * too, so movement and prop placement can query them.
 *
 * The mesh is split into tiles so the camera and each shadow cascade only
 * draw the tiles they can see, instead of the whole map every pass.
 */
export class Terrain {
  readonly root = new THREE.Group();
  readonly size: number;
  private readonly segments: number;
  private readonly heights: Float32Array;
  private readonly res: number;
  /** RGBA splat mask over `def.maskSize`: R dirt path, G paved lane, B damp/dark, A macro variation. */
  readonly mask: THREE.DataTexture;

  constructor(textures: TextureLibrary, readonly def: TerrainDef) {
    this.size = def.size;
    this.segments = def.segments;
    this.res = def.segments + 1;
    this.heights = this.generateHeights();
    this.mask = this.generateMask();
    const geometry = this.buildGeometry();
    const material = this.buildMaterial(textures);
    this.root.name = 'terrain';
    for (const tile of this.tiles(geometry)) {
      const mesh = new THREE.Mesh(tile, material);
      mesh.name = 'terrain-tile';
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.root.add(mesh);
    }
    geometry.dispose();
  }

  /**
   * Cuts the full grid into square tiles that share their edge vertices.
   * Normals come from the full grid, so there are no seams between tiles.
   */
  private tiles(full: THREE.BufferGeometry): THREE.BufferGeometry[] {
    const pos = full.getAttribute('position') as THREE.BufferAttribute;
    const nrm = full.getAttribute('normal') as THREE.BufferAttribute;
    const r = this.res;
    const n = Math.ceil(this.segments / TILE_CELLS);
    const out: THREE.BufferGeometry[] = [];
    for (let tj = 0; tj < n; tj++) {
      for (let ti = 0; ti < n; ti++) {
        const i0 = Math.floor((ti * this.segments) / n);
        const i1 = Math.floor(((ti + 1) * this.segments) / n);
        const j0 = Math.floor((tj * this.segments) / n);
        const j1 = Math.floor(((tj + 1) * this.segments) / n);
        const w = i1 - i0 + 1;
        const h = j1 - j0 + 1;
        const p = new Float32Array(w * h * 3);
        const q = new Float32Array(w * h * 3);
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const src = (j0 + j) * r + (i0 + i);
            const dst = (j * w + i) * 3;
            p[dst] = pos.getX(src); p[dst + 1] = pos.getY(src); p[dst + 2] = pos.getZ(src);
            q[dst] = nrm.getX(src); q[dst + 1] = nrm.getY(src); q[dst + 2] = nrm.getZ(src);
          }
        }
        // same winding as PlaneGeometry: a, b, d and b, c, d per cell
        const idx: number[] = [];
        for (let j = 0; j < h - 1; j++) {
          for (let i = 0; i < w - 1; i++) {
            const a = j * w + i;
            const b = (j + 1) * w + i;
            const c = (j + 1) * w + i + 1;
            const d = j * w + i + 1;
            idx.push(a, b, d, b, c, d);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(q, 3));
        g.setIndex(idx);
        g.computeBoundingSphere();
        g.computeBoundingBox();
        out.push(g);
      }
    }
    return out;
  }

  private generateHeights(): Float32Array {
    const h = new Float32Array(this.res * this.res);
    const half = this.size / 2;
    const step = this.size / this.segments;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        h[j * this.res + i] = this.def.height(-half + i * step, -half + j * step);
      }
    }
    return h;
  }

  private generateMask(): THREE.DataTexture {
    const N = this.def.maskRes;
    const S = this.def.maskSize;
    const data = new Uint8Array(N * N * 4);
    const half = S / 2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const w = this.def.mask(-half + ((i + 0.5) / N) * S, -half + ((j + 0.5) / N) * S);
        const k = (j * N + i) * 4;
        data[k] = Math.round(w[0] * 255);
        data[k + 1] = Math.round(w[1] * 255);
        data[k + 2] = Math.round(w[2] * 255);
        data[k + 3] = Math.round(w[3] * 255);
      }
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  private buildGeometry(): THREE.BufferGeometry {
    const geo = new THREE.PlaneGeometry(this.size, this.size, this.segments, this.segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    // PlaneGeometry rotated: vertex rows run from -z (j=0) to +z after rotation.
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      pos.setY(v, this.heightAt(x, z));
    }
    geo.deleteAttribute('uv');
    geo.computeVertexNormals();
    return geo;
  }

  private buildMaterial(textures: TextureLibrary): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial();
    const maskUV = positionWorld.xz.div(this.def.maskSize).add(0.5);
    const m = texture(this.mask, maskUV);
    const edge = maskUV.sub(0.5).abs();
    const inMask = smoothstep(0.5, 0.47, max(edge.x, edge.y));
    const dirtW = m.r.mul(inMask);
    const pavedW = m.g.mul(inMask);
    const damp = m.b.mul(inMask);
    const macro = mix(float(0.5), m.a, inMask);

    const n = normalWorld.normalize();
    // Grass layer at two scales to hide tiling.
    const gA = planar(textures.get('grass_ground'), positionWorld.xz.mul(0.16), n);
    const gB = planar(textures.get('grass_ground'), positionWorld.xz.mul(0.037).add(vec2(0.37, 0.71)), n);
    const dirt = planar(textures.get('dirt'), positionWorld.xz.mul(0.22), n);
    const paved = planar(textures.get('flagstone'), positionWorld.xz.mul(0.065), n);
    const rock = triplanar(textures.get('rock'), 0.06, 6);
    const rockFine = triplanar(textures.get('rock'), 0.21, 6);

    const slope = n.y;
    // Rock on steep slopes and high up; noise breaks up the transition line.
    const rockW = smoothstep(0.8, 0.6, slope.add(macro.sub(0.5).mul(0.2)));

    // tinted toward the blades' green so gaps between grass clumps don't read as bare earth
    const grassCol = mix(gA.color, gB.color, 0.4).mul(mix(vec3(0.72, 1.0, 0.6), vec3(0.86, 1.04, 0.66), macro));
    // Layer stack: grass -> dirt -> paved -> rock. Pebbles poke through the
    // grass edge first (height-aware blend using the dirt AO as a height proxy).
    const dW = smoothstep(0.25, 0.75, dirtW.add(dirt.color.g.mul(0.8)).sub(0.2));
    const lerp4 = (a: any, b: any, w: any) => ({
      col: mix(a.col, b.col, w), nrm: mix(a.nrm, b.nrm, w), rough: mix(a.rough, b.rough, w), ao: mix(a.ao, b.ao, w),
    });
    let L: any = {
      col: grassCol, nrm: mix(gA.normal, gB.normal, 0.4), rough: mix(gA.roughness, gB.roughness, 0.4), ao: gA.ao,
    };
    // muted, slightly olive earth so paths sit under the grass instead of glowing red
    const dirtCol = mix(dirt.color, vec3(dot(dirt.color, vec3(0.3, 0.59, 0.11))), 0.35).mul(vec3(0.92, 0.95, 0.85));
    L = lerp4(L, { col: dirtCol, nrm: dirt.normal, rough: dirt.roughness, ao: dirt.ao }, dW);
    // worn, slightly mossy grey-olive paving, darker than the temple's sandstone
    const pavedLum = dot(paved.color, vec3(0.3, 0.59, 0.11));
    // big, worn grey-olive slabs with soft seams, like the reference lanes
    const pavedCol = mix(paved.color, vec3(pavedLum), 0.4).mul(vec3(0.66, 0.7, 0.52)).mul(mix(vec3(0.9), vec3(1.08), macro));
    L = lerp4(L, { col: mix(pavedCol, vec3(0.22, 0.24, 0.17), 0.3), nrm: paved.normal, rough: paved.roughness, ao: paved.ao }, pavedW);
    // Cool grey-green stylized cliffs with faint banding, and moss and grass
    // that cling to every ledge the detail normal says faces upward.
    const rockNrm = rock.normal.add(rockFine.normal).normalize();
    const strata = sin(positionWorld.y.mul(0.9).add(rock.color.r.mul(6))).mul(0.5).add(0.5);
    const rockRaw = rock.color.mul(rockFine.color.mul(1.75));
    const rockLum = dot(rockRaw, vec3(0.3, 0.59, 0.11));
    const rockCol = mix(rockRaw, vec3(rockLum).mul(vec3(0.8, 0.9, 0.82)), 0.85)
      .mul(mix(vec3(0.95), vec3(1.06, 1.08, 1.04), strata)).mul(1.35);
    const ledge = smoothstep(0.55, 0.85, rockNrm.y.add(macro.sub(0.5).mul(0.5)));
    const mossCol = grassCol.mul(vec3(0.9, 1.05, 0.8));
    L = lerp4(L, {
      col: mix(rockCol, mossCol, ledge.mul(0.85)),
      nrm: rockNrm,
      rough: mix(rock.roughness, float(0.9), ledge),
      ao: rock.ao.mul(rockFine.ao),
    }, rockW);
    // Damp patches: darker and slightly glossier.
    mat.colorNode = L.col.mul(float(1).sub(damp.mul(0.25)));
    mat.normalNode = transformNormalToView(L.nrm.normalize());
    mat.roughnessNode = L.rough.sub(damp.mul(0.12));
    mat.aoNode = L.ao;
    mat.metalnessNode = float(0);
    return mat;
  }

  /** Bilinear height lookup in world space. */
  heightAt(x: number, z: number): number {
    const half = this.size / 2;
    const fx = ((x + half) / this.size) * this.segments;
    const fz = ((z + half) / this.size) * this.segments;
    const i = Math.max(0, Math.min(this.segments - 1, Math.floor(fx)));
    const j = Math.max(0, Math.min(this.segments - 1, Math.floor(fz)));
    const tx = Math.min(Math.max(fx - i, 0), 1);
    const tz = Math.min(Math.max(fz - j, 0), 1);
    const r = this.res;
    const h00 = this.heights[j * r + i]!;
    const h10 = this.heights[j * r + i + 1]!;
    const h01 = this.heights[(j + 1) * r + i]!;
    const h11 = this.heights[(j + 1) * r + i + 1]!;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Approximate surface normal from the height grid. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = this.size / this.segments;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** 0..1 weights from the splat mask, sampled on the CPU (for grass placement). */
  maskAt(x: number, z: number): { dirt: number; paved: number } {
    const N = this.def.maskRes;
    const u = (x / this.def.maskSize + 0.5) * N;
    const v = (z / this.def.maskSize + 0.5) * N;
    if (u < 0 || v < 0 || u >= N || v >= N) return { dirt: 0, paved: 0 };
    const k = (Math.floor(v) * N + Math.floor(u)) * 4;
    const d = this.mask.image.data as Uint8Array;
    return { dirt: d[k]! / 255, paved: d[k + 1]! / 255 };
  }
}
