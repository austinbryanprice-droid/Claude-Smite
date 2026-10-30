import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Bakes every mesh under `group` (except the `keep` subtrees) into one mesh
 * per material, cutting a structure's dozens of parts to a handful of draw
 * calls. Call before the group is placed, while its transform is identity.
 */
export function mergeStatic(group: THREE.Object3D, keep: THREE.Object3D[] = []): void {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const kept = new Set<THREE.Object3D>(keep);
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean }>();
  const remove: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (kept.has(o)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !Array.isArray(m.material) && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh) {
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(inv.clone().multiply(m.matrixWorld));
      let e = byMat.get(m.material);
      if (!e) byMat.set(m.material, (e = { geos: [], cast: false }));
      e.geos.push(g);
      e.cast ||= m.castShadow;
      remove.push(m);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of group.children) visit(c);
  for (const m of remove) m.parent?.remove(m);
  for (const [mat, { geos, cast }] of byMat) {
    const withUv = geos.every((g) => g.getAttribute('uv'));
    for (const g of geos) {
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && !(withUv && name === 'uv')) g.deleteAttribute(name);
      }
    }
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

const rigidGeometry = new Map<string, THREE.BufferGeometry[]>();

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
  groups.forEach((g, i) => {
    const s = new THREE.SkinnedMesh(geos[i], g.material);
    s.castShadow = g.cast;
    s.receiveShadow = true;
    s.bind(skeleton, bindMatrix);
    s.boundingSphere = bounds.clone();
    root.add(s);
  });
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
 * Merges skinned meshes that share a material (by name), parent, transform,
 * skeleton and vertex layout into one, so a model built from dozens of pieces
 * (armor plates, straps, gems) draws once per material.
 */
export function mergeSkinned(root: THREE.Object3D): void {
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
    const key = [m.material.name, m.parent!.uuid, m.matrix.elements.join(), m.bindMatrix.elements.join(), bones, layout, !!g.index].join('|');
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(m);
  });
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const first = list[0]!;
    const indexed = !!first.geometry.index;
    const geos = list.map((m) => {
      const g = new THREE.BufferGeometry();
      // clone() also de-interleaves, which mergeGeometries needs
      for (const [name, a] of Object.entries(m.geometry.attributes)) g.setAttribute(name, a.clone() as THREE.BufferAttribute);
      if (indexed) g.setIndex(m.geometry.index!.clone());
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const out = new THREE.SkinnedMesh(merged, first.material);
    out.name = first.name;
    out.position.copy(first.position);
    out.quaternion.copy(first.quaternion);
    out.scale.copy(first.scale);
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.bind(first.skeleton, first.bindMatrix);
    first.parent!.add(out);
    for (const m of list) m.removeFromParent();
  }
}
