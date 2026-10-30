import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { objectUniforms, spriteQuads, useUniforms } from './shared';

describe('objectUniforms', () => {
  it('takes each drawn object\'s own values', () => {
    const { age, tint } = objectUniforms({ age: 0, tint: new THREE.Color() });
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    useUniforms({ age: 1, tint: new THREE.Color(1, 0, 0) }, a);
    useUniforms({ age: 2, tint: new THREE.Color(0, 1, 0) }, b);
    age.update({ object: a });
    tint.update({ object: a });
    expect(age.value).toBe(1);
    expect(tint.value.r).toBe(1);
    age.update({ object: b });
    tint.update({ object: b });
    expect(age.value).toBe(2);
    expect(tint.value.g).toBe(1);
  });
});

describe('spriteQuads', () => {
  it('keeps the count on the geometry, shared unless asked for its own', () => {
    const g = spriteQuads(9);
    expect(g.instanceCount).toBe(9);
    expect(spriteQuads(9)).toBe(g);
    const own = spriteQuads(9, true);
    expect(own).not.toBe(g);
    expect(own.getAttribute('position')).toBe(g.getAttribute('position'));
  });
});
