import * as THREE from 'three/webgpu';
import {
  float, Fn, mix, normalWorld, positionWorld, smoothstep, texture, transformNormalToView, vec2, vec3,
} from '../render/tsl';
import { fbm2, simplex2, smoothstep as sstep } from '../core/random';
import { Arena, laneDistance, pathDistance } from './ArenaLayout';
import { planar, triplanar, type TextureLibrary } from './Materials';

const SEGMENTS = 400;

/**
 * Heightfield terrain: a grassy valley floor around the temple, rising into
 * layered cliffs with canyons where the lanes exit. Heights live on the CPU
 * too, so movement and prop placement can query them.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly size = Arena.terrainSize;
  private readonly heights: Float32Array;
  private readonly res = SEGMENTS + 1;
  /** RGBA splat mask over `Arena.maskSize`: R dirt path, G paved lane, B damp/dark, A macro variation. */
  readonly mask: THREE.DataTexture;

  constructor(textures: TextureLibrary) {
    this.heights = this.generateHeights();
    this.mask = this.generateMask();
    const geometry = this.buildGeometry();
    const material = this.buildMaterial(textures);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
  }

  /** Raw procedural height function (before sampling into the grid). */
  private static heightFn(): (x: number, z: number) => number {
    const n1 = simplex2(11);
    const n2 = simplex2(23);
    const n3 = simplex2(37);
    const { valleyRadius, plaza } = Arena;
    return (x, z) => {
      const r = Math.hypot(x, z);
      // gentle undulation on the valley floor
      let h = fbm2(n1, x * 0.018, z * 0.018, 4) * 1.6 + fbm2(n2, x * 0.07, z * 0.07, 2) * 0.25;
      // cliffs: warped radius so the rim is irregular
      const warpR = r + fbm2(n2, x * 0.012, z * 0.012, 3) * 22;
      const rim = sstep(valleyRadius - 4, valleyRadius + 38, warpR);
      const ridge = 1 - Math.abs(fbm2(n3, x * 0.02, z * 0.02, 5));
      const strata = Math.round(rim * 7 + ridge * 0.6) / 7; // terraced ledges
      const cliffH = (38 + ridge * 40 + fbm2(n1, x * 0.008, z * 0.008, 3) * 25) * (rim * 0.55 + strata * 0.45);
      // canyons where lanes leave the valley
      const lane = laneDistance(x, z);
      const canyon = 1 - sstep(4, 26 + Math.max(0, r - valleyRadius) * 0.25, lane);
      h += cliffH * (1 - canyon * 0.92);
      // distant mountains
      h += sstep(170, 250, r) * (60 + fbm2(n3, x * 0.004, z * 0.004, 4) * 60);
      // flatten under the temple and lanes so architecture sits cleanly
      const plazaFlat = 1 - sstep(plaza.baseRadius + 1, plaza.baseRadius + 10, r);
      const laneFlat = 1 - sstep(1.5, 7, lane);
      const flat = Math.max(plazaFlat, laneFlat * (1 - rim));
      h = h * (1 - flat) + -0.05 * flat;
      // slight dip of the dirt paths
      const pd = pathDistance(x, z);
      h -= (1 - sstep(-1, 2.5, pd)) * 0.12;
      return h;
    };
  }

  private generateHeights(): Float32Array {
    const f = Terrain.heightFn();
    const h = new Float32Array(this.res * this.res);
    const half = this.size / 2;
    const step = this.size / SEGMENTS;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        h[j * this.res + i] = f(-half + i * step, -half + j * step);
      }
    }
    return h;
  }

  private generateMask(): THREE.DataTexture {
    const N = 512;
    const data = new Uint8Array(N * N * 4);
    const n = simplex2(91);
    const half = Arena.maskSize / 2;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -half + ((i + 0.5) / N) * Arena.maskSize;
        const z = -half + ((j + 0.5) / N) * Arena.maskSize;
        const edgeNoise = fbm2(n, x * 0.25, z * 0.25, 3);
        const pd = pathDistance(x, z) + edgeNoise * 0.9;
        const ld = laneDistance(x, z) + edgeNoise * 0.5;
        const r = Math.hypot(x, z);
        const dirt = 1 - sstep(-0.6, 1.4, pd);
        // dirt apron around the temple base and lane borders
        const apron = (1 - sstep(Arena.plaza.baseRadius - 0.5, Arena.plaza.baseRadius + 3.5 + edgeNoise * 2, r));
        const laneDirt = 1 - sstep(0, 2.2, ld);
        const paved = 1 - sstep(-0.4, 0.3, ld);
        const damp = Math.max(0, fbm2(n, x * 0.05, z * 0.05, 3)) * 0.8;
        const macro = fbm2(n, x * 0.015 + 100, z * 0.015, 4) * 0.5 + 0.5;
        const k = (j * N + i) * 4;
        data[k] = Math.round(Math.min(1, Math.max(dirt, apron * 0.9, laneDirt * 0.85)) * 255);
        data[k + 1] = Math.round(paved * 255);
        data[k + 2] = Math.round(damp * 255);
        data[k + 3] = Math.round(macro * 255);
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
    const geo = new THREE.PlaneGeometry(this.size, this.size, SEGMENTS, SEGMENTS);
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
    geo.computeBoundingSphere();
    return geo;
  }

  private buildMaterial(textures: TextureLibrary): THREE.MeshStandardNodeMaterial {
    const mat = new THREE.MeshStandardNodeMaterial();
    const maskUV = positionWorld.xz.div(Arena.maskSize).add(0.5);
    const m = texture(this.mask, maskUV);
    const inMask = smoothstep(0.5, 0.47, maskUV.sub(0.5).abs().max()).toVar();
    const dirtW = m.r.mul(inMask);
    const pavedW = m.g.mul(inMask);
    const damp = m.b.mul(inMask);
    const macro = mix(float(0.5), m.a, inMask);

    const n = normalWorld.normalize();
    // Grass layer at two scales to hide tiling.
    const gA = planar(textures.get('grass_ground'), positionWorld.xz.mul(0.16), n);
    const gB = planar(textures.get('grass_ground'), positionWorld.xz.mul(0.037).add(vec2(0.37, 0.71)), n);
    const dirt = planar(textures.get('dirt'), positionWorld.xz.mul(0.22), n);
    const paved = planar(textures.get('flagstone'), positionWorld.xz.mul(0.16), n);
    const rock = triplanar(textures.get('rock'), 0.06, 6);
    const rockFine = triplanar(textures.get('rock'), 0.21, 6);

    const slope = n.y;
    // Rock on steep slopes and high up; noise breaks up the transition line.
    const rockW = smoothstep(0.82, 0.62, slope.add(macro.sub(0.5).mul(0.2))).max(smoothstep(14, 30, positionWorld.y).mul(0.6)).toVar();

    const grassCol = mix(gA.color, gB.color, 0.4).mul(mix(vec3(0.92, 1.0, 0.85), vec3(1.08, 1.0, 0.92), macro)).toVar();
    const result = Fn(() => {
      const col = grassCol.toVar();
      const nrm = mix(gA.normal, gB.normal, 0.4).toVar();
      const rough = mix(gA.roughness, gB.roughness, 0.4).toVar();
      const ao = gA.ao.toVar();
      // Height-aware blend: pebbles poke through the grass edge first.
      const dW = smoothstep(0.25, 0.75, dirtW.add(dirt.ao.oneMinus().mul(0.3)).sub(0.15)).toVar();
      col.assign(mix(col, dirt.color, dW));
      nrm.assign(mix(nrm, dirt.normal, dW));
      rough.assign(mix(rough, dirt.roughness, dW));
      ao.assign(mix(ao, dirt.ao, dW));
      col.assign(mix(col, paved.color, pavedW));
      nrm.assign(mix(nrm, paved.normal, pavedW));
      rough.assign(mix(rough, paved.roughness, pavedW));
      ao.assign(mix(ao, paved.ao, pavedW));
      const rc = rock.color.mul(rockFine.color.mul(1.6)).toVar();
      col.assign(mix(col, rc, rockW));
      nrm.assign(mix(nrm, rock.normal.add(rockFine.normal).normalize(), rockW));
      rough.assign(mix(rough, rock.roughness, rockW));
      ao.assign(mix(ao, rock.ao.mul(rockFine.ao), rockW));
      // Damp patches: darker and slightly glossier.
      col.mulAssign(float(1).sub(damp.mul(0.25)));
      rough.assign(rough.sub(damp.mul(0.12)));
      return { col, nrm, rough, ao };
    });
    const r = result() as any;
    mat.colorNode = r.col;
    mat.normalNode = transformNormalToView(r.nrm.normalize());
    mat.roughnessNode = r.rough;
    mat.aoNode = r.ao;
    mat.metalnessNode = float(0);
    return mat;
  }

  /** Bilinear height lookup in world space. */
  heightAt(x: number, z: number): number {
    const half = this.size / 2;
    const fx = ((x + half) / this.size) * SEGMENTS;
    const fz = ((z + half) / this.size) * SEGMENTS;
    const i = Math.max(0, Math.min(SEGMENTS - 1, Math.floor(fx)));
    const j = Math.max(0, Math.min(SEGMENTS - 1, Math.floor(fz)));
    const tx = Math.min(Math.max(fx - i, 0), 1);
    const tz = Math.min(Math.max(fz - j, 0), 1);
    const r = this.res;
    const h00 = this.heights[j * r + i];
    const h10 = this.heights[j * r + i + 1];
    const h01 = this.heights[(j + 1) * r + i];
    const h11 = this.heights[(j + 1) * r + i + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Approximate surface normal from the height grid. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = this.size / SEGMENTS;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** 0..1 weights from the splat mask, sampled on the CPU (for grass placement). */
  maskAt(x: number, z: number): { dirt: number; paved: number } {
    const N = 512;
    const u = (x / Arena.maskSize + 0.5) * N;
    const v = (z / Arena.maskSize + 0.5) * N;
    if (u < 0 || v < 0 || u >= N || v >= N) return { dirt: 0, paved: 0 };
    const k = (Math.floor(v) * N + Math.floor(u)) * 4;
    const d = this.mask.image.data as Uint8Array;
    return { dirt: d[k] / 255, paved: d[k + 1] / 255 };
  }
}
