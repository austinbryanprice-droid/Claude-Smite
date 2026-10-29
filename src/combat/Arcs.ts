import * as THREE from 'three/webgpu';
import { abs, attribute, float, mix, smoothstep, uniform, uv, vec4 } from '../render/tsl';

/** Segments one arc mesh can hold (main bolt plus forks). */
const MAX_SEGMENTS = 256;

type P = THREE.Vector3;

/**
 * Jagged lightning: a bolt split by midpoint displacement, drawn as two
 * crossed ribbons per segment so it reads from every camera angle without
 * knowing where the camera is. White-hot center, god-colored edges, HDR so
 * bloom turns it into a glowing filament.
 */
export class ArcView {
  readonly group = new THREE.Group();
  readonly main = uniform(new THREE.Color());
  readonly core = uniform(new THREE.Color());
  readonly fade = uniform(1);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos = new Float32Array(MAX_SEGMENTS * 8 * 3);
  private readonly heat = new Float32Array(MAX_SEGMENTS * 8);
  private segments = 0;

  constructor() {
    const index: number[] = [];
    const uvs = new Float32Array(MAX_SEGMENTS * 8 * 2);
    for (let s = 0; s < MAX_SEGMENTS; s++) {
      for (let q = 0; q < 2; q++) {
        const b = s * 8 + q * 4;
        index.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
        // u along the segment, v across the ribbon
        uvs.set([0, 0, 0, 1, 1, 0, 1, 1], b * 2);
      }
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('heat', new THREE.BufferAttribute(this.heat, 1));
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const across = abs(uv().y.sub(0.5)).mul(2);
    const filament = smoothstep(1, 0.15, across);
    const heat = attribute('heat', 'float');
    const c = mix(this.main, this.core, smoothstep(0.55, 0, across).mul(heat));
    mat.colorNode = vec4(c.mul(float(3).add(heat.mul(9))).mul(filament).mul(this.fade), 1);
    mat.opacityNode = filament.mul(this.fade);
    const mesh = new THREE.Mesh(this.geometry, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 14;
    this.group.add(mesh);
    this.geometry.setDrawRange(0, 0);
  }

  setColors(main: number, core: number): void {
    this.main.value.setHex(main);
    this.core.value.setHex(core);
  }

  clear(): void {
    this.segments = 0;
    this.geometry.setDrawRange(0, 0);
  }

  /** Add a jagged bolt from a to b. `jag` is sideways wander as a share of its length. */
  bolt(a: P, b: P, width: number, jag = 0.18, heat = 1, depth = 4): P[] {
    const pts = [a.clone(), b.clone()];
    const len = a.distanceTo(b);
    let amp = len * jag;
    // long bolts get more kinks so they never read as straight lines
    const levels = Math.min(6, Math.max(depth, Math.ceil(Math.log2(len / 1.5))));
    for (let d = 0; d < levels; d++) {
      for (let i = pts.length - 1; i > 0; i--) {
        const m = pts[i - 1]!.clone().lerp(pts[i]!, 0.4 + Math.random() * 0.2);
        m.x += (Math.random() - 0.5) * amp;
        m.y += (Math.random() - 0.5) * amp;
        m.z += (Math.random() - 0.5) * amp;
        pts.splice(i, 0, m);
      }
      amp *= 0.5;
    }
    for (let i = 1; i < pts.length; i++) {
      // taper toward the tip so the bolt looks like it strikes, not like a tube
      const k = i / pts.length;
      this.segment(pts[i - 1]!, pts[i]!, width * (1 - k * 0.55), heat);
    }
    this.geometry.setDrawRange(0, this.segments * 12);
    return pts;
  }

  /** A bolt with a few forks branching off it. */
  strike(a: P, b: P, width: number, forks = 3, jag = 0.18): void {
    const pts = this.bolt(a, b, width, jag, 1);
    const len = a.distanceTo(b);
    const dir = new THREE.Vector3();
    for (let f = 0; f < forks; f++) {
      const from = pts[1 + Math.floor(Math.random() * (pts.length - 2))]!;
      dir.subVectors(b, a).normalize();
      dir.x += (Math.random() - 0.5) * 1.6;
      dir.y += (Math.random() - 0.5) * 0.8;
      dir.z += (Math.random() - 0.5) * 1.6;
      const to = from.clone().addScaledVector(dir.normalize(), len * (0.15 + Math.random() * 0.2));
      this.bolt(from, to, width * 0.5, 0.3, 0.5, 3);
    }
  }

  private segment(a: P, b: P, w: number, heat: number): void {
    if (this.segments >= MAX_SEGMENTS) return;
    const s = this.segments++;
    const d = new THREE.Vector3().subVectors(b, a);
    // two perpendicular widths, so one ribbon always faces the camera somewhat
    const p1 = new THREE.Vector3().crossVectors(d, Math.abs(d.y) > 0.9 * d.length() ? X : Y).normalize().multiplyScalar(w / 2);
    const p2 = new THREE.Vector3().crossVectors(d, p1).normalize().multiplyScalar(w / 2);
    [p1, p2].forEach((p, q) => {
      const o = (s * 8 + q * 4) * 3;
      this.pos.set([a.x - p.x, a.y - p.y, a.z - p.z, a.x + p.x, a.y + p.y, a.z + p.z, b.x - p.x, b.y - p.y, b.z - p.z, b.x + p.x, b.y + p.y, b.z + p.z], o);
      this.heat.fill(heat, s * 8 + q * 4, s * 8 + q * 4 + 4);
    });
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('heat') as THREE.BufferAttribute).needsUpdate = true;
  }
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
