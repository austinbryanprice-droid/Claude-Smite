import * as THREE from 'three/webgpu';
import {
  abs, attribute, float, fract, mix, mx_noise_float, positionWorld, smoothstep, time, uniform, vec3, vec4,
} from '../render/tsl';

export type DecalShape =
  | { type: 'circle'; radius: number }
  | { type: 'ring'; radius: number; width: number }
  | { type: 'rect'; length: number; width: number }
  | { type: 'cone'; range: number; angle: number };

export type DecalStyle = 'telegraph' | 'zone' | 'flash';

const STYLE = { telegraph: 0, zone: 1, flash: 2 } as const;

/**
 * A glowing shape painted on the ground. The mesh is rebuilt in world space
 * and every vertex is dropped onto the terrain, so it hugs steps and slopes
 * instead of clipping into them. Additive and HDR, so it feeds bloom.
 *
 * Shapes are built in local space facing -Z (yaw 0), matching the units.
 */
export class GroundDecal {
  readonly mesh: THREE.Mesh;
  readonly color = uniform(new THREE.Color(1, 1, 1));
  readonly core = uniform(new THREE.Color(1, 1, 1));
  readonly opacity = uniform(1);
  /** 0..1 fill sweep for telegraphs (how charged the cast is). */
  readonly fill = uniform(0);
  private readonly style = uniform(0);
  private local: Float32Array = new Float32Array(0);
  private shapeKey = '';
  private readonly geometry = new THREE.BufferGeometry();

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const edge = attribute('edge', 'float');
    const rim = smoothstep(0.82, 0.98, edge).mul(smoothstep(1.02, 0.97, edge));
    const wp = positionWorld.xz;
    const t = time;
    // Zones: churning energy (two scrolling noise layers) with bright veins.
    const n1 = mx_noise_float(vec3(wp.x.mul(0.45), wp.y.mul(0.45), t.mul(0.7))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(vec3(wp.x.mul(1.3).add(t.mul(0.6)), wp.y.mul(1.3).sub(t.mul(0.4)), t.mul(0.3))).mul(0.5).add(0.5);
    const veins = smoothstep(0.42, 0.5, n1).mul(smoothstep(0.58, 0.5, n1)).mul(2.5);
    const swirl = n1.mul(0.45).add(n2.mul(0.35)).add(veins);
    // Telegraphs: faint fill, a crisp rim, and a pulse sweeping outward.
    const pulse = smoothstep(0.08, 0.0, abs(edge.sub(fract(t.mul(0.9))))).mul(0.6);
    const telegraphFill = float(0.16).add(pulse.mul(edge));
    const charged = smoothstep(this.fill.add(0.02), this.fill, edge).mul(0.25);

    const isZone = smoothstep(0.5, 1.0, this.style).mul(smoothstep(1.5, 1.0, this.style));
    const isFlash = smoothstep(1.5, 2.0, this.style);
    const isTele = float(1).sub(isZone).sub(isFlash);

    const body = isTele.mul(telegraphFill.add(charged)).add(isZone.mul(swirl.mul(0.85))).add(isFlash.mul(float(0.55).add(edge.mul(0.45))));
    const rimStrength = isTele.mul(2.2).add(isZone.mul(3.0)).add(isFlash.mul(2.0));
    const intensity = body.add(rim.mul(rimStrength));
    const hot = mix(this.color, this.core, smoothstep(0.6, 1.4, intensity));
    mat.colorNode = vec4(hot.mul(intensity).mul(3.2).mul(this.opacity), 1);
    mat.opacityNode = this.opacity;


    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.matrixAutoUpdate = false;
  }

  setStyle(style: DecalStyle): void {
    this.style.value = STYLE[style];
  }

  setColors(main: number, core: number): void {
    this.color.value.setHex(main);
    this.core.value.setHex(core);
  }

  /** Place the shape at (x, z) facing `yaw` and conform it to the ground. */
  place(shape: DecalShape, x: number, z: number, yaw: number, lift = 0.07): void {
    this.ensureShape(shape);
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const n = this.local.length / 2;
    for (let i = 0; i < n; i++) {
      const lx = this.local[i * 2]!;
      const lz = this.local[i * 2 + 1]!;
      const wx = x + lx * cos + lz * sin;
      const wz = z - lx * sin + lz * cos;
      arr[i * 3] = wx;
      arr[i * 3 + 1] = this.groundAt(wx, wz) + lift;
      arr[i * 3 + 2] = wz;
    }
    pos.needsUpdate = true;
  }

  private ensureShape(shape: DecalShape): void {
    const key = JSON.stringify(shape);
    if (key === this.shapeKey) return;
    this.shapeKey = key;
    const { local, edge, index } = build(shape);
    this.local = local;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((local.length / 2) * 3), 3));
    this.geometry.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
    this.geometry.setIndex(index);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Local XZ vertices, an edge factor (0 center, 1 outline) and triangles. */
function build(shape: DecalShape): { local: Float32Array; edge: Float32Array; index: number[] } {
  const pts: number[] = [];
  const edge: number[] = [];
  const index: number[] = [];
  const grid = (cols: number, rows: number, at: (u: number, v: number) => [number, number, number]) => {
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const [x, z, e] = at(c / cols, r / rows);
        pts.push(x, z);
        edge.push(e);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + cols + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  };
  switch (shape.type) {
    case 'circle': {
      const rings = Math.max(4, Math.ceil(shape.radius / 0.8));
      grid(Math.max(32, Math.ceil(shape.radius * 10)), rings, (u, v) => {
        const a = u * Math.PI * 2;
        return [Math.sin(a) * v * shape.radius, Math.cos(a) * v * shape.radius, v];
      });
      break;
    }
    case 'ring': {
      const inner = Math.max(0, shape.radius - shape.width);
      grid(Math.max(48, Math.ceil(shape.radius * 6)), 2, (u, v) => {
        const a = u * Math.PI * 2;
        const r = inner + (shape.radius - inner) * v;
        return [Math.sin(a) * r, Math.cos(a) * r, 0.84 + v * 0.16];
      });
      break;
    }
    case 'rect': {
      const rows = Math.max(4, Math.ceil(shape.length / 0.8));
      grid(4, rows, (u, v) => {
        const across = (u - 0.5) * 2;
        const x = (across * shape.width) / 2;
        const z = -v * shape.length;
        // outline on both sides and the far end; the near end stays open
        return [x, z, Math.max(Math.abs(across), v)];
      });
      break;
    }
    case 'cone': {
      const half = (shape.angle * Math.PI) / 360;
      const rings = Math.max(4, Math.ceil(shape.range / 0.8));
      grid(Math.max(12, Math.ceil(shape.angle / 4)), rings, (u, v) => {
        const a = (u - 0.5) * 2 * half;
        const r = v * shape.range;
        return [-Math.sin(a) * r, -Math.cos(a) * r, Math.max(v, Math.abs(u - 0.5) * 2)];
      });
      break;
    }
  }
  return { local: new Float32Array(pts), edge: new Float32Array(edge), index };
}
