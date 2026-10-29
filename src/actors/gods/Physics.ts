import * as THREE from 'three/webgpu';
import type { ClothSpec, GodMeta } from './assets';

/** One capsule collider in a bone's space (a == b makes a sphere). */
interface Collider {
  bone: THREE.Object3D;
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  wa: THREE.Vector3;
  wb: THREE.Vector3;
}

/** A simulated sheet: capes, skirt panels, loincloths, hair locks and ribbons. */
class Sheet {
  readonly mesh: THREE.Mesh;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly prev: Float32Array;
  /** Rest point of each particle in its drive bone's space. */
  private readonly local: Float32Array;
  private readonly drive: THREE.Object3D[];
  /** 0..1 pull toward the skinned rest point; 1 = pinned. */
  private readonly stiff: Float32Array;
  private readonly links: Int32Array;
  private readonly rest: Float32Array;
  private readonly target = new THREE.Vector3();
  private readonly geo: THREE.BufferGeometry;
  private initialized = false;

  constructor(
    spec: ClothSpec,
    bones: Map<string, THREE.Bone>,
    bind: (bone: THREE.Bone) => THREE.Matrix4,
    material: THREE.Material,
    private readonly colliders: Collider[],
    private readonly gravity: number,
    private readonly damping: number,
  ) {
    const { rows, cols } = spec;
    this.n = rows * cols;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.local = new Float32Array(this.n * 3);
    this.stiff = new Float32Array(this.n);
    this.drive = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      const p = spec.points[i]!;
      const bone = bones.get(spec.drive[spec.driveIndex[i]!]!.replace(/\./g, ''))!;
      this.drive.push(bone);
      // model (bind) space -> bone space
      v.set(p[0]!, p[1]!, p[2]!).applyMatrix4(bind(bone));
      this.local.set([v.x, v.y, v.z], i * 3);
      this.stiff[i] = spec.stiffness[i]!;
    }
    // structural, shear and bend links
    const links: number[] = [];
    const id = (r: number, c: number) => r * cols + c;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) links.push(id(r, c), id(r, c + 1));
        if (r + 1 < rows) links.push(id(r, c), id(r + 1, c));
        if (r + 1 < rows && c + 1 < cols) links.push(id(r, c), id(r + 1, c + 1), id(r, c + 1), id(r + 1, c));
        if (r + 2 < rows) links.push(id(r, c), id(r + 2, c));
        if (c + 2 < cols) links.push(id(r, c), id(r, c + 2));
      }
    }
    this.links = Int32Array.from(links);
    this.rest = new Float32Array(this.links.length / 2);
    for (let k = 0; k < this.rest.length; k++) {
      const a = spec.points[this.links[k * 2]!]!;
      const b = spec.points[this.links[k * 2 + 1]!]!;
      this.rest[k] = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    const uv = new Float32Array(this.n * 2);
    const color = new Float32Array(this.n * 4);
    for (let i = 0; i < this.n; i++) {
      const u = spec.uvs?.[i];
      uv[i * 2] = u ? u[0]! : (i % cols) / (cols - 1);
      uv[i * 2 + 1] = u ? u[1]! : Math.floor(i / cols) / (rows - 1);
      color[i * 4] = Math.floor(i / cols) / (rows - 1);
      color[i * 4 + 1] = 0.5;
    }
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setAttribute('color', new THREE.BufferAttribute(color, 4));
    const ones = new Float32Array(this.n).fill(1);
    this.geo.setAttribute('_edge', new THREE.BufferAttribute(ones, 1));
    this.geo.setAttribute('_side', new THREE.BufferAttribute(ones.slice(), 1));
    // occlusion: shadowed where the sheet tucks under its belt or collar
    const ao = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) ao[i] = 0.55 + 0.45 * Math.min(1, Math.floor(i / cols) / Math.max(1, (rows - 1) * 0.2));
    this.geo.setAttribute('_ao', new THREE.BufferAttribute(ao, 1));
    const index: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = id(r, c), b = id(r, c + 1), d = id(r + 1, c), e = id(r + 1, c + 1);
        index.push(a, d, b, b, d, e);
      }
    }
    this.geo.setIndex(index);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = spec.name;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  private targetOf(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.local[i * 3]!, this.local[i * 3 + 1]!, this.local[i * 3 + 2]!).applyMatrix4(this.drive[i]!.matrixWorld);
  }

  reset(): void {
    for (let i = 0; i < this.n; i++) {
      this.targetOf(i, this.target);
      this.pos.set([this.target.x, this.target.y, this.target.z], i * 3);
      this.prev.set([this.target.x, this.target.y, this.target.z], i * 3);
    }
    this.initialized = true;
  }

  step(dt: number): void {
    if (!this.initialized) this.reset();
    const p = this.pos;
    const q = this.prev;
    const g = this.gravity * dt * dt;
    const keep = 1 - this.damping;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const x = p[o]!, y = p[o + 1]!, z = p[o + 2]!;
      p[o] = x + (x - q[o]!) * keep;
      p[o + 1] = y + (y - q[o + 1]!) * keep - g;
      p[o + 2] = z + (z - q[o + 2]!) * keep;
      q[o] = x; q[o + 1] = y; q[o + 2] = z;
    }
    for (let it = 0; it < 4; it++) {
      // pull toward the animated rest shape (strong at the pins, loose at the hem)
      for (let i = 0; i < this.n; i++) {
        const s = this.stiff[i]!;
        if (s <= 0) continue;
        this.targetOf(i, this.target);
        const o = i * 3;
        const k = s >= 1 ? 1 : s * 0.5;
        p[o] = p[o]! + (this.target.x - p[o]!) * k;
        p[o + 1] = p[o + 1]! + (this.target.y - p[o + 1]!) * k;
        p[o + 2] = p[o + 2]! + (this.target.z - p[o + 2]!) * k;
      }
      const L = this.links;
      for (let k = 0; k < this.rest.length; k++) {
        const a = L[k * 2]! * 3, b = L[k * 2 + 1]! * 3;
        const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const r = this.rest[k]!;
        // cloth stretches very little but may compress (folds)
        if (d < r * 0.92) {
          const f = ((d - r * 0.92) / d) * 0.5 * 0.3;
          p[a] = p[a]! + dx * f; p[a + 1] = p[a + 1]! + dy * f; p[a + 2] = p[a + 2]! + dz * f;
          p[b] = p[b]! - dx * f; p[b + 1] = p[b + 1]! - dy * f; p[b + 2] = p[b + 2]! - dz * f;
          continue;
        }
        const f = ((d - r) / d) * 0.5;
        const wa = this.stiff[L[k * 2]!]! >= 1 ? 0 : 1;
        const wb = this.stiff[L[k * 2 + 1]!]! >= 1 ? 0 : 1;
        const sum = wa + wb || 1;
        p[a] = p[a]! + dx * f * 2 * wa / sum; p[a + 1] = p[a + 1]! + dy * f * 2 * wa / sum; p[a + 2] = p[a + 2]! + dz * f * 2 * wa / sum;
        p[b] = p[b]! - dx * f * 2 * wb / sum; p[b + 1] = p[b + 1]! - dy * f * 2 * wb / sum; p[b + 2] = p[b + 2]! - dz * f * 2 * wb / sum;
      }
      this.collide();
    }
  }

  private collide(): void {
    const p = this.pos;
    for (const c of this.colliders) {
      const ax = c.wa.x, ay = c.wa.y, az = c.wa.z;
      const ex = c.wb.x - ax, ey = c.wb.y - ay, ez = c.wb.z - az;
      const ee = ex * ex + ey * ey + ez * ez || 1e-9;
      for (let i = 0; i < this.n; i++) {
        if (this.stiff[i]! >= 1) continue;
        const o = i * 3;
        const px = p[o]! - ax, py = p[o + 1]! - ay, pz = p[o + 2]! - az;
        const t = Math.min(1, Math.max(0, (px * ex + py * ey + pz * ez) / ee));
        const dx = px - ex * t, dy = py - ey * t, dz = pz - ez * t;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < c.r * c.r) {
          const d = Math.sqrt(d2) || 1e-6;
          const push = (c.r - d) / d;
          p[o] = p[o]! + dx * push; p[o + 1] = p[o + 1]! + dy * push; p[o + 2] = p[o + 2]! + dz * push;
        }
      }
    }
  }

  /** Copies the particles into the mesh, in the space of `space` (the god's root). */
  write(inverse: THREE.Matrix4): void {
    const attr = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const v = this.target;
    for (let i = 0; i < this.n; i++) {
      v.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!).applyMatrix4(inverse);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    attr.needsUpdate = true;
    this.geo.computeVertexNormals();
  }

  /** Average distance moved by the drive targets since the last step (teleport detection). */
  jumped(): boolean {
    this.targetOf(0, this.target);
    const dx = this.target.x - this.pos[0]!, dy = this.target.y - this.pos[1]!, dz = this.target.z - this.pos[2]!;
    return dx * dx + dy * dy + dz * dz > 4;
  }
}

/**
 * Secondary motion for capes, cloth strips and hair locks: Verlet sheets in
 * world space, pulled toward their animated (skinned) rest shape with a
 * strength that fades from the pinned edge to the hem, colliding with
 * capsules on the body. Runs at a fixed 60 Hz.
 */
export class SecondaryPhysics {
  private readonly sheets: Sheet[] = [];
  private readonly colliders: Collider[] = [];
  private acc = 0;
  private readonly inv = new THREE.Matrix4();

  constructor(
    private readonly root: THREE.Object3D,
    scene: THREE.Object3D,
    meta: GodMeta,
    bones: Map<string, THREE.Bone>,
    materials: Map<string, THREE.Material>,
  ) {
    if (!meta.cloths?.length) return;
    // bind matrices (model -> bone space) from the skinned mesh's skeleton
    let skeleton: THREE.Skeleton | null = null;
    scene.traverse((o) => {
      if (!skeleton && (o as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (o as THREE.SkinnedMesh).skeleton;
    });
    const sk = skeleton as THREE.Skeleton | null;
    if (!sk) return;
    const bind = (bone: THREE.Bone) => sk.boneInverses[sk.bones.indexOf(bone)]!;
    const v = new THREE.Vector3();
    for (const c of meta.colliders ?? []) {
      const bone = bones.get(c.bone.replace(/\./g, ''));
      if (!bone) continue;
      const m = bind(bone);
      this.colliders.push({
        bone, r: c.r,
        a: v.fromArray(c.a).applyMatrix4(m).clone(),
        b: v.fromArray(c.b).applyMatrix4(m).clone(),
        wa: new THREE.Vector3(), wb: new THREE.Vector3(),
      });
    }
    for (const spec of meta.cloths) {
      const mat = materials.get(spec.material) ?? materials.get('default')!;
      const sheet = new Sheet(spec, bones, bind, mat, this.colliders, spec.gravity ?? 9.8, spec.damping ?? 0.03);
      this.sheets.push(sheet);
      root.add(sheet.mesh);
    }
  }

  update(dt: number): void {
    if (!this.sheets.length) return;
    for (const c of this.colliders) {
      c.wa.copy(c.a).applyMatrix4(c.bone.matrixWorld);
      c.wb.copy(c.b).applyMatrix4(c.bone.matrixWorld);
    }
    for (const s of this.sheets) if (s.jumped()) s.reset();
    this.acc = Math.min(this.acc + dt, 3 / 60);
    const h = 1 / 60;
    while (this.acc >= h) {
      for (const s of this.sheets) s.step(h);
      this.acc -= h;
    }
    this.inv.copy(this.root.matrixWorld).invert();
    for (const s of this.sheets) s.write(this.inv);
  }
}
