import * as THREE from 'three/webgpu';
import { attribute, normalLocal, positionLocal, uniform, vec3 } from './tsl';

/*
 * three r186 generates a shader (10-70 ms of main-thread work) for every
 * material whose nodes are separate objects, even when the copies compute the
 * same thing, because each node's id is part of the key; and for every object
 * drawn with `count` above 1 or as an InstancedMesh, because that object's id
 * is too. Measured on Conquest: 47 torches generated 94 shaders and the spell
 * effect pools 124, during loading or, when a pool grows, mid-fight. The
 * helpers here let all copies of an effect draw with one material, and so one
 * shader.
 */

export type UniformValue = number | THREE.Color | THREE.Vector2 | THREE.Vector3 | THREE.Vector4;

/**
 * Uniform nodes for a material every copy shares, each copy drawing with its
 * own values: the object being drawn supplies them through `useUniforms`.
 */
export function objectUniforms<V extends Record<string, UniformValue>>(defaults: V): { [K in keyof V]: any } {
  const nodes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(defaults)) {
    nodes[name] = uniform(value).onObjectUpdate(({ object }: { object: THREE.Object3D }) => (object.userData.uniforms as V | undefined)?.[name]);
  }
  return nodes as { [K in keyof V]: any };
}

/** Has these objects draw with `values` (an object shaped like `objectUniforms`' defaults). */
export function useUniforms(values: object, ...objects: THREE.Object3D[]): void {
  for (const o of objects) o.userData.uniforms = values;
}

let quad: THREE.BufferGeometry | null = null;
const quads = new Map<number, THREE.InstancedBufferGeometry>();

/**
 * Sprite geometry drawn `count` times (the material places each copy by
 * `instanceIndex`). The count lives on the geometry instead of `sprite.count`,
 * so sprites like this share their shader. Pass `own` for a geometry this
 * sprite can add its own per-copy attributes to.
 */
export function spriteQuads(count: number, own = false): THREE.InstancedBufferGeometry {
  let g = own ? undefined : quads.get(count);
  if (!g) {
    quad ??= new THREE.Sprite().geometry;
    g = new THREE.InstancedBufferGeometry();
    g.setIndex(quad.index);
    for (const [name, attribute] of Object.entries(quad.attributes)) g.setAttribute(name, attribute);
    g.instanceCount = count;
    if (!own) quads.set(count, g);
  }
  return g;
}

/** A sprite drawn `count` times; see `spriteQuads`. */
export function instancedSprite(material: THREE.SpriteNodeMaterial, count: number): THREE.Sprite {
  const sprite = new THREE.Sprite(material);
  sprite.geometry = spriteQuads(count);
  return sprite;
}

/**
 * Instancing that lets every mesh drawn in `material` share one shader, unlike
 * InstancedMesh (whose instance matrices three binds into a shader per mesh).
 * Each instance is placed by its geometry's instanced `spot` (x, y, z, scale)
 * and `turn` (cosine and sine of its yaw about +Y) attributes; draw a plain
 * Mesh over an InstancedBufferGeometry. Returns the placed position to build
 * the material's positionNode on: shadow passes copy positionNode, so they
 * place instances too. Normals are turned in the material's own passes.
 */
export function placeInstances(material: THREE.NodeMaterial): any {
  const spot = attribute('spot', 'vec4');
  const turn = attribute('turn', 'vec2');
  const yaw = (v: any) => vec3(v.x.mul(turn.x).add(v.z.mul(turn.y)), v.y, v.z.mul(turn.x).sub(v.x.mul(turn.y)));
  const setup = material.setupPosition;
  material.setupPosition = function (this: THREE.NodeMaterial, builder) {
    normalLocal.assign(yaw(normalLocal));
    return setup.call(this, builder);
  };
  return yaw(positionLocal).mul(spot.w).add(spot.xyz);
}

/** Geometry for `placeInstances`: `source`'s vertices, with room for `count` instances' placement. */
export function placedGeometry(source: THREE.BufferGeometry, count: number): {
  geometry: THREE.InstancedBufferGeometry;
  spot: THREE.InstancedBufferAttribute;
  turn: THREE.InstancedBufferAttribute;
} {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  const spot = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const turn = new THREE.InstancedBufferAttribute(new Float32Array(count * 2), 2).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('spot', spot);
  geometry.setAttribute('turn', turn);
  geometry.instanceCount = count;
  return { geometry, spot, turn };
}
