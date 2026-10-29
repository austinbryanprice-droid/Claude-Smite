import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, simplex2 } from '../core/random';

/**
 * Geometry builders for the temple's classical architecture. Everything is
 * generated, so there are no model files to license, and every edge is
 * beveled so it catches the light the way scanned stone does.
 */

/** Doric-style fluted shaft with entasis (a subtle swelling in the middle). */
export function flutedShaft(radius: number, height: number, flutes = 20, radialSegments = 120, heightSegments = 28): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, height, radialSegments, heightSegments, true);
  geo.translate(0, height / 2, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = v.y / height;
    const theta = Math.atan2(v.z, v.x);
    const entasis = 1 + 0.035 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - 0.12 * t;
    // scalloped flutes meeting in sharp arrises
    const f = Math.abs(Math.sin((theta * flutes) / 2));
    const flute = 1 - 0.05 * Math.pow(f, 0.6);
    const r = radius * entasis * flute;
    pos.setXYZ(i, Math.cos(theta) * r, v.y, Math.sin(theta) * r);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Profile-turned (lathe) geometry from (radius, height) pairs. */
export function lathe(points: [number, number][], segments = 64): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  g.computeVertexNormals();
  return g;
}

/** Column base: square plinth plus torus moldings. Height ~0.55. */
export function columnBase(radius: number): THREE.BufferGeometry {
  const plinth = roundedBox(radius * 2.7, 0.3, radius * 2.7, 0.04);
  plinth.translate(0, 0.15, 0);
  const r = radius;
  const moldings = lathe([
    [0, 0.3], [r * 1.22, 0.3], [r * 1.28, 0.34], [r * 1.3, 0.4], [r * 1.26, 0.46], [r * 1.12, 0.48],
    [r * 1.08, 0.5], [r * 1.12, 0.53], [r * 1.1, 0.56], [r * 1.02, 0.58], [r, 0.6], [0, 0.6],
  ], 72);
  return merge([plinth, moldings]);
}

/** Doric capital: echinus cushion and square abacus. */
export function columnCapital(radius: number): THREE.BufferGeometry {
  const r = radius * 0.88;
  const echinus = lathe([
    [0, 0], [r, 0], [r * 1.02, 0.05], [r, 0.09], [r * 1.05, 0.12], [r * 1.25, 0.22], [r * 1.42, 0.34], [r * 1.48, 0.4], [0, 0.4],
  ], 72);
  const abacus = roundedBox(r * 3.1, 0.26, r * 3.1, 0.03);
  abacus.translate(0, 0.53, 0);
  return merge([echinus, abacus]);
}

/** Jagged, broken top cap for a ruined column. */
export function brokenCap(radius: number, seed: number): THREE.BufferGeometry {
  const n = simplex2(seed);
  const geo = new THREE.CircleGeometry(radius * 0.97, 48, 0, Math.PI * 2);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const tilt = new THREE.Vector2(n(0.3, 0.7), n(1.1, 4.2)).multiplyScalar(0.25);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const rr = Math.hypot(x, z) / radius;
    const jag = n(x * 3.1, z * 3.1) * 0.12 + n(x * 9, z * 9) * 0.04;
    pos.setY(i, x * tilt.x + z * tilt.y + jag * (0.3 + rr));
  }
  geo.computeVertexNormals();
  return geo;
}

/** Shaft whose top rim follows a broken profile matching `brokenCap`. */
export function brokenShaft(radius: number, height: number, seed: number): THREE.BufferGeometry {
  // four vertices per flute and a few rings are plenty: only the top edge is broken
  const geo = flutedShaft(radius, height, 20, 80, 6);
  const n = simplex2(seed);
  const tilt = new THREE.Vector2(n(0.3, 0.7), n(1.1, 4.2)).multiplyScalar(0.25);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > height - 1e-3) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const jag = n(x * 3.1, z * 3.1) * 0.12 + n(x * 9, z * 9) * 0.04;
      pos.setY(i, y + x * tilt.x + z * tilt.y + jag * 1.3);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

export function roundedBox(w: number, h: number, d: number, radius: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, 6, 4, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const hx = w / 2 - radius;
  const hy = h / 2 - radius;
  const hz = d / 2 - radius;
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    const dir = v.clone().sub(c);
    if (dir.lengthSq() > 1e-10) dir.normalize().multiplyScalar(radius);
    pos.setXYZ(i, c.x + dir.x, c.y + dir.y, c.z + dir.z);
  }
  const merged = mergeVertices(geo.deleteAttribute('normal').deleteAttribute('uv'), 1e-4);
  merged.computeVertexNormals();
  return merged;
}

/**
 * A weathered stone block: rounded box with chipped corners and noise
 * displacement so no two blocks look machine-cut.
 */
export function chippedBlock(
  w: number, h: number, d: number, seed: number, roughness = 0.035, segments: [number, number, number] = [8, 5, 6],
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, ...segments);
  const n = simplex2(seed);
  const rand = rng(seed);
  const r = Math.min(w, h, d) * 0.12;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  const hz = d / 2 - r;
  // a couple of big chips on random corners
  const chips = Array.from({ length: 2 }, () => new THREE.Vector3(
    (rand() < 0.5 ? -1 : 1) * w / 2, (rand() < 0.5 ? -1 : 1) * h / 2, (rand() < 0.5 ? -1 : 1) * d / 2,
  ));
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    const dir = v.clone().sub(c);
    if (dir.lengthSq() > 1e-10) dir.normalize().multiplyScalar(r);
    v.copy(c).add(dir);
    const nn = n(v.x * 2.3 + v.y * 1.7, v.z * 2.3 - v.y * 1.1) * roughness + n(v.x * 7, v.z * 7 + v.y * 5) * roughness * 0.35;
    const len = v.length();
    v.multiplyScalar((len + nn) / len);
    for (const ch of chips) {
      const dd = v.distanceTo(ch);
      const rad = Math.min(w, h, d) * 0.45;
      if (dd < rad) v.lerp(c, ((rad - dd) / rad) * 0.5);
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const merged = mergeVertices(geo.deleteAttribute('normal').deleteAttribute('uv'), 1e-4);
  merged.computeVertexNormals();
  return merged;
}

/** Natural boulder: noise-displaced icosphere, flattened at the bottom. */
export function boulder(radius: number, seed: number, detail = 4): THREE.BufferGeometry {
  const geo = mergeVertices(new THREE.IcosahedronGeometry(radius, detail).deleteAttribute('normal').deleteAttribute('uv'));
  const n = simplex2(seed);
  const rand = rng(seed);
  const squash = 0.55 + rand() * 0.35;
  const stretch = 0.8 + rand() * 0.5;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).divideScalar(radius);
    let d = 1;
    d += n(v.x * 1.2 + v.y, v.z * 1.2 - v.y) * 0.22;
    d += n(v.x * 3 + 10, v.z * 3 + v.y * 2) * 0.08;
    d += Math.abs(n(v.x * 6 + 3, v.y * 6 + v.z * 3)) * -0.05;
    // planar facets like fractured rock
    const facet = Math.max(Math.abs(v.x * 0.9 + v.y * 0.3), Math.abs(v.z * 0.8 - v.y * 0.4), Math.abs(v.y)) * 0.18;
    d -= facet;
    v.multiplyScalar(d * radius);
    v.x *= stretch;
    v.y *= squash;
    if (v.y < -radius * 0.25) v.y = -radius * 0.25 + (v.y + radius * 0.25) * 0.2;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Annular sector extruded vertically (curved architrave / wall segment).
 * Angles follow the arena convention: a point at angle a is (r cos a, r sin a) in XZ.
 */
export function arcBlock(innerR: number, outerR: number, height: number, start: number, length: number, bevel = 0.04): THREE.BufferGeometry {
  // The shape is drawn in XY and rotated so +Y maps to -Z, hence the negated angles.
  const a0 = -(start + length);
  const a1 = -start;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR - bevel, a0, a1, false);
  shape.absarc(0, 0, innerR + bevel, a1, a0, true);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: Math.max(8, Math.round(length * 40)),
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  geo.computeVertexNormals();
  return geo;
}

export function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = geos.map((g) => {
    let x = g;
    for (const name of Object.keys(x.attributes)) if (name !== 'position' && name !== 'normal') x.deleteAttribute(name);
    if (!x.index) x = mergeVertices(x, 1e-5);
    return x;
  });
  const m = mergeGeometries(clean, false);
  if (!m) throw new Error('merge failed');
  return m;
}
