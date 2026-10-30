import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs, atan, color, cos, dot, float, fract, mix, mx_fractal_noise_float, mx_noise_float, positionLocal, positionWorld, pow, sin, smoothstep,
  step, time, uniform, uv, vec3,
} from '../../render/tsl';
import { rng } from '../../core/random';
import { ConquestLayout as L, type Camp, type CampKind } from '../../map/ConquestLayout';
import { boulder, brokenShaft, chippedBlock, columnBase, flutedShaft, lathe } from '../Architecture';
import type { CollisionWorld } from '../Collision';
import { Fire } from '../Effects';
import type { MaterialLibrary } from '../Materials';
import type { Terrain } from '../Terrain';
import { mergeStatic } from '../structures/common';
import type { ConquestTerrainDef } from './ConquestTerrain';
import { hypot } from '../../core/math';

const CAMP_LIGHT = 35;

/** Glow color of each buff camp's crystal; combat matches its monsters to these. */
export const BUFF_COLOR: Partial<Record<CampKind, number>> = {
  might: 0xff3b2a,
  wisdom: 0x3f8cff,
  swiftness: 0xffcf3a,
  insight: 0xb04aff,
};

/** Side of the square regions that instanced props are grouped by, meters. */
const INSTANCE_CHUNK = 50;

/**
 * Collects prop transforms per geometry and per map region, so repeated
 * props cost one draw call per material and region, and the camera and
 * shadow cascades can cull the regions they don't see.
 */
class Instancer {
  private readonly lists = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; m: THREE.Matrix4[] }>();
  private readonly ids = new Map<THREE.BufferGeometry, number>();

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4): void {
    let id = this.ids.get(geo);
    if (id === undefined) this.ids.set(geo, (id = this.ids.size));
    const e3 = m.elements;
    const key = `${id}:${Math.floor(e3[12]! / INSTANCE_CHUNK)}:${Math.floor(e3[14]! / INSTANCE_CHUNK)}`;
    let e = this.lists.get(key);
    if (!e) this.lists.set(key, (e = { geo, mat, m: [] }));
    e.m.push(m);
  }

  build(parent: THREE.Object3D): void {
    // Static props sharing a material and region are baked into one mesh: the
    // lane walls alone were ~150 draw calls (six block shapes per region) in
    // every pass. Very large groups stay instanced to keep memory down.
    const groups = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; m: THREE.Matrix4[] }[]>();
    for (const [key, e] of this.lists) {
      const region = key.slice(key.indexOf(':'));
      const gk = `${e.mat.uuid}${region}`;
      const g = groups.get(gk);
      if (g) g.push(e);
      else groups.set(gk, [e]);
    }
    for (const entries of groups.values()) {
      const tris = entries.reduce((n, e) => n + triangles(e.geo) * e.m.length, 0);
      const merged = tris <= MERGE_LIMIT ? mergeGeometries(entries.flatMap((e) => e.m.map((x) => e.geo.clone().applyMatrix4(x))), false) : null;
      if (merged) {
        const mesh = new THREE.Mesh(merged, entries[0]!.mat);
        mesh.castShadow = mesh.receiveShadow = true;
        parent.add(mesh);
        continue;
      }
      for (const { geo, mat, m } of entries) {
        const inst = new THREE.InstancedMesh(geo, mat, m.length);
        m.forEach((x, i) => inst.setMatrixAt(i, x));
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        parent.add(inst);
      }
    }
  }
}

/** Largest group (in triangles) that `Instancer.build` bakes into one mesh. */
const MERGE_LIMIT = 60000;

function triangles(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position!.count) / 3;
}

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
function mat4(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1): THREE.Matrix4 {
  tmpQ.setFromEuler(tmpE.set(rx, ry, rz));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), tmpQ, new THREE.Vector3(s, s, s));
}

/**
 * Scorched basalt floor veined with glowing cracks and a few molten pools,
 * fading out at its rim so it sits in the ground like a decal.
 */
function lavaFloorMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld.xz;
  const d = uv().sub(0.5).length().mul(2);
  const warp = mx_noise_float(vec3(p.mul(0.12), 3.1)).mul(1.5);
  const veins = smoothstep(0.035, 0.0, abs(mx_noise_float(vec3(p.mul(0.32).add(warp), time.mul(0.03)))));
  const fine = smoothstep(0.025, 0.0, abs(mx_noise_float(vec3(p.mul(1.1), 7.0)))).mul(0.45);
  const flow = mx_fractal_noise_float(vec3(p.mul(0.22), time.mul(0.1)), 3, 2, 0.5).mul(0.5).add(0.5);
  const pools = smoothstep(0.76, 0.86, flow);
  // hotter toward the pit's middle, cooling to plain scorched rock at the rim
  const heat = smoothstep(0.95, 0.25, d);
  const hot = veins.max(fine).mul(heat).max(pools.mul(heat));
  mat.colorNode = mix(mix(color(0x1c1512), color(0x2c211b), flow), color(0x3a1408), hot);
  mat.roughnessNode = mix(float(0.9), float(0.45), hot);
  mat.metalnessNode = float(0);
  mat.emissiveNode = mix(color(0xff2a04), color(0xffa040), pow(hot, float(2))).mul(hot.mul(3.5));
  mat.transparent = true;
  mat.depthWrite = false;
  mat.opacityNode = smoothstep(1.0, 0.78, d.add(warp.mul(0.08)));
  return mat;
}

/** A rune crystal that spins in the vertex shader, so its group can stay frozen. */
function spinningCrystal(glow: number, strength: any): THREE.Mesh {
  const mat = new THREE.MeshBasicNodeMaterial();
  const a = time.mul(0.9);
  const p = positionLocal;
  const bob = sin(time.mul(1.7)).mul(0.12);
  mat.positionNode = vec3(p.x.mul(cos(a)).sub(p.z.mul(sin(a))), p.y.add(bob), p.x.mul(sin(a)).add(p.z.mul(cos(a))));
  mat.colorNode = color(glow).mul(sin(time.mul(2.3)).mul(0.25).add(1.1)).mul(5).mul(strength);
  const g = new THREE.OctahedronGeometry(0.42, 0);
  g.scale(1, 1.6, 1);
  return new THREE.Mesh(g, mat);
}

/**
 * Static dressing for the Conquest map: ruined walls along the lanes,
 * braziers, the ruins around each jungle camp, and the two boss pits.
 */
export class ConquestProps {
  readonly group = new THREE.Group();
  readonly fires: Fire[] = [];
  readonly lights: THREE.PointLight[] = [];
  private readonly inst = new Instancer();
  private readonly rand = rng(5150);
  private readonly blocks: THREE.BufferGeometry[];
  private readonly rocks: THREE.BufferGeometry[];
  /** Weathered grey-green stone for the lane walls, cooler than the temple sandstone. */
  private readonly wallStone: THREE.MeshStandardNodeMaterial;
  /** Old, rain-streaked marble with moss creeping up from the ground, for the jungle ruins. */
  private readonly ruinMarble: THREE.MeshStandardNodeMaterial;
  /** Hoard gold that glints in scattered coins. */
  private readonly hoardGold: THREE.MeshStandardNodeMaterial;
  /** Each buff camp's crystal brightness and light, by camp id, for `setCampActive`. */
  private readonly campGlow = new Map<string, { strength: any; light: THREE.PointLight }>();

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly terrain: Terrain,
    private readonly collision: CollisionWorld,
    private readonly def: ConquestTerrainDef,
  ) {
    this.group.name = 'props';
    // lane walls hold hundreds of these, so they get a lighter mesh (188 triangles, not 472)
    this.blocks = Array.from({ length: 6 }, (_, i) => chippedBlock(1.5, 0.75, 0.85, 6000 + i, 0.035, [5, 3, 4]));
    this.rocks = Array.from({ length: 5 }, (_, i) => boulder(1, 6100 + i, 3));
    this.ruinMarble = mats.marble.clone() as THREE.MeshStandardNodeMaterial;
    const marble = mats.marble.colorNode as any;
    // camp props are merged in camp space, so local y is height above the ground
    const moss = smoothstep(2.2, 0.2, positionLocal.y.add(mx_noise_float(positionWorld.mul(1.7)).mul(0.9))).mul(0.9);
    const streaks = mx_noise_float(vec3(positionWorld.x.mul(3), positionWorld.y.mul(0.4), positionWorld.z.mul(3))).mul(0.5).add(0.5);
    this.ruinMarble.colorNode = mix(marble.mul(mix(float(0.42), float(0.62), streaks)).mul(vec3(0.95, 0.97, 0.9)), vec3(0.1, 0.16, 0.05), moss);
    this.hoardGold = mats.gold.clone() as THREE.MeshStandardNodeMaterial;
    // loose coins: dark gaps between them and a rougher, duller surface than polished trim,
    // so a heap reads as a pile instead of one glowing blob
    const coins = mx_noise_float(positionWorld.mul(6.5)).mul(0.5).add(0.5);
    this.hoardGold.colorNode = (mats.gold.colorNode as any).mul(mix(float(0.35), float(0.85), smoothstep(0.25, 0.6, coins)));
    this.hoardGold.roughnessNode = mix(float(0.55), float(0.32), coins);
    const glint = pow(mx_noise_float(positionWorld.mul(9)).mul(0.5).add(0.5), float(18));
    this.hoardGold.emissiveNode = color(0xffd37a).mul(glint.mul(1.2));
    this.wallStone = mats.sandstone.clone() as THREE.MeshStandardNodeMaterial;
    const sand = mats.sandstone.colorNode as any;
    this.wallStone.colorNode = mix(sand, vec3(dot(sand.rgb, vec3(0.3, 0.59, 0.11))), 0.8).mul(vec3(0.78, 0.88, 0.76));
    this.laneWalls();
    this.braziers();
    for (const c of L.camps) {
      if (c.kind === 'treasureWyrm') this.wyrmPit(c);
      else if (c.kind === 'moltenColossus') this.colossusPit(c);
      else if (c.kind === 'small') this.smallCamp(c);
      else this.buffCamp(c);
    }
    this.inst.build(this.group);
  }

  /** Dims a buff camp's crystal and light while its buff is taken, and relights it on respawn. */
  setCampActive(campId: string, active: boolean): void {
    const e = this.campGlow.get(campId);
    if (!e) return;
    e.strength.value = active ? 1 : 0.12;
    e.light.intensity = active ? CAMP_LIGHT : CAMP_LIGHT * 0.1;
  }

  private ground(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Low, broken mossy stone walls at the foot of the jungle walls along every lane. */
  private laneWalls(): void {
    const r = this.rand;
    for (const lane of L.lanes) {
      const pts = lane.points;
      for (const side of [-1, 1]) {
        let run = 0;
        let courses = 1;
        for (let i = 1; i < pts.length; i++) {
          const [ax, az] = pts[i - 1]!;
          const [bx, bz] = pts[i]!;
          const len = hypot(bx - ax, bz - az);
          const dx = (bx - ax) / len;
          const dz = (bz - az) / len;
          const yaw = Math.atan2(dx, dz) + Math.PI / 2;
          for (let s = 0; s < len; s += 1.55) {
            const off = lane.width / 2 + 3.6;
            const x = ax + dx * s - dz * off * side;
            const z = az + dz * s + dx * off * side;
            if (run <= 0) {
              // alternate between wall runs and gaps
              run = r() < 0.55 ? -(3 + Math.floor(r() * 6)) : 4 + Math.floor(r() * 8);
              courses = 1 + Math.floor(r() * 2.6);
            }
            if (run < 0) {
              run++;
              if (run === 0) run = 4 + Math.floor(r() * 8);
              continue;
            }
            run--;
            if (this.def.pathDistance(x, z) < 6 || this.def.plazaDistance(x, z) < 3) continue;
            const g0 = this.ground(x, z);
            const h = Math.max(1, courses - (r() < 0.3 ? 1 : 0));
            for (let c = 0; c < h; c++) {
              const g = this.blocks[Math.floor(r() * this.blocks.length)]!;
              this.inst.add(g, this.wallStone, mat4(x, g0 - 0.06 + 0.375 + c * 0.76, z, (r() - 0.5) * 0.04, yaw + (r() - 0.5) * 0.08 + (c % 2) * 0.04, (r() - 0.5) * 0.04));
            }
            if (r() < 0.06) {
              const tx = x + dz * side * 1.2;
              const tz = z - dx * side * 1.2;
              this.inst.add(this.blocks[0]!, this.wallStone, mat4(tx, this.ground(tx, tz) + 0.25, tz, r() * 0.5, r() * 3, r() * 0.5));
            }
          }
        }
      }
    }
  }

  /** Bronze braziers on stone plinths, alternating sides along each lane. */
  private braziers(): void {
    const bowl = lathe([
      [0, 0], [0.22, 0], [0.25, 0.05], [0.12, 0.1], [0.1, 0.55], [0.18, 0.62], [0.55, 0.72], [0.72, 0.9],
      [0.76, 1.0], [0.7, 1.02], [0.52, 0.86], [0, 0.82],
    ], 32);
    const plinth = chippedBlock(1.1, 0.7, 1.1, 4000);
    let k = 0;
    for (const lane of L.lanes) {
      const pts = lane.points;
      let next = 14;
      let walked = 0;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1]!;
        const [bx, bz] = pts[i]!;
        const len = hypot(bx - ax, bz - az);
        while (next <= walked + len) {
          const s = next - walked;
          const dx = (bx - ax) / len;
          const dz = (bz - az) / len;
          const side = k % 2 ? 1 : -1;
          const off = lane.width / 2 + 0.9;
          const x = ax + dx * s - dz * off * side;
          const z = az + dz * s + dx * off * side;
          next += 26;
          if (this.def.plazaDistance(x, z) < 1) continue;
          const g = this.ground(x, z);
          this.inst.add(plinth, this.mats.sandstone, mat4(x, g + 0.3, z));
          this.inst.add(bowl, this.mats.bronze, mat4(x, g + 0.65, z));
          const fire = new Fire(new THREE.Vector3(x, g + 1.5, z), 0.9, k * 7.3, 18);
          this.fires.push(fire);
          this.lights.push(fire.light);
          this.group.add(fire.group);
          this.collision.addCircle(x, z, 0.7, g + 1.6);
          k++;
        }
        walked += len;
      }
    }
  }

  /** A ring of broken columns around an altar with the buff's floating rune crystal. */
  private buffCamp(c: Camp): void {
    const glow = BUFF_COLOR[c.kind] ?? 0xffffff;
    const [cx, cz] = c.at;
    const g0 = this.ground(cx, cz);
    const camp = new THREE.Group();
    camp.position.set(cx, g0, cz);
    const r = this.rand;
    const ring = L.radii.camp + 1.2;
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      camp.add(mesh);
      return mesh;
    };
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + r() * 0.3;
      const x = Math.cos(a) * ring;
      const z = Math.sin(a) * ring;
      const h = 1 + r() * 2.6;
      add(columnBase(0.42), this.ruinMarble, x, -0.05, z);
      add(brokenShaft(0.42, h, 7000 + i + c.at[0]), this.ruinMarble, x, 0.55, z);
      this.collision.addCircle(cx + x, cz + z, 0.65);
      if (r() < 0.4) {
        // a fallen drum beside it
        const drum = add(flutedShaft(0.42, 0.9, 20, 40, 2), this.ruinMarble, x * 1.12, 0.42, z * 1.12, r() * 3);
        drum.rotation.z = Math.PI / 2;
      }
    }
    add(lathe([[0.001, 0], [1.5, 0], [1.5, 0.3], [1.25, 0.35], [1.1, 0.9], [1.3, 1.0], [0.001, 1.0]], 32), this.ruinMarble, 0, -0.05, 0);
    const strength = uniform(1);
    // a glowing inlay ring in the camp's paving, and a rune band on the altar
    const inlay = new THREE.MeshBasicNodeMaterial();
    // broken into rune-like dashes so it reads as inlay, not a selection circle
    const dash = step(0.35, fract(atan(positionLocal.z, positionLocal.x).mul(36 / (2 * Math.PI))));
    inlay.colorNode = color(glow).mul(sin(time.mul(1.2).add(cx)).mul(0.2).add(1)).mul(1.3).mul(strength);
    inlay.opacityNode = dash;
    inlay.alphaTest = 0.5;
    const ringGeo = new THREE.RingGeometry(L.radii.camp - 0.6, L.radii.camp - 0.48, 96).rotateX(-Math.PI / 2);
    add(ringGeo, inlay, 0, 0.04, 0).castShadow = false;
    add(new THREE.TorusGeometry(1.2, 0.05, 6, 48).rotateX(Math.PI / 2), inlay, 0, 0.62, 0).castShadow = false;
    const crystal = spinningCrystal(glow, strength);
    crystal.position.y = 2.0;
    camp.add(crystal);
    const light = new THREE.PointLight(glow, CAMP_LIGHT, 14, 2);
    this.campGlow.set(c.id, { strength, light });
    light.position.y = 2.2;
    camp.add(light);
    this.lights.push(light);
    this.collision.addCircle(cx, cz, 1.4, g0 + 1);
    mergeStatic(camp, [crystal]);
    this.group.add(camp);
  }

  /** A few tumbled boulders and a fallen column at the clearing's edge. */
  private smallCamp(c: Camp): void {
    const r = this.rand;
    const [cx, cz] = c.at;
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2;
      const d = L.radii.camp + 0.5 + r() * 1.5;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const s = 0.8 + r() * 0.9;
      this.inst.add(this.rocks[i % this.rocks.length]!, this.mats.rock, mat4(x, this.ground(x, z) + s * 0.15, z, r(), r() * 6, r(), s));
      this.collision.addCircle(x, z, s * 0.9);
    }
  }

  /** Treasure Wyrm: a colonnade of tall marble columns around a hoard of gold. */
  private wyrmPit(c: Camp): void {
    const [cx, cz] = c.at;
    const pit = new THREE.Group();
    pit.position.set(cx, this.ground(cx, cz), cz);
    const r = this.rand;
    const R = L.radii.boss + 1.3;
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pit.add(mesh);
      return mesh;
    };
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      // leave the side facing the duo lane open
      if (Math.cos(a) > 0.8 || Math.cos(a) < -0.8) continue;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const broken = r() < 0.4;
      const h = broken ? 2 + r() * 3 : 7.5;
      add(columnBase(0.55), this.ruinMarble, x, -0.05, z);
      add(broken ? brokenShaft(0.55, h, 7300 + i) : flutedShaft(0.55, h, 20, 80, 6), this.ruinMarble, x, 0.55, z);
      if (!broken) add(new THREE.CylinderGeometry(0.75, 0.62, 0.35, 24), this.mats.gold, x, 0.55 + h + 0.17, z);
      this.collision.addCircle(cx + x, cz + z, 0.8);
    }
    // heaps of gold against the back of the pit
    for (let i = 0; i < 5; i++) {
      const a = Math.PI / 2 * (i % 2 ? 1 : -1) + (r() - 0.5) * 0.9;
      const d = R - 2.2 - r();
      const heap = add(boulder(1.3 + r() * 0.8, 7400 + i, 3), this.hoardGold, Math.cos(a) * d, -0.2, Math.sin(a) * d);
      heap.scale.set(1.2, 0.45, 1.2);
    }
    const inlay = new THREE.MeshBasicNodeMaterial();
    const dash = step(0.3, fract(atan(positionLocal.z, positionLocal.x).mul(60 / (2 * Math.PI))));
    inlay.colorNode = color(0xffc04a).mul(sin(time.mul(0.9)).mul(0.15).add(1)).mul(1.2);
    inlay.opacityNode = dash;
    inlay.alphaTest = 0.5;
    add(new THREE.RingGeometry(L.radii.boss - 1.3, L.radii.boss - 1.14, 128).rotateX(-Math.PI / 2), inlay, 0, 0.04, 0).castShadow = false;
    mergeStatic(pit);
    this.group.add(pit);
  }

  /** Molten Colossus: a ring of jagged dark spires around pools of lava. */
  private colossusPit(c: Camp): void {
    const [cx, cz] = c.at;
    const pit = new THREE.Group();
    pit.position.set(cx, this.ground(cx, cz), cz);
    const r = this.rand;
    const R = L.radii.boss + 1.5;
    const basalt = this.mats.rock.clone();
    basalt.colorNode = (this.mats.rock.colorNode as any).mul(vec3(0.22, 0.19, 0.19));
    // molten seams glow up from the spires' feet (pit space: y = 0 is the floor)
    const seam = smoothstep(0.06, 0.0, abs(mx_noise_float(positionLocal.mul(vec3(0.9, 0.35, 0.9)))));
    const heatUp = smoothstep(4.5, 0.0, positionLocal.y);
    basalt.emissiveNode = mix(color(0xff2a04), color(0xff8a2a), heatUp).mul(seam.mul(heatUp).mul(4));
        for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + r() * 0.2;
      if (Math.cos(a) > 0.8 || Math.cos(a) < -0.8) continue;
      const x = Math.cos(a) * (R + r() * 1.5);
      const z = Math.sin(a) * (R + r() * 1.5);
      const spire = new THREE.Mesh(boulder(1.2, 7500 + i, 3), basalt);
      spire.scale.set(1.1 + r() * 0.7, 6.5 + r() * 6, 1.1 + r() * 0.7);
      spire.position.set(x, -0.6, z);
      spire.rotation.set((r() - 0.5) * 0.3, r() * 6, (r() - 0.5) * 0.3);
      spire.castShadow = true;
      spire.receiveShadow = true;
      pit.add(spire);
      this.collision.addCircle(cx + x, cz + z, 1.6);
    }
    // the whole pit floor is cracked, glowing basalt
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 1.5, 64).rotateX(-Math.PI / 2), lavaFloorMaterial());
    floor.position.y = 0.05;
    floor.receiveShadow = true;
    floor.renderOrder = 1;
    pit.add(floor);
    const light = new THREE.PointLight(0xff5a1a, 60, 26, 2);
    light.position.y = 2;
    pit.add(light);
    this.lights.push(light);
    mergeStatic(pit, [floor]);
    this.group.add(pit);
  }
}
