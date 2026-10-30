import type * as THREE from 'three/webgpu';

interface NodeBuilderLike {
  getUniformBufferLimit(): number;
}

/**
 * Makes every instanced or skinned mesh with the same material share one shader.
 *
 * three puts small instance-matrix and bone arrays in a uniform buffer named
 * after that mesh, so each mesh (each foliage chunk, prop batch, god model and
 * so on) compiled its own shader: hundreds of extra shaders at load, and more
 * whenever a new god appeared. Reading them from instanced vertex attributes and
 * a bone texture instead (three's path for large arrays) keeps the shader code
 * identical from mesh to mesh.
 */
export function shareShaders(renderer: THREE.WebGPURenderer): void {
  const backend = renderer.backend as unknown as { createNodeBuilder?(object: THREE.Object3D, renderer: unknown): NodeBuilderLike };
  const create = backend.createNodeBuilder?.bind(backend);
  if (!create) return;
  backend.createNodeBuilder = (object, r) => {
    const builder = create(object, r);
    if ((object as THREE.InstancedMesh).isInstancedMesh || (object as THREE.SkinnedMesh).isSkinnedMesh) builder.getUniformBufferLimit = () => 0;
    return builder;
  };
}
