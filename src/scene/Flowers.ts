import * as THREE from 'three/webgpu';
import {
  abs, attribute, float, fract, hash, mix, sin, smoothstep, step, time, uv, vec3,
} from '../render/tsl';
import { rng } from '../core/random';
import { placedGeometry, placeInstances } from '../render/shared';

/** One flower clump to place. */
export interface FlowerInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const SPIKES = 7;
/** Clumps are batched per square region this wide, so off-screen ones are culled. */
const CHUNK = 50;

/**
 * Clumps of flowering spikes (lavender-like) for the lane verges. Each clump
 * is a handful of crossed cards; the stem, the floret bumps and the color
 * all come from the shader, so there is no texture to load. Every clump is
 * one instance of a single tiny mesh, cheap enough to scatter thousands.
 */
export class Flowers {
  readonly root = new THREE.Group();

  constructor(list: FlowerInstance[]) {
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    const v = uv().y;
    const u = uv().x;
    const sway = attribute('sway', 'float');
    // per-clump random number, stored per instance so it survives chunking
    const seed = attribute('seed', 'float');
    const phase = hash(seed).mul(6.283);
    const bend = sin(time.mul(1.6).add(phase)).mul(0.06).mul(sway);
    mat.positionNode = placeInstances(mat).add(vec3(bend, 0, bend.mul(0.7)));

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
    const h = hash(seed.add(11));
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

    const chunks = new Map<string, FlowerInstance[]>();
    for (const it of list) {
      const key = `${Math.floor(it.x / CHUNK)}:${Math.floor(it.z / CHUNK)}`;
      let c = chunks.get(key);
      if (!c) chunks.set(key, (c = []));
      c.push(it);
    }
    const clump = Flowers.clump();
    clump.computeBoundingSphere();
    const reach = clump.boundingSphere!.center.length() + clump.boundingSphere!.radius;
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    let n = 0;
    for (const items of chunks.values()) {
      // each chunk is its own mesh, so off-screen ones are culled; all share one shader
      const { geometry, spot, turn } = placedGeometry(clump, items.length);
      const seeds = new Float32Array(items.length);
      box.makeEmpty();
      let maxScale = 0;
      items.forEach((it, i) => {
        spot.setXYZW(i, it.x, it.y, it.z, it.scale);
        turn.setXY(i, Math.cos(it.yaw), Math.sin(it.yaw));
        seeds[i] = n++;
        box.expandByPoint(p.set(it.x, it.y, it.z));
        maxScale = Math.max(maxScale, it.scale);
      });
      geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 1));
      geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      geometry.boundingSphere.radius += reach * maxScale;
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = 'flowers';
      this.root.add(mesh);
    }
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
