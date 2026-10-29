import * as THREE from 'three/webgpu';
import {
  abs, atan, attribute, float, floor, fract, hash, max, mix, mx_noise_float, positionWorld, sign, smoothstep, step, time, uniform, vec3, vec4,
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
 * instead of clipping into them. HDR color, so it feeds bloom.
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
  /** 0..1 shockwave front for flashes, sweeping out from the caster. */
  readonly wave = uniform(1);
  /** 1 draws a ring of slowly turning runes inside a circle's rim (Odin). */
  readonly glyphs = uniform(0);
  private readonly center = uniform(new THREE.Vector2());
  private readonly style = uniform(0);
  private local: Float32Array = new Float32Array(0);
  private shapeKey = '';
  private readonly geometry = new THREE.BufferGeometry();

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const edge = attribute('edge', 'float');
    // 0 at the origin of the shape, 1 at its far end (radius, length or range)
    const along = attribute('along', 'float');
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

    // Flashes: a bright front sweeps outward, leaving a fading wash and crackle behind it.
    const front = smoothstep(0.16, 0.0, abs(along.sub(this.wave))).mul(2.6);
    const behind = smoothstep(this.wave.add(0.02), this.wave.sub(0.05), along);
    const crackle = smoothstep(0.46, 0.5, n2).mul(smoothstep(0.54, 0.5, n2)).mul(1.8);
    const flashBody = front.add(behind.mul(float(0.3).add(crackle).mul(float(1.15).sub(this.wave))));
    const flashRim = behind.mul(rim);

    // Runes: a band of procedural glyphs (staves, branches, ticks) framed by two thin circles.
    const local = wp.sub(this.center);
    const turn = atan(local.x, local.y).div(6.2832).add(0.5).add(t.mul(0.02));
    const cells = turn.mul(22);
    const cell = floor(cells);
    const u = fract(cells);
    const rr = edge.sub(0.7).div(0.16);
    const inBand = step(0, rr).mul(step(rr, 1));
    const h1 = hash(cell);
    const h2 = hash(cell.add(31.7));
    const stroke = (d: any) => smoothstep(0.1, 0.04, abs(d));
    const stave = stroke(u.sub(0.5)).mul(step(0.12, rr)).mul(step(rr, 0.88));
    const branch = stroke(u.sub(0.5).sub(rr.sub(0.5).mul(sign(h1.sub(0.5))).mul(0.7))).mul(step(0.35, h2));
    const tick = stroke(rr.sub(h1.mul(0.5).add(0.25)).mul(1.4)).mul(step(abs(u.sub(0.5)), 0.28)).mul(step(h2, 0.6));
    const frame = stroke(edge.sub(0.68).mul(4)).add(stroke(edge.sub(0.88).mul(4)));
    const runes = max(max(stave, branch), tick).mul(inBand).add(frame.mul(0.6)).mul(this.glyphs).mul(2.4);

    const isZone = smoothstep(0.5, 1.0, this.style).mul(smoothstep(1.5, 1.0, this.style));
    const isFlash = smoothstep(1.5, 2.0, this.style);
    const isTele = float(1).sub(isZone).sub(isFlash);

    const body = isTele.mul(telegraphFill.add(charged)).add(isZone.mul(swirl.mul(1.25))).add(isFlash.mul(flashBody));
    const rimStrength = isTele.mul(2.2).add(isZone.mul(3.0)).add(isFlash.mul(2.0));
    const glyphBody = runes.mul(mix(float(1), behind, isFlash));
    const intensity = glyphBody.add(body).add(rim.mul(rimStrength).mul(float(1).sub(isFlash).add(isFlash.mul(flashRim))));
    // Alpha-blended, not additive: additive light vanishes on the white marble.
    // HDR color (above 1) still feeds bloom so rims and veins glow.
    const hot = mix(this.color, this.core, smoothstep(1.2, 2.6, intensity));
    mat.colorNode = vec4(hot.mul(float(0.9).add(intensity.mul(1.4))), 1);
    mat.opacityNode = intensity.mul(0.75).clamp(0, 0.95).mul(this.opacity);


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
    this.center.value.set(x, z);
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
    const { local, edge, along, index } = build(shape);
    this.local = local;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((local.length / 2) * 3), 3));
    this.geometry.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
    this.geometry.setAttribute('along', new THREE.BufferAttribute(along, 1));
    this.geometry.setIndex(index);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Local XZ vertices, an edge factor (0 center, 1 outline) and triangles. */
function build(shape: DecalShape): { local: Float32Array; edge: Float32Array; along: Float32Array; index: number[] } {
  const pts: number[] = [];
  const edge: number[] = [];
  const along: number[] = [];
  const index: number[] = [];
  // every shape's rows run from its origin (v = 0) to its far end (v = 1)
  const grid = (cols: number, rows: number, at: (u: number, v: number) => [number, number, number]) => {
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const [x, z, e] = at(c / cols, r / rows);
        pts.push(x, z);
        edge.push(e);
        along.push(r / rows);
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
  return { local: new Float32Array(pts), edge: new Float32Array(edge), along: new Float32Array(along), index };
}
