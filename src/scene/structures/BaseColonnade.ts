import * as THREE from 'three/webgpu';
import { arcBlock, columnBase, columnCapital, flutedShaft } from '../Architecture';
import type { MaterialLibrary } from '../Materials';
import { agedMarble, mergeStatic, type TeamMaterials } from './common';

/** Columns in the arc, end to end. */
const COLUMNS = 9;
const COLUMN_R = 0.55;
/** Underside of the entablature above the group origin. */
const TOP = 8.4;

/**
 * A curved marble colonnade set into the cliff behind a team's fountain, so
 * the spawn backs onto temple architecture with team banners instead of a
 * bare rock face. Built in fountain space: the fountain is the origin and +Z
 * faces into the base (toward the titan); the arc wraps the -Z side.
 */
export class BaseColonnade {
  readonly group = new THREE.Group();
  /** Column centers in the group's local XZ, for the camera's collision. */
  readonly columns: { x: number; z: number; r: number }[] = [];

  /**
   * @param radius Arc radius from the fountain center.
   * @param span Half the arc's angle, radians.
   * @param ground Ground height relative to the origin at a local (x, z).
   */
  constructor(lib: MaterialLibrary, tm: TeamMaterials, radius: number, span: number, ground: (x: number, z: number) => number) {
    this.group.name = 'base-colonnade';
    const marble = agedMarble(lib);
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    // arcBlock angles run from +X toward +Z, so the back of the fountain is -PI/2
    const start = -Math.PI / 2 - span;
    const len = span * 2;
    const capital = 0.66;
    const shaftTop = TOP - capital;

    for (let i = 0; i < COLUMNS; i++) {
      const a = start + (i / (COLUMNS - 1)) * len;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      // columns stand on whatever ground is there, so ones against the cliff foot sink into it
      const g = Math.min(ground(x, z), 3) - 0.1;
      this.columns.push({ x, z, r: COLUMN_R * 1.35 });
      add(columnBase(COLUMN_R), marble, x, g, z);
      add(flutedShaft(COLUMN_R, shaftTop - (g + 0.6), 20, 64, 6), marble, x, g + 0.6, z);
      add(columnCapital(COLUMN_R), marble, x, shaftTop, z);
    }

    // entablature: architrave, a gilded band facing the fountain, frieze and cornice
    const pad = 0.06;
    add(arcBlock(radius - 0.85, radius + 0.85, 0.9, start - pad, len + pad * 2), marble, 0, TOP);
    add(arcBlock(radius - 0.92, radius - 0.82, 0.16, start - pad, len + pad * 2), tm.trim, 0, TOP + 0.62);
    add(arcBlock(radius - 0.75, radius + 0.75, 0.7, start - pad, len + pad * 2), marble, 0, TOP + 0.9);
    add(arcBlock(radius - 1.05, radius + 1.05, 0.28, start - pad * 1.4, len + pad * 2.8), marble, 0, TOP + 1.6);

    // team banners hanging from the architrave between alternate columns, facing the fountain
    const banners: THREE.Object3D[] = [];
    for (let i = 0; i < COLUMNS - 1; i += 2) {
      const a = start + ((i + 0.5) / (COLUMNS - 1)) * len;
      const r = radius - 0.95;
      const g = new THREE.PlaneGeometry(1.7, 4.6, 4, 12);
      g.translate(0, -2.3, 0);
      const b = add(g, tm.banner, Math.cos(a) * r, TOP + 0.4, Math.sin(a) * r);
      b.rotation.y = Math.atan2(-Math.cos(a), -Math.sin(a));
      b.castShadow = false;
      banners.push(b);
    }
    // banners keep their own meshes: their sway reads positionLocal
    mergeStatic(this.group, banners);
  }
}
