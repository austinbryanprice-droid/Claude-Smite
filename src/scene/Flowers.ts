import * as THREE from 'three/webgpu';
import {
  abs, attribute, float, fract, hash, instanceIndex, mix, positionLocal, sin, smoothstep, step, time, uv, vec3,
} from '../render/tsl';
import { rng } from '../core/random';

/** One flower clump to place. */
export interface FlowerInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const SPIKES = 7;

/**
 * Clumps of flowering spikes (lavender-like) for the lane verges. Each clump
 * is a handful of crossed cards; the stem, the floret bumps and the color
 * all come from the shader, so there is no texture to load. Every clump is
 * one instance of a single tiny mesh, cheap enough to scatter thousands.
 */
export class Flowers {
  readonly mesh: THREE.InstancedMesh;

  constructor(list: FlowerInstance[]) {
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    const v = uv().y;
    const u = uv().x;
    const sway = attribute('sway', 'float');
    const phase = hash(instanceIndex).mul(6.283);
    const bend = sin(time.mul(1.6).add(phase)).mul(0.06).mul(sway);
    mat.positionNode = positionLocal.add(vec3(bend, 0, bend.mul(0.7)));

    // the top 45% of each card is the flower spike, the rest a thin stem
    const head = smoothstep(0.5, 0.6, v);
    // florets: stacked bumps that narrow toward the tip
    const bumps = abs(sin(v.mul(46))).mul(0.25).add(0.75);
    const spikeHalf = mix(float(0.42), float(0.12), smoothstep(0.55, 1.0, v)).mul(bumps);
    const stemHalf = float(0.07);
    const half = mix(stemHalf, spikeHalf, head);
    mat.opacityNode = step(abs(u.sub(0.5)), half).mul(step(v, 0.985));
    mat.alphaTest = 0.5;

    // per-clump palette: mostly lavender, some magenta and a few pale gold
    const h = hash(instanceIndex.add(11));
    const lavender = vec3(0.42, 0.24, 0.85);
    const magenta = vec3(0.78, 0.18, 0.58);
    const gold = vec3(0.95, 0.78, 0.3);
    const petal = mix(mix(lavender, magenta, step(0.72, h)), gold, step(0.92, h));
    const tip = petal.mul(mix(float(0.75), float(1.25), v));
    const stem = vec3(0.12, 0.26, 0.06);
    const floret = fract(v.mul(46 / Math.PI)).mul(0.25).add(0.85);
    mat.colorNode = mix(stem, tip.mul(floret), head);
    mat.roughnessNode = float(0.75);
    mat.metalnessNode = float(0);
    // a little glow so the color reads in shade, as in the stylized references
    mat.emissiveNode = tip.mul(head).mul(0.12);

    this.mesh = new THREE.InstancedMesh(Flowers.clump(), mat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    list.forEach((it, i) => {
      m.compose(p.set(it.x, it.y, it.z), q.setFromAxisAngle(up, it.yaw), s.setScalar(it.scale));
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'flowers';
  }

  /** A clump of spikes, each two crossed cards, leaning slightly outward. */
  private static clump(): THREE.BufferGeometry {
    const rand = rng(4040);
    const pos: number[] = [];
    const nrm: number[] = [];
    const uvs: number[] = [];
    const sway: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < SPIKES; i++) {
      const a = (i / SPIKES) * Math.PI * 2 + rand() * 0.6;
      const r = i === 0 ? 0 : 0.08 + rand() * 0.14;
      const bx = Math.cos(a) * r;
      const bz = Math.sin(a) * r;
      const h = 0.45 + rand() * 0.35;
      const lean = 0.08 + rand() * 0.1;
      const tx = bx + Math.cos(a) * lean;
      const tz = bz + Math.sin(a) * lean;
      const w = 0.09;
      for (const rot of [0, Math.PI / 2]) {
        const yaw = a + rot;
        const dx = Math.cos(yaw) * w;
        const dz = Math.sin(yaw) * w;
        const base = pos.length / 3;
        pos.push(bx - dx, 0, bz - dz, bx + dx, 0, bz + dz, tx + dx, h, tz + dz, tx - dx, h, tz - dz);
        // soft upward normals so the clump shades like one tuft
        for (let k = 0; k < 4; k++) nrm.push(Math.cos(a) * 0.3, 0.95, Math.sin(a) * 0.3);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        sway.push(0, 0, 1, 1);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(sway, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }
}
