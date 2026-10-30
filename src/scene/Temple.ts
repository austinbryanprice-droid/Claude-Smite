import * as THREE from 'three/webgpu';
import { rng } from '../core/random';
import { Arena } from './ArenaLayout';
import {
  arcBlock, boulder, brokenCap, brokenShaft, chippedBlock, columnBase, columnCapital, flutedShaft, lathe, roundedBox,
} from './Architecture';
import type { CollisionWorld } from './Collision';
import { Fire, Relic } from './Effects';
import type { MaterialLibrary } from './Materials';
import type { Terrain } from './Terrain';
import type { MapContent } from './World';
import { hypot } from '../core/math';

/**
 * The ruined temple at the center of the arena: a stepped circular platform,
 * a ring of fluted marble columns (some fallen), a curved architrave over the
 * intact span, the floating relic, gateways over both lanes, ruined lane
 * walls, braziers and scattered boulders.
 */
export class Temple implements MapContent {
  readonly group = new THREE.Group();
  readonly fires: Fire[] = [];
  readonly spawn = Arena.spawn;
  readonly groundColor = new THREE.Color(0.16, 0.17, 0.09);
  readonly relic: Relic;

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly terrain: Terrain,
    private readonly collision: CollisionWorld,
  ) {
    this.group.name = 'temple';
    this.buildPlatform();
    this.buildColumns();
    this.relic = this.buildCenter();
    this.buildGates();
    this.buildLaneWalls();
    this.buildBraziers();
    this.buildBoulders();
  }

  private add(mesh: THREE.Mesh, cast = true): THREE.Mesh {
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private buildPlatform(): void {
    const p = Arena.plaza;
    // Stepped stylobate as one turned profile with small bevels on each nosing.
    const pts: [number, number][] = [[0, -0.6], [p.baseRadius + 0.1, -0.6]];
    for (let i = 0; i < p.stepCount; i++) {
      const r = p.baseRadius - i * p.stepDepth;
      const y = (i + 1) * p.stepHeight;
      pts.push([r, y - p.stepHeight], [r, y - 0.04], [r - 0.03, y - 0.01], [r - 0.06, y]);
      if (i === p.stepCount - 1) pts.push([0, y]);
    }
    const steps = this.add(new THREE.Mesh(lathe(pts, 160), this.mats.marble), false);
    steps.name = 'stylobate';

    // Flagstone floor on top, slightly inset, plus a marble ring border.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(p.radius - 0.9, 96).rotateX(-Math.PI / 2), this.mats.flagstone);
    floor.position.y = p.topY + 0.004;
    this.add(floor, false);

    this.collision.addSurface((x, z) => {
      const r = hypot(x, z);
      if (r > p.baseRadius) return null;
      const step = Math.min(p.stepCount, Math.floor((p.baseRadius - r) / p.stepDepth) + 1);
      return step * p.stepHeight;
    });
  }

  private buildColumns(): void {
    const p = Arena.plaza;
    const R = p.columnRadius;
    const baseGeo = columnBase(R);
    const capGeo = columnCapital(R);
    const shaftH = p.columnHeight - 0.6 - 0.66;
    const shaftGeo = flutedShaft(R, shaftH);
    const random = rng(77);
    // Indices of standing columns that still carry the architrave (north-east arc).
    const intact = new Set([0, 1, 2, 11, 12, 13]);
    const fallenAt = new Set([7]);
    const y0 = p.topY;
    for (let i = 0; i < p.columnCount; i++) {
      // Leave gaps where the lanes cross the ring (north and south).
      const a = (i / p.columnCount) * Math.PI * 2 + Math.PI / p.columnCount;
      const x = Math.cos(a) * p.columnRing;
      const z = Math.sin(a) * p.columnRing;
      if (Math.abs(Math.cos(a)) < 0.12) continue;
      const base = this.add(new THREE.Mesh(baseGeo, this.mats.marble));
      base.position.set(x, y0, z);
      base.rotation.y = -a;
      this.collision.addCircle(x, z, R * 1.35, y0 + 0.6);

      if (fallenAt.has(i)) {
        // Toppled column: drums lying across the platform edge.
        this.buildFallenColumn(x, z, a, R, random);
        continue;
      }
      if (intact.has(i)) {
        const shaft = this.add(new THREE.Mesh(shaftGeo, this.mats.marble));
        shaft.position.set(x, y0 + 0.6, z);
        shaft.rotation.y = random() * Math.PI;
        const cap = this.add(new THREE.Mesh(capGeo, this.mats.marble));
        cap.position.set(x, y0 + 0.6 + shaftH, z);
        cap.rotation.y = -a;
        this.collision.addCircle(x, z, R * 1.1);
      } else {
        const h = shaftH * (0.25 + random() * 0.45);
        const seed = 100 + i;
        const shaft = this.add(new THREE.Mesh(brokenShaft(R, h, seed), this.mats.marble));
        shaft.position.set(x, y0 + 0.6, z);
        const top = this.add(new THREE.Mesh(brokenCap(R * (1 - 0.12 * (h / shaftH)), seed), this.mats.marble));
        top.position.set(x, y0 + 0.6 + h, z);
        this.collision.addCircle(x, z, R * 1.1);
        this.scatterRubble(x * 1.12, z * 1.12, 5, random, y0);
      }
    }

    // Curved architrave across the intact columns (two spans either side of the east gap).
    const topY = y0 + p.columnHeight;
    const ring = p.columnRing;
    const spans: [number, number][] = [[-1.19, 2.38]];
    for (const [start, len] of spans) {
      const arch = this.add(new THREE.Mesh(arcBlock(ring - 0.75, ring + 0.75, 0.85, start, len, 0.05), this.mats.marble));
      arch.position.y = topY;
      const cornice = this.add(new THREE.Mesh(arcBlock(ring - 0.95, ring + 0.95, 0.32, start - 0.01, len + 0.02, 0.04), this.mats.marble));
      cornice.position.y = topY + 0.85;
    }
  }

  private buildFallenColumn(x: number, z: number, a: number, R: number, random: () => number): void {
    const drumH = 1.4;
    const drum = flutedShaft(R, drumH, 20, 96, 6);
    const dirOut = new THREE.Vector2(Math.cos(a), Math.sin(a));
    const tangent = new THREE.Vector2(-dirOut.y, dirOut.x);
    for (let k = 0; k < 4; k++) {
      const dist = 1.2 + k * (drumH + 0.15) + random() * 0.3;
      const px = x + dirOut.x * dist + tangent.x * (random() - 0.5) * 0.8;
      const pz = z + dirOut.y * dist + tangent.y * (random() - 0.5) * 0.8;
      const ground = this.collision.groundAt(px, pz);
      const m = this.add(new THREE.Mesh(drum, this.mats.marble));
      m.position.set(px, ground + R * 0.92, pz);
      // lie the drum on its side, roughly pointing outward
      m.rotation.set(0, -a + (random() - 0.5) * 0.6, Math.PI / 2);
      m.translateY(-drumH / 2);
      this.collision.addCircle(px, pz, R * 1.05, ground + R * 2);
    }
  }

  private scatterRubble(cx: number, cz: number, count: number, random: () => number, minY: number): void {
    for (let i = 0; i < count; i++) {
      const s = 0.18 + random() * 0.35;
      const geo = chippedBlock(s * (1 + random()), s * 0.7, s * (1 + random() * 0.6), 500 + Math.floor(random() * 1e5), 0.03);
      const m = this.add(new THREE.Mesh(geo, this.mats.marble));
      const x = cx + (random() - 0.5) * 3;
      const z = cz + (random() - 0.5) * 3;
      m.position.set(x, Math.max(minY, this.collision.groundAt(x, z)) + s * 0.25, z);
      m.rotation.set(random() * 0.6, random() * Math.PI, random() * 0.6);
    }
  }

  private buildCenter(): Relic {
    const y0 = Arena.plaza.topY;
    // Round dais with two tiers.
    const dais = this.add(new THREE.Mesh(lathe([
      [0, 0], [3.6, 0], [3.6, 0.22], [3.55, 0.26], [2.9, 0.26], [2.9, 0.5], [2.85, 0.54], [0, 0.54],
    ], 96), this.mats.marble));
    dais.position.y = y0;
    // Pedestal the relic hovers over.
    const ped = this.add(new THREE.Mesh(lathe([
      [0, 0], [0.9, 0], [0.9, 0.12], [0.7, 0.2], [0.55, 0.3], [0.5, 1.0], [0.62, 1.08], [0.8, 1.18], [0.8, 1.26], [0, 1.26],
    ], 64), this.mats.gold));
    ped.position.y = y0 + 0.54;
    this.collision.addSurface((x, z) => {
      const r = hypot(x, z);
      if (r < 2.9) return y0 + 0.5;
      if (r < 3.6) return y0 + 0.22;
      return null;
    });
    this.collision.addCircle(0, 0, 0.95);
    const relic = new Relic(new THREE.Vector3(0, y0 + 0.54, 0));
    this.group.add(relic.group);
    return relic;
  }

  /** Monumental gateways where each lane meets the temple. */
  private buildGates(): void {
    const p = Arena.plaza;
    for (const side of [-1, 1]) {
      const z = side * (p.baseRadius + 4.5);
      let top = -Infinity;
      for (const sx of [-1, 1]) {
        const x = sx * 5.4;
        const ground = this.terrain.heightAt(x, z);
        const random = rng(900 + side * 10 + sx);
        // pillar of stacked blocks
        let y = ground - 0.1;
        const courses = 6;
        for (let c = 0; c < courses; c++) {
          const h = 0.95 + random() * 0.15;
          const w = 1.9 - c * 0.04;
          const block = this.add(new THREE.Mesh(chippedBlock(w, h, 1.9 - c * 0.04, 1000 + c * 13 + side * 7 + sx * 3), this.mats.sandstone));
          block.position.set(x + (random() - 0.5) * 0.05, y + h / 2, z + (random() - 0.5) * 0.05);
          block.rotation.y = (random() - 0.5) * 0.04;
          y += h;
        }
        top = Math.max(top, y);
        this.collision.addBox(x, z, 1.0, 1.0, 0);
      }
      // lintel (north gate is intact, south gate's lintel has fallen)
      if (side < 0) {
        const lintel = this.add(new THREE.Mesh(chippedBlock(13.2, 1.2, 2.1, 2000), this.mats.sandstone));
        lintel.position.set(0, top + 0.6, z);
        const crown = this.add(new THREE.Mesh(roundedBox(14, 0.35, 2.5, 0.05), this.mats.marble));
        crown.position.set(0, top + 1.38, z);
      } else {
        const lintel = this.add(new THREE.Mesh(chippedBlock(6.5, 1.2, 2.0, 2001), this.mats.sandstone));
        const gx = 7.6;
        const gz = z + 2.5;
        const g = this.terrain.heightAt(gx, gz);
        lintel.position.set(gx, g + 0.5, gz);
        lintel.rotation.set(0.05, 0.5, 0.18);
        this.collision.addBox(gx, gz, 3.3, 1.1, 0.5, g + 1.2);
        const piece = this.add(new THREE.Mesh(chippedBlock(5.5, 1.15, 2.0, 2002), this.mats.sandstone));
        piece.position.set(-8.4, this.terrain.heightAt(-8.4, z + 1.6) + 0.45, z + 1.6);
        piece.rotation.set(-0.08, -0.35, -0.12);
        this.collision.addBox(-8.4, z + 1.6, 2.8, 1.1, -0.35, g + 1.2);
      }
    }
  }

  /** Low ruined sandstone walls lining both lanes, with gaps and tumbled blocks. */
  private buildLaneWalls(): void {
    const random = rng(321);
    const blockGeos = Array.from({ length: 6 }, (_, i) => chippedBlock(1.5, 0.75, 0.85, 3000 + i));
    const counts = new Map<THREE.BufferGeometry, THREE.Matrix4[]>();
    const push = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
      const list = counts.get(g) ?? [];
      list.push(m);
      counts.set(g, list);
    };
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const lane of Arena.lanes) {
      const dirZ = Math.sign(lane.to[1]);
      for (const sx of [-1, 1]) {
        const x = sx * (lane.width / 2 + 1.6);
        let z = (Arena.plaza.baseRadius + 9) * dirZ;
        const end = (Arena.valleyRadius + 6) * dirZ;
        while (Math.abs(z) < Math.abs(end)) {
          const segLen = 8 + random() * 10;
          const gap = 3 + random() * 5;
          const courses = 1 + Math.floor(random() * 3.2);
          for (let s = 0; s < segLen; s += 1.55) {
            const wz = z + s * dirZ;
            const ground = this.terrain.heightAt(x, wz);
            const height = Math.max(1, Math.round(courses - (random() < 0.3 ? 1 : 0) - Math.abs(Math.sin(s * 0.7)) * 0.6));
            for (let c = 0; c < height; c++) {
              const g = blockGeos[Math.floor(random() * blockGeos.length)]!;
              e.set((random() - 0.5) * 0.03, Math.PI / 2 + (random() - 0.5) * 0.06, (random() - 0.5) * 0.03);
              q.setFromEuler(e);
              const m = new THREE.Matrix4().compose(
                new THREE.Vector3(x + (random() - 0.5) * 0.08, ground - 0.08 + 0.375 + c * 0.76, wz + ((c % 2) * 0.75 * dirZ)),
                q,
                new THREE.Vector3(1, 1, 1),
              );
              push(g, m);
            }
            this.collision.addBox(x, wz + 0.75 * dirZ, 0.5, 0.85, 0, ground + height * 0.76);
          }
          // a tumbled block or two in front of the wall
          if (random() < 0.7) {
            const g = blockGeos[Math.floor(random() * blockGeos.length)]!;
            const tz = z + (segLen + gap * 0.5) * dirZ;
            const tx = x - sx * (0.8 + random() * 1.0);
            e.set(random() * 0.5, random() * Math.PI, random() * 0.5);
            q.setFromEuler(e);
            push(g, new THREE.Matrix4().compose(new THREE.Vector3(tx, this.terrain.heightAt(tx, tz) + 0.25, tz), q, new THREE.Vector3(1, 1, 1)));
            this.collision.addCircle(tx, tz, 0.75, this.terrain.heightAt(tx, tz) + 0.6);
          }
          z += (segLen + gap) * dirZ;
        }
      }
    }
    for (const [g, list] of counts) {
      const inst = new THREE.InstancedMesh(g, this.mats.sandstone, list.length);
      list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      this.group.add(inst);
    }
  }

  private buildBraziers(): void {
    const bowl = lathe([
      [0, 0], [0.22, 0], [0.25, 0.05], [0.12, 0.1], [0.1, 0.55], [0.18, 0.62], [0.55, 0.72], [0.72, 0.9],
      [0.76, 1.0], [0.7, 1.02], [0.52, 0.86], [0, 0.82],
    ], 48);
    const plinth = chippedBlock(1.1, 0.7, 1.1, 4000);
    const coals = new THREE.MeshStandardNodeMaterial({ color: 0x1a0d08, roughness: 0.9, emissive: new THREE.Color(0xff3b0a), emissiveIntensity: 2.2 });
    const coalGeo = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.25, 1);
    const spots: THREE.Vector2[] = [];
    for (const lane of Arena.lanes) {
      const dirZ = Math.sign(lane.to[1]);
      for (const sx of [-1, 1]) {
        for (const d of [Arena.plaza.baseRadius + 7.5, Arena.plaza.baseRadius + 30]) spots.push(new THREE.Vector2(sx * (lane.width / 2 + 0.2), d * dirZ));
      }
    }
    // four braziers on the platform between the columns
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      spots.push(new THREE.Vector2(Math.cos(a) * 9.5, Math.sin(a) * 9.5));
    }
    spots.forEach((s, i) => {
      const ground = this.collision.groundAt(s.x, s.y);
      const pl = this.add(new THREE.Mesh(plinth, this.mats.sandstone));
      pl.position.set(s.x, ground + 0.3, s.y);
      const b = this.add(new THREE.Mesh(bowl, this.mats.bronze));
      b.position.set(s.x, ground + 0.65, s.y);
      const c = new THREE.Mesh(coalGeo, coals);
      c.position.set(s.x, ground + 0.65 + 0.84, s.y);
      this.group.add(c);
      const fire = new Fire(new THREE.Vector3(s.x, ground + 1.5, s.y), 0.9, i * 7.3, 18);
      this.group.add(fire.group);
      this.fires.push(fire);
      this.collision.addCircle(s.x, s.y, 0.75);
    });
  }

  private buildBoulders(): void {
    const random = rng(555);
    const geos = Array.from({ length: 8 }, (_, i) => boulder(1, 6000 + i * 17, 4));
    let placed = 0;
    for (let tries = 0; tries < 600 && placed < 70; tries++) {
      const a = random() * Math.PI * 2;
      const r = 24 + random() * (Arena.valleyRadius + 10 - 24);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < 9 && Math.abs(z) > 18) continue; // keep lanes clear
      const m = this.terrain.maskAt(x, z);
      if (m.dirt > 0.4 || m.paved > 0.1) continue;
      const scale = r > Arena.valleyRadius - 6 ? 1.6 + random() * 3.2 : 0.4 + random() * 1.4;
      const g = geos[Math.floor(random() * geos.length)]!;
      const mesh = this.add(new THREE.Mesh(g, this.mats.rock));
      const y = this.terrain.heightAt(x, z);
      mesh.position.set(x, y + scale * 0.12, z);
      mesh.scale.set(scale, scale * (0.7 + random() * 0.5), scale);
      mesh.rotation.y = random() * Math.PI * 2;
      if (scale > 0.7) this.collision.addCircle(x, z, scale * 0.85, y + scale * 0.6);
      placed++;
    }
  }

  update(_dt: number, time: number): void {
    for (const f of this.fires) f.update(time);
    this.relic.update(time);
  }
}
