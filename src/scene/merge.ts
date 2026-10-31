import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Layers } from '../render/Layers';
import { turnedVariant } from './Materials';

/**
 * Bakes every mesh under `group` (except the `keep` subtrees) into one mesh
 * per material, cutting a structure's dozens of parts to a handful of draw
 * calls. Call before the group is placed, while its transform is identity.
 */
export function mergeStatic(group: THREE.Object3D, keep: THREE.Object3D[] = []): void {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const kept = new Set<THREE.Object3D>(keep);
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; places: THREE.Matrix4[]; cast: boolean }>();
  const remove: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (kept.has(o)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !Array.isArray(m.material) && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) {
      const place = inv.clone().multiply(m.matrixWorld);
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(place);
      let e = byMat.get(m.material);
      if (!e) byMat.set(m.material, (e = { geos: [], places: [], cast: false }));
      e.geos.push(g);
      e.places.push(place);
      e.cast ||= m.castShadow;
      remove.push(m);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of group.children) visit(c);
  for (const m of remove) m.parent?.remove(m);
  const baked: THREE.Mesh[] = [];
  for (const [mat, { geos, places, cast }] of byMat) {
    const withUv = geos.every((g) => g.getAttribute('uv'));
    for (const g of geos) {
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && !(withUv && name === 'uv')) g.deleteAttribute(name);
      }
    }
    const turned = places.some((p) => !lightsAsIs(p)) ? turnedVariant(mat) : null;
    if (turned) geos.forEach((g, i) => carryTurn(g, places[i]!));
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, turned ?? mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
    baked.push(mesh);
  }
  castAsOne(baked, ['position'], (geometry, material) => {
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    return mesh;
  });
}

const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** True when a part's placement leaves its normals' directions as they are: no rotation, even scale. */
function lightsAsIs(place: THREE.Matrix4): boolean {
  place.decompose(_p, _q, _s);
  return Math.abs(_q.w) > 1 - 1e-7 && Math.abs(_s.x - _s.y) < 1e-6 * _s.x && Math.abs(_s.x - _s.z) < 1e-6 * _s.x;
}

/** Stores a part's rotation and inverse scale on its vertices, for `turnedVariant`. */
function carryTurn(g: THREE.BufferGeometry, place: THREE.Matrix4): void {
  place.decompose(_p, _q, _s);
  const inv = [1 / Math.abs(_s.x), 1 / Math.abs(_s.y), 1 / Math.abs(_s.z)];
  const top = Math.max(...inv);
  const n = g.getAttribute('position').count;
  const turn = new Int8Array(n * 4);
  const scale = new Uint8Array(n * 4);
  const q = [_q.x, _q.y, _q.z, _q.w].map((v) => Math.round(v * 127));
  const s = inv.map((v) => Math.round((v / top) * 255));
  for (let i = 0; i < n; i++) {
    turn.set(q, i * 4);
    scale.set(s, i * 4);
  }
  g.setAttribute('turn', new THREE.BufferAttribute(turn, 4, true));
  g.setAttribute('turnScale', new THREE.BufferAttribute(scale, 4, true));
}

let standIn: THREE.MeshBasicNodeMaterial | null = null;

/** True when a material's shadow is just its mesh's shape: nothing in it moves vertices or cuts holes. */
function plainShadow(m: THREE.Material): boolean {
  const n = m as THREE.NodeMaterial;
  return !m.transparent && m.alphaTest === 0 && !n.alphaTestNode && !n.maskNode && !n.maskShadowNode && !n.positionNode && !n.castShadowNode && !n.castShadowPositionNode;
}

/**
 * Has one mesh cast the shadows of `meshes` (siblings drawn with the same
 * transform), on `Layers.SHADOW_ONLY` so only the shadow cascades draw it:
 * each cascade then draws a structure or a god once instead of once per
 * material. Meshes whose material shapes its shadow (alpha test, moved
 * vertices) keep casting their own. `add` makes the stand-in from a geometry
 * holding `attributes` of the meshes it replaces, and places it; `shared`
 * holds that geometry for models built alike.
 */
function castAsOne(
  meshes: readonly THREE.Mesh[], attributes: readonly string[],
  add: (geometry: THREE.BufferGeometry, material: THREE.Material) => THREE.Mesh, shared?: { geometry?: THREE.BufferGeometry },
): void {
  const list = meshes.filter((m) => m.castShadow && m.visible && plainShadow(m.material as THREE.Material));
  if (list.length < 2) return;
  let geometry = shared?.geometry;
  if (!geometry) {
    // (unindexed front-sided meshes, like baked structures, stay unindexed)
    const indexed = list.some((m) => m.geometry.index || (m.material as THREE.Material).side !== THREE.FrontSide);
    const geos = list.map((m) => {
      const g = new THREE.BufferGeometry();
      for (const name of attributes) g.setAttribute(name, m.geometry.getAttribute(name).clone());
      if (indexed) g.setIndex(frontFaces(m.geometry, (m.material as THREE.Material).side));
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) return;
    geometry = merged;
    if (shared) shared.geometry = geometry;
  }
  standIn ??= new THREE.MeshBasicNodeMaterial({ colorWrite: false });
  const mesh = add(geometry, standIn);
  mesh.name = 'shadow';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.layers.set(Layers.SHADOW_ONLY);
  for (const m of list) m.castShadow = false;
}

/**
 * `geometry`'s triangles wound so that a front-sided mesh casts the shadow a
 * mesh drawn with `side` casts: a shadow pass draws the back faces of a
 * front-sided mesh, the front faces of a back-sided one and both of a
 * double-sided one, so back-sided triangles turn around and double-sided
 * ones go in both ways.
 */
function frontFaces(geometry: THREE.BufferGeometry, side: THREE.Side): number[] {
  const n = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
  const tri: number[] = new Array(n);
  for (let i = 0; i < n; i++) tri[i] = geometry.index ? geometry.index.getX(i) : i;
  if (side === THREE.FrontSide) return tri;
  const flipped: number[] = new Array(n);
  for (let i = 0; i < n; i += 3) {
    flipped[i] = tri[i]!;
    flipped[i + 1] = tri[i + 2]!;
    flipped[i + 2] = tri[i + 1]!;
  }
  return side === THREE.BackSide ? flipped : tri.concat(flipped);
}

/**
 * Has one mesh cast the shadows of `group`'s static meshes, which keep their
 * own transforms and draws (for parts whose materials read their local
 * position, so they can't be baked together). Groups built alike share the
 * stand-in's geometry through `shared`. Call before the group is placed.
 */
export function castStaticAsOne(group: THREE.Object3D, shared?: { geometry?: THREE.BufferGeometry }): void {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const parts: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !Array.isArray(m.material) && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) parts.push(m);
  });
  // stand-ins posed in group space; castAsOne only reads them when it has no shared geometry
  const posed = parts.map((m) => {
    const p = new THREE.Mesh(shared?.geometry ? m.geometry : m.geometry.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)), m.material);
    p.castShadow = m.castShadow;
    p.visible = m.visible;
    return p;
  });
  let made = false;
  castAsOne(posed, ['position'], (geometry, material) => {
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    made = true;
    return mesh;
  }, shared);
  if (made) posed.forEach((p, i) => (parts[i]!.castShadow = p.castShadow));
}

/**
 * Has one skinned mesh cast the shadows of `root`'s skinned meshes that share
 * a parent, transform and skeleton (see `castAsOne`). Models cloned from one
 * source can share the stand-ins' geometry through `shared`.
 */
export function castSkinnedAsOne(root: THREE.Object3D, shared?: Map<string, { geometry?: THREE.BufferGeometry }>): void {
  const groups = new Map<string, THREE.SkinnedMesh[]>();
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || Array.isArray(m.material) || m.morphTargetInfluences) return;
    m.updateMatrix();
    const key = [m.parent!.uuid, m.matrix.elements.join(), m.bindMatrix.elements.join(), m.skeleton.uuid].join('|');
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  });
  for (const list of groups.values()) {
    const first = list[0]!;
    let cache: { geometry?: THREE.BufferGeometry } | undefined;
    if (shared) {
      const key = list.map((m) => m.geometry.uuid + (m.castShadow ? '+' : '-')).join();
      cache = shared.get(key);
      if (!cache) shared.set(key, (cache = {}));
    }
    castAsOne(list, ['position', 'skinIndex', 'skinWeight'], (geometry, material) => {
      const s = new THREE.SkinnedMesh(geometry, material);
      s.position.copy(first.position);
      s.quaternion.copy(first.quaternion);
      s.scale.copy(first.scale);
      s.bind(first.skeleton, first.bindMatrix);
      // cull against all the meshes it stands in for
      for (const m of list) {
        if (!m.boundingSphere && !m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const b = m.boundingSphere ?? m.geometry.boundingSphere!;
        if (s.boundingSphere) s.boundingSphere.union(b);
        else s.boundingSphere = b.clone();
      }
      first.parent!.add(s);
      return s;
    }, cache);
  }
}

const rigidGeometry = new Map<string, THREE.BufferGeometry[]>();
const rigidShadows = new Map<string, { geometry?: THREE.BufferGeometry }>();

/**
 * Turns a rig of rigid parts, posed by moving their pivots, into one skinned
 * mesh per material: each part's vertices follow its parent as a bone, so the
 * whole rig draws in a handful of calls instead of one (plus one per shadow
 * cascade) per part. Parts in `keep` are posed on their own; they become bones
 * themselves and are hidden rather than removed, so code holding them can keep
 * moving them. Vertices are stored in `space` (materials that read
 * `positionGeometry` see that space, as they saw each part's own before), and
 * rigs built the same way share their geometry under `key`. Call right after
 * building, before `root` is placed. `bounds` (in root space) must hold every
 * pose: the merged mesh is culled against it.
 */
export function skinRigid(root: THREE.Object3D, key: string, space: THREE.Object3D, keep: readonly THREE.Object3D[], bounds: THREE.Sphere): void {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const kept = new Set(keep);
  const parts: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && !(m as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(m.material)) parts.push(m);
  });
  const bones: THREE.Object3D[] = [];
  const boneOf = new Map<THREE.Object3D, number>();
  const groups: { material: THREE.Material; cast: boolean; parts: { mesh: THREE.Mesh; bone: number }[] }[] = [];
  for (const mesh of parts) {
    const owner = kept.has(mesh) ? mesh : mesh.parent!;
    let bone = boneOf.get(owner);
    if (bone === undefined) {
      boneOf.set(owner, (bone = bones.length));
      bones.push(owner);
    }
    let g = groups.find((x) => x.material === mesh.material && x.cast === mesh.castShadow);
    if (!g) groups.push((g = { material: mesh.material as THREE.Material, cast: mesh.castShadow, parts: [] }));
    g.parts.push({ mesh, bone });
  }
  let geos = rigidGeometry.get(key);
  if (!geos || geos.length !== groups.length) {
    const fromSpace = space.matrixWorld.clone().invert();
    geos = groups.map((g) => bakeRigid(g.parts, fromSpace));
    rigidGeometry.set(key, geos);
  }
  // any Object3D works as a bone: the skeleton only reads matrixWorld
  const skeleton = new THREE.Skeleton(bones as THREE.Bone[], bones.map((b) => toRoot.clone().multiply(b.matrixWorld).invert()));
  const bindMatrix = toRoot.clone().multiply(space.matrixWorld);
  for (const mesh of parts) {
    if (boneOf.has(mesh)) mesh.visible = false;
    else mesh.removeFromParent();
  }
  const skinned = groups.map((g, i) => {
    const s = new THREE.SkinnedMesh(geos[i], g.material);
    s.castShadow = g.cast;
    s.receiveShadow = true;
    s.bind(skeleton, bindMatrix);
    s.boundingSphere = bounds.clone();
    root.add(s);
    return s;
  });
  let shadows = rigidShadows.get(key);
  if (!shadows) rigidShadows.set(key, (shadows = {}));
  castAsOne(skinned, ['position', 'skinIndex', 'skinWeight'], (geometry, material) => {
    const s = new THREE.SkinnedMesh(geometry, material);
    s.bind(skeleton, bindMatrix);
    s.boundingSphere = bounds.clone();
    root.add(s);
    return s;
  }, shadows);
}

function bakeRigid(parts: readonly { mesh: THREE.Mesh; bone: number }[], fromSpace: THREE.Matrix4): THREE.BufferGeometry {
  const indexed = parts.every((p) => p.mesh.geometry.index);
  const names = parts.every((p) => p.mesh.geometry.getAttribute('uv')) ? ['position', 'normal', 'uv'] : ['position', 'normal'];
  const geos = parts.map(({ mesh, bone }) => {
    const src = mesh.geometry.index && !indexed ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const g = new THREE.BufferGeometry();
    for (const name of names) g.setAttribute(name, src.getAttribute(name).clone());
    if (indexed) g.setIndex(src.index!.clone());
    g.applyMatrix4(fromSpace.clone().multiply(mesh.matrixWorld));
    const n = g.getAttribute('position').count;
    const index = new Uint16Array(n * 4);
    const weight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      index[i * 4] = bone;
      weight[i * 4] = 1;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    return g;
  });
  return mergeGeometries(geos, false)!;
}

/**
 * Merges skinned meshes that share a material, parent, transform, skeleton
 * and vertex layout into one, so a model built from dozens of pieces (armor
 * plates, straps, gems) draws once per material. Models cloned from one
 * source can share the merged geometry through `shared`.
 */
export function mergeSkinned(root: THREE.Object3D, shared?: Map<string, THREE.BufferGeometry>): void {
  const groups = new Map<string, THREE.SkinnedMesh[]>();
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || Array.isArray(m.material) || m.morphTargetInfluences || m.children.length) return;
    const g = m.geometry;
    const layout = Object.entries(g.attributes)
      .map(([name, a]) => `${name}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}`)
      .sort()
      .join();
    const bones = m.skeleton.bones.map((b) => b.uuid).join();
    m.updateMatrix();
    const key = [m.material.uuid, m.parent!.uuid, m.matrix.elements.join(), m.bindMatrix.elements.join(), bones, layout, !!g.index].join('|');
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(m);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const first = list[0]!;
    const key = list.map((m) => m.geometry.uuid).join();
    let merged = shared?.get(key) ?? null;
    if (!merged) {
      const indexed = !!first.geometry.index;
      const geos = list.map((m) => {
        const g = new THREE.BufferGeometry();
        // clone() also de-interleaves, which mergeGeometries needs
        for (const [name, a] of Object.entries(m.geometry.attributes)) g.setAttribute(name, a.clone() as THREE.BufferAttribute);
        if (indexed) g.setIndex(m.geometry.index!.clone());
        return g;
      });
      merged = mergeGeometries(geos, false);
      if (!merged) continue;
      shared?.set(key, merged);
    }
    const out = new THREE.SkinnedMesh(merged, first.material);
    out.name = first.name;
    out.position.copy(first.position);
    out.quaternion.copy(first.quaternion);
    out.scale.copy(first.scale);
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.bind(first.skeleton, first.bindMatrix);
    // cull against all the meshes it replaces
    if (list.every((m) => m.boundingSphere)) {
      out.boundingSphere = first.boundingSphere!.clone();
      for (const m of list) out.boundingSphere.union(m.boundingSphere!);
    }
    first.parent!.add(out);
    for (const m of list) m.removeFromParent();
  }
}

/**
 * Packs a geometry's per-vertex scalars (float attributes of one value each)
 * into one interleaved vertex buffer. WebGPU allows only 8 vertex buffers per
 * draw, as most GPUs offer no more: past that a pipeline fails and the mesh
 * silently never draws (WebGL allows 16, so it looks fine there). The
 * attributes keep their names, so materials read them unchanged.
 */
export function packScalars(geo: THREE.BufferGeometry): void {
  const names = Object.keys(geo.attributes).filter((n) => {
    const a = geo.getAttribute(n) as THREE.BufferAttribute;
    return a.itemSize === 1 && !(a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !(a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute && a.array instanceof Float32Array;
  });
  if (names.length < 2) return;
  const count = geo.getAttribute('position').count;
  const stride = names.length;
  const data = new Float32Array(count * stride);
  names.forEach((n, k) => {
    const src = geo.getAttribute(n).array as Float32Array;
    for (let i = 0; i < count; i++) data[i * stride + k] = src[i]!;
  });
  const buffer = new THREE.InterleavedBuffer(data, stride);
  names.forEach((n, k) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buffer, 1, k)));
}
