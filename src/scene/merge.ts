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
