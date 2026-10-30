import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Side as Team } from '../game/combatant';
import { abs, float, mix, mx_noise_float, positionGeometry, smoothstep, vec3 } from '../render/tsl';
import { lathe } from '../scene/Architecture';
import type { MinionType } from '../sim/factory';
import type { Unit } from '../sim/Unit';

/**
 * Lane minions, batched: every (team, material) is one BatchedMesh holding
 * each minion type's body parts, so the whole army costs one draw call per
 * material per pass (three draws a BatchedMesh's instances in a native loop,
 * without its per-object overhead). Each minion is four rigid parts (body, two
 * legs, weapon arm) posed per instance: a walk cycle, attack swings, a hit
 * flinch and a fall on death. Materials read `positionGeometry`, the part's
 * unposed position, so their patterns stay on the minion as it walks.
 *
 * Minions are mortal soldiers, about 1.75 m (gods are 2.45 m); brutes are
 * hulking at about 2.6 m. Order wears blue and gold, Chaos crimson and black
 * (the map's TEAM_STYLE colors).
 */

type Mat = 'cloth' | 'trim' | 'metal' | 'leather' | 'skin' | 'wood' | 'glow';
type Part = 'body' | 'legL' | 'legR' | 'arm';
const PARTS: readonly Part[] = ['body', 'legL', 'legR', 'arm'];
const TYPES: readonly MinionType[] = ['melee', 'archer', 'brute'];
const CAPACITY: Record<MinionType, number> = { melee: 72, archer: 72, brute: 16 };

const TEAM_LOOK: Record<Team, { cloth: number; trim: number; metal: number; skin: number; glow: number }> = {
  order: { cloth: 0x2350a8, trim: 0xd9a845, metal: 0xb8c2cc, skin: 0xc49272, glow: 0x4fb2ff },
  chaos: { cloth: 0x8a161b, trim: 0x2a2320, metal: 0x6f6a66, skin: 0x9a6d55, glow: 0xff3524 },
};

/** Pivots of the animated parts, in the model's frame (front is +Z). */
interface Rig {
  hipY: number;
  hipX: number;
  shoulder: THREE.Vector3;
  scale: number;
}

type Kit = Record<Part, Partial<Record<Mat, THREE.BufferGeometry[]>>>;

const tmp = new THREE.Object3D();

function put(kit: Kit, part: Part, mat: Mat, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
  tmp.position.set(x, y, z);
  tmp.rotation.set(rx, ry, rz);
  tmp.scale.set(1, 1, 1);
  tmp.updateMatrix();
  const geo = (g.index ? g.toNonIndexed() : g).applyMatrix4(tmp.matrix);
  // keep only what every geometry has, so they merge
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((geo.attributes.position!.count) * 2), 2));
  ((kit[part][mat] ??= []) as THREE.BufferGeometry[]).push(geo);
}

/** A leg hanging from its hip pivot at the origin. */
function leg(kit: Kit, part: Part, length: number, girth: number, armored: boolean): void {
  const thigh = length * 0.5;
  put(kit, part, 'cloth', new THREE.CapsuleGeometry(girth, thigh * 0.7, 4, 10), 0, -thigh * 0.5, 0);
  put(kit, part, 'skin', new THREE.CapsuleGeometry(girth * 0.78, thigh * 0.7, 4, 10), 0, -thigh * 1.45, 0);
  if (armored) put(kit, part, 'metal', lathe([[girth * 0.95, 0], [girth, thigh * 0.3], [girth * 1.05, thigh * 0.6], [girth * 0.92, thigh * 0.8]], 14), 0, -length * 0.93, 0.01);
  else put(kit, part, 'leather', new THREE.CylinderGeometry(girth * 0.9, girth * 0.82, thigh * 0.7, 12), 0, -length * 0.8, 0);
  put(kit, part, 'leather', new THREE.BoxGeometry(girth * 1.5, girth * 0.8, girth * 3), 0, -length + girth * 0.4, girth * 0.7);
}

/** A cape hanging from the shoulders at the origin: narrow at the top, flaring and curving back toward the hem. */
function cape(top: number, bottom: number, length: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 6, 6);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i);
    const v = p.getY(i) + 0.5; // 1 at the shoulders, 0 at the hem
    const w = top + (bottom - top) * (1 - v);
    const x = u * w * 2;
    // wraps around the back, flares out toward the hem, with a couple of folds
    const z = -Math.cos(u * Math.PI) * 0.06 - (1 - v) * (1 - v) * 0.12 + Math.sin(u * Math.PI * 4) * 0.015 * (1 - v);
    p.setXYZ(i, x, (v - 1) * length, z);
  }
  g.computeVertexNormals();
  return g;
}

function buildMelee(kit: Kit): Rig {
  const hipY = 0.86;
  // tunic, skirt strips and belt
  put(kit, 'body', 'cloth', lathe([[0.001, hipY - 0.12], [0.2, hipY - 0.12], [0.24, hipY + 0.05], [0.23, hipY + 0.3], [0.2, hipY + 0.5], [0.001, hipY + 0.52]], 20).scale(1, 1, 0.8));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    put(kit, 'body', i % 2 ? 'leather' : 'cloth', new THREE.BoxGeometry(0.1, 0.3, 0.02), Math.sin(a) * 0.23, hipY - 0.14, Math.cos(a) * 0.19, Math.cos(a) * 0.15, a, -Math.sin(a) * 0.15);
  }
  put(kit, 'body', 'leather', new THREE.TorusGeometry(0.22, 0.035, 8, 24).rotateX(Math.PI / 2).scale(1, 1, 0.82), 0, hipY + 0.02, 0);
  // bronze cuirass
  put(kit, 'body', 'trim', lathe([[0.001, 0.0], [0.22, 0.0], [0.26, 0.12], [0.28, 0.26], [0.25, 0.36], [0.16, 0.42], [0.001, 0.43]], 24).scale(1.08, 1, 0.74), 0, hipY + 0.12, 0);
  // head, neck and crested helmet
  put(kit, 'body', 'skin', new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), 0, hipY + 0.57, 0);
  put(kit, 'body', 'skin', new THREE.SphereGeometry(0.105, 16, 12).scale(0.92, 1.1, 1), 0, hipY + 0.7, 0.01);
  put(kit, 'body', 'metal', lathe([[0.001, 0.16], [0.07, 0.155], [0.11, 0.12], [0.125, 0.04], [0.125, -0.06], [0.001, -0.06]], 20).scale(1, 1, 1.08), 0, hipY + 0.71, 0);
  put(kit, 'body', 'cloth', new THREE.BoxGeometry(0.035, 0.12, 0.3), 0, hipY + 0.9, -0.01);
  // pauldrons
  for (const sx of [-1, 1]) put(kit, 'body', 'metal', new THREE.SphereGeometry(0.11, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.1, 0.85, 1.05), sx * 0.29, hipY + 0.49, 0, 0, 0, -sx * 0.35);
  // shield arm, held forward
  put(kit, 'body', 'skin', new THREE.CapsuleGeometry(0.055, 0.42, 4, 8), -0.31, hipY + 0.26, 0.08, 0.5, 0, 0.1);
  put(kit, 'body', 'cloth', new THREE.CylinderGeometry(0.3, 0.3, 0.035, 24), -0.36, hipY + 0.22, 0.27, Math.PI / 2 - 0.1, 0, 0.12);
  put(kit, 'body', 'trim', new THREE.TorusGeometry(0.3, 0.025, 6, 28), -0.36, hipY + 0.22, 0.285, -0.1, 0, 0.12);
  put(kit, 'body', 'glow', new THREE.SphereGeometry(0.07, 12, 8).scale(1, 1, 0.6), -0.36, hipY + 0.22, 0.3);
  put(kit, 'body', 'cloth', cape(0.22, 0.3, 0.5), 0, hipY + 0.5, -0.12);
  // sword arm: hangs from the shoulder at the origin, sword pointing forward-down
  put(kit, 'arm', 'skin', new THREE.CapsuleGeometry(0.055, 0.42, 4, 8), 0, -0.25, 0);
  put(kit, 'arm', 'leather', new THREE.CylinderGeometry(0.065, 0.06, 0.14, 10), 0, -0.4, 0);
  put(kit, 'arm', 'leather', new THREE.CylinderGeometry(0.022, 0.022, 0.14, 8), 0, -0.52, 0.04, Math.PI / 2);
  put(kit, 'arm', 'trim', new THREE.BoxGeometry(0.16, 0.03, 0.04), 0, -0.52, 0.12);
  put(kit, 'arm', 'metal', new THREE.BoxGeometry(0.06, 0.012, 0.62).translate(0, 0, 0.31), 0, -0.52, 0.13);
  leg(kit, 'legL', hipY - 0.04, 0.075, true);
  leg(kit, 'legR', hipY - 0.04, 0.075, true);
  return { hipY, hipX: 0.12, shoulder: new THREE.Vector3(0.3, hipY + 0.47, 0), scale: 1 };
}

function buildArcher(kit: Kit): Rig {
  const hipY = 0.86;
  put(kit, 'body', 'cloth', lathe([[0.001, hipY - 0.2], [0.25, hipY - 0.2], [0.22, hipY], [0.22, hipY + 0.3], [0.19, hipY + 0.5], [0.001, hipY + 0.52]], 20).scale(1, 1, 0.78));
  put(kit, 'body', 'trim', new THREE.TorusGeometry(0.245, 0.018, 6, 24).rotateX(Math.PI / 2).scale(1, 1, 0.78), 0, hipY - 0.19, 0);
  put(kit, 'body', 'glow', new THREE.OctahedronGeometry(0.035, 0).scale(1, 1.4, 0.6), 0, hipY + 0.36, 0.2);
  put(kit, 'body', 'leather', lathe([[0.001, 0], [0.2, 0], [0.235, 0.15], [0.24, 0.3], [0.17, 0.4], [0.001, 0.41]], 20).scale(1.05, 1, 0.76), 0, hipY + 0.08, 0);
  put(kit, 'body', 'trim', new THREE.TorusGeometry(0.21, 0.025, 8, 24).rotateX(Math.PI / 2).scale(1, 1, 0.8), 0, hipY + 0.05, 0);
  put(kit, 'body', 'skin', new THREE.SphereGeometry(0.1, 16, 12).scale(0.92, 1.1, 1), 0, hipY + 0.69, 0.01);
  // hood and short cape
  put(kit, 'body', 'cloth', new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1, 1.05, 1.1), 0, hipY + 0.71, -0.035, -0.45);
  put(kit, 'body', 'cloth', cape(0.2, 0.34, 0.62), 0, hipY + 0.52, -0.1);
  // quiver with arrows
  put(kit, 'body', 'leather', new THREE.CylinderGeometry(0.06, 0.05, 0.5, 10), 0.08, hipY + 0.35, -0.2, 0.2, 0, -0.35);
  for (let i = 0; i < 4; i++) put(kit, 'body', 'glow', new THREE.ConeGeometry(0.025, 0.08, 6), 0.16 + i * 0.02, hipY + 0.64 - i * 0.01, -0.27, 0.2, 0, -0.35);
  // bow arm reaching forward, bow held upright
  put(kit, 'body', 'skin', new THREE.CapsuleGeometry(0.05, 0.42, 4, 8), -0.24, hipY + 0.44, 0.24, Math.PI / 2 - 0.1);
  put(kit, 'body', 'wood', new THREE.TorusGeometry(0.5, 0.02, 6, 24, Math.PI * 0.75), -0.24, hipY + 0.44, 0.65, 0, Math.PI / 2, Math.PI * 0.625);
  put(kit, 'body', 'trim', new THREE.CylinderGeometry(0.004, 0.004, 0.92, 4), -0.24, hipY + 0.44, 0.47);
  // draw arm: pulls back to the cheek
  put(kit, 'arm', 'skin', new THREE.CapsuleGeometry(0.05, 0.4, 4, 8), 0, -0.24, 0);
  put(kit, 'arm', 'leather', new THREE.CylinderGeometry(0.06, 0.055, 0.12, 10), 0, -0.38, 0);
  leg(kit, 'legL', hipY - 0.04, 0.07, false);
  leg(kit, 'legR', hipY - 0.04, 0.07, false);
  return { hipY, hipX: 0.11, shoulder: new THREE.Vector3(0.27, hipY + 0.46, 0), scale: 1 };
}

function buildBrute(kit: Kit): Rig {
  const hipY = 0.95;
  // barrel body hunched forward, huge shoulders
  put(kit, 'body', 'skin', lathe([[0.001, -0.05], [0.34, -0.05], [0.42, 0.2], [0.46, 0.45], [0.42, 0.66], [0.25, 0.78], [0.001, 0.8]], 24).scale(1.15, 1, 0.9), 0, hipY, 0.04, 0.18);
  put(kit, 'body', 'leather', lathe([[0.001, -0.25], [0.36, -0.25], [0.37, 0.05], [0.33, 0.1], [0.001, 0.1]], 22).scale(1.12, 1, 0.92), 0, hipY, 0);
  put(kit, 'body', 'trim', new THREE.TorusGeometry(0.4, 0.05, 8, 26).rotateX(Math.PI / 2).scale(1.12, 1, 0.9), 0, hipY + 0.06, 0);
  // war harness straps and chest plate
  put(kit, 'body', 'leather', new THREE.TorusGeometry(0.44, 0.03, 6, 24).scale(1.1, 1, 0.9), 0, hipY + 0.42, 0.06, 0.5, 0, 0.6);
  put(kit, 'body', 'metal', new THREE.SphereGeometry(0.22, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.4).scale(1.3, 1, 0.5), 0, hipY + 0.45, 0.3, Math.PI / 2 - 0.2);
  for (const sx of [-1, 1]) {
    put(kit, 'body', 'metal', new THREE.SphereGeometry(0.24, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.15, 0.9, 1.1), sx * 0.52, hipY + 0.72, 0.08, 0.2, 0, -sx * 0.4);
    for (let i = 0; i < 3; i++) put(kit, 'body', 'trim', new THREE.ConeGeometry(0.045, 0.16, 8), sx * (0.48 + i * 0.07), hipY + 0.9 - i * 0.03, 0.08 - i * 0.04, 0, 0, -sx * 0.5);
  }
  // small head sunk between the shoulders, horned helm
  put(kit, 'body', 'skin', new THREE.SphereGeometry(0.15, 16, 12).scale(1, 0.95, 1.05), 0, hipY + 0.86, 0.2);
  put(kit, 'body', 'metal', lathe([[0.001, 0.14], [0.1, 0.13], [0.15, 0.06], [0.165, -0.04], [0.001, -0.04]], 18), 0, hipY + 0.9, 0.18);
  for (const sx of [-1, 1]) put(kit, 'body', 'trim', new THREE.ConeGeometry(0.05, 0.3, 10).translate(0, 0.15, 0), sx * 0.14, hipY + 0.96, 0.18, 0, 0, -sx * 0.9);
  for (const sx of [-1, 1]) put(kit, 'body', 'glow', new THREE.SphereGeometry(0.025, 8, 6), sx * 0.055, hipY + 0.88, 0.34);
  put(kit, 'body', 'glow', new THREE.TorusGeometry(0.08, 0.014, 6, 16), 0, hipY + 0.45, 0.42, -0.2);
  // free arm hanging, fist
  put(kit, 'body', 'skin', new THREE.CapsuleGeometry(0.11, 0.55, 4, 10), -0.62, hipY + 0.3, 0.12, 0.25, 0, 0.12);
  put(kit, 'body', 'leather', new THREE.CylinderGeometry(0.13, 0.12, 0.2, 12), -0.66, hipY + 0.1, 0.18, 0.25, 0, 0.12);
  // club arm
  put(kit, 'arm', 'skin', new THREE.CapsuleGeometry(0.11, 0.55, 4, 10), 0, -0.36, 0);
  put(kit, 'arm', 'leather', new THREE.CylinderGeometry(0.13, 0.12, 0.2, 12), 0, -0.6, 0);
  put(kit, 'arm', 'wood', new THREE.CylinderGeometry(0.11, 0.05, 1.2, 10).translate(0, 0.55, 0), 0, -0.72, 0.05, Math.PI / 2 + 0.3);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    put(kit, 'arm', 'metal', new THREE.ConeGeometry(0.03, 0.12, 6), Math.cos(a) * 0.1, -0.72 - 0.45 * Math.sin(0.3) + Math.sin(a) * 0.1, 0.05 + 0.85, Math.PI / 2 + 0.3, 0, a);
  }
  leg(kit, 'legL', hipY - 0.05, 0.14, false);
  leg(kit, 'legR', hipY - 0.05, 0.14, false);
  return { hipY, hipX: 0.24, shoulder: new THREE.Vector3(0.6, hipY + 0.66, 0.1), scale: 1.1 };
}

function materials(team: Team): Record<Mat, THREE.Material> {
  const look = TEAM_LOOK[team];
  const n = (s: number) => mx_noise_float(positionGeometry.mul(s)).mul(0.5).add(0.5);
  const cloth = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.85, sheen: 0.8, sheenRoughness: 0.5, sheenColor: new THREE.Color(look.cloth).multiplyScalar(1.4), side: THREE.DoubleSide });
  const c = new THREE.Color(look.cloth);
  // painted cloth: vertical folds, darker toward the hem, a woven grain
  const pl = positionGeometry;
  const folds = mx_noise_float(vec3(pl.x.mul(11), pl.y.mul(1.2), pl.z.mul(11))).mul(0.5).add(0.5);
  const ramp = smoothstep(-0.6, 1.4, pl.y).mul(0.45).add(0.6);
  cloth.colorNode = vec3(c.r, c.g, c.b).mul(ramp).mul(float(0.72).add(folds.mul(0.45))).mul(float(0.92).add(n(60).mul(0.12)));
  const trim = new THREE.MeshPhysicalNodeMaterial({ color: look.trim, metalness: team === 'order' ? 1 : 0.6, roughness: 0.3 });
  trim.roughnessNode = float(0.26).add(n(30).mul(0.15));
  const metal = new THREE.MeshPhysicalNodeMaterial({ color: look.metal, metalness: 1, roughness: 0.34 });
  metal.roughnessNode = float(0.3).add(n(45).mul(0.14));
  const leather = new THREE.MeshStandardNodeMaterial({ roughness: 0.72 });
  leather.colorNode = mix(vec3(0.16, 0.09, 0.05), vec3(0.3, 0.18, 0.1), n(25));
  const skin = new THREE.MeshPhysicalNodeMaterial({ color: look.skin, roughness: 0.55, sheen: 0.3, sheenColor: new THREE.Color(0xffc4a0) });
  const wood = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  wood.colorNode = mix(vec3(0.22, 0.13, 0.06), vec3(0.4, 0.25, 0.12), mx_noise_float(positionGeometry.mul(vec3(3, 30, 3))).mul(0.5).add(0.5));
  // team-colored glowing details (gems, eyes, arrowheads) so a wave reads at a glance
  const glow = new THREE.MeshStandardNodeMaterial({ roughness: 0.3 });
  const g = new THREE.Color(look.glow);
  glow.colorNode = vec3(g.r, g.g, g.b).mul(0.5);
  glow.emissiveNode = vec3(g.r, g.g, g.b).mul(float(2.2).add(abs(mx_noise_float(pl.mul(8))).mul(1.2)));
  return { cloth, trim, metal, leather, skin, wood, glow };
}

/** One material's share of a (team, type, part): the batch and an instance per minion slot. */
interface Slot {
  mesh: THREE.BatchedMesh;
  ids: number[];
}

interface Batch {
  rig: Rig;
  slots: Record<Part, Slot[]>;
  count: number;
  /** Minion slots whose instances are visible. */
  shown: number;
}

interface Pose {
  phase: number;
  speed: number;
  flinch: number;
  flinchVel: number;
  /** -1 or 1: which way this minion twists when it falls. */
  side: number;
}

const BUILDERS: Record<MinionType, (k: Kit) => Rig> = { melee: buildMelee, archer: buildArcher, brute: buildBrute };

export class MinionViews {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly poses = new Map<Unit, Pose>();
  private readonly root = new THREE.Object3D();
  private readonly part = new THREE.Object3D();
  private readonly m = new THREE.Matrix4();

  constructor() {
    this.group.name = 'minions';
    for (const team of ['order', 'chaos'] as const) {
      const mats = materials(team);
      const byMat = new Map<Mat, { type: MinionType; part: Part; geo: THREE.BufferGeometry }[]>();
      for (const type of TYPES) {
        const kit: Kit = { body: {}, legL: {}, legR: {}, arm: {} };
        const rig = BUILDERS[type](kit);
        this.batches.set(`${team}:${type}`, { rig, slots: { body: [], legL: [], legR: [], arm: [] }, count: 0, shown: 0 });
        for (const part of PARTS) {
          for (const [mat, geos] of Object.entries(kit[part]) as [Mat, THREE.BufferGeometry[]][]) {
            const geo = mergeGeometries(geos, false);
            if (!geo) continue;
            let list = byMat.get(mat);
            if (!list) byMat.set(mat, (list = []));
            list.push({ type, part, geo });
          }
        }
      }
      for (const [mat, list] of byMat) {
        const instances = list.reduce((n, e) => n + CAPACITY[e.type], 0);
        const vertices = list.reduce((n, e) => n + e.geo.getAttribute('position').count, 0);
        const mesh = new THREE.BatchedMesh(instances, vertices, 0, mats[mat]);
        // instances only change when minions spawn or die, and a few hundred
        // native draws cost less than culling and sorting them every pass
        mesh.perObjectFrustumCulled = false;
        mesh.sortObjects = false;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.visible = false;
        for (const e of list) {
          const geometry = mesh.addGeometry(e.geo);
          const ids = Array.from({ length: CAPACITY[e.type] }, () => {
            const id = mesh.addInstance(geometry);
            mesh.setVisibleAt(id, false);
            return id;
          });
          this.batches.get(`${team}:${e.type}`)!.slots[e.part].push({ mesh, ids });
        }
        this.group.add(mesh);
      }
    }
  }

  hit(u: Unit, amount: number): void {
    const p = this.poses.get(u);
    if (p) p.flinchVel += Math.min(8, 2 + amount / 25);
  }

  /**
   * Pose every minion. `at` gives the interpolated feet position; `deathTime`
   * is seconds since death or -1.
   */
  frame(minions: readonly Unit[], dt: number, at: (u: Unit) => THREE.Vector3, deathTime: (u: Unit) => number, visible: (u: Unit) => boolean): void {
    for (const b of this.batches.values()) b.count = 0;
    const seen = new Set<Unit>();
    for (const u of minions) {
      const type = u.tag.split(':')[1] as MinionType;
      const b = this.batches.get(`${u.team}:${type}`);
      if (!b || b.count >= CAPACITY[type] || !visible(u)) continue;
      seen.add(u);
      let pose = this.poses.get(u);
      if (!pose) {
        pose = { phase: Math.random() * 6, speed: 0, flinch: 0, flinchVel: 0, side: Math.random() < 0.5 ? -1 : 1 };
        this.poses.set(u, pose);
      }
      this.pose(u, b, pose, dt, at(u), deathTime(u), type);
      b.count++;
    }
    for (const u of this.poses.keys()) if (!seen.has(u)) this.poses.delete(u);
    for (const mesh of this.group.children) mesh.visible = false;
    for (const b of this.batches.values()) {
      for (const p of PARTS) {
        for (const { mesh, ids } of b.slots[p]) {
          for (let i = Math.min(b.count, b.shown); i < Math.max(b.count, b.shown); i++) mesh.setVisibleAt(ids[i]!, i < b.count);
          if (b.count > 0) mesh.visible = true;
        }
      }
      b.shown = b.count;
    }
  }

  private pose(u: Unit, b: Batch, pose: Pose, dt: number, pos: THREE.Vector3, death: number, type: MinionType): void {
    const rig = b.rig;
    const speedNow = Math.hypot(u.vx, u.vz);
    pose.speed += (speedNow - pose.speed) * (1 - Math.exp(-dt * 10));
    pose.phase += dt * pose.speed * (type === 'brute' ? 1.7 : 2.6);
    pose.flinchVel += (-pose.flinch * 90 - pose.flinchVel * 9) * dt;
    pose.flinch += pose.flinchVel * dt;
    const walk = Math.min(1, pose.speed / 3);
    const swing = Math.sin(pose.phase) * 0.55 * walk;
    const bob = Math.abs(Math.cos(pose.phase)) * 0.05 * walk;

    // root: feet, facing, death fall
    const fall = death < 0 ? 0 : Math.min(1, death / 0.5);
    const sink = death < 0 ? 0 : Math.max(0, death - 0.8) * 0.9;
    this.root.position.set(pos.x, pos.y + bob - sink, pos.z);
    // melee swings lunge into the blow; everyone breathes when standing
    const t0 = u.sinceAction;
    const lunge = death < 0 && type !== 'archer' && t0 < 0.4 ? Math.sin((t0 / 0.4) * Math.PI) * 0.22 : 0;
    const breathe = Math.sin(performance.now() / 700 + pose.phase) * 0.015 * (1 - walk);
    this.root.rotation.set(-fall * fall * 1.5 - pose.flinch * 0.06 + walk * 0.08 + lunge + breathe, u.body.yaw + Math.PI + fall * pose.side * 0.5, fall * pose.side * 0.35, 'YXZ');
    this.root.scale.setScalar(rig.scale);
    this.root.updateMatrix();

    const index = b.count;
    const write = (p: Part) => {
      this.part.updateMatrix();
      this.m.multiplyMatrices(this.root.matrix, this.part.matrix);
      for (const { mesh, ids } of b.slots[p]) mesh.setMatrixAt(ids[index]!, this.m);
    };
    this.part.scale.set(1, 1, 1);
    this.part.position.set(0, 0, 0);
    this.part.rotation.set(0, Math.sin(pose.phase) * 0.08 * walk, 0);
    write('body');
    for (const [p, sx, s] of [['legL', -1, 1], ['legR', 1, -1]] as const) {
      this.part.position.set(sx * rig.hipX, rig.hipY, 0);
      this.part.rotation.set(swing * s * (death < 0 ? 1 : 0), 0, 0);
      write(p);
    }
    // weapon arm: swings with the walk; an attack winds up and strikes
    const t = u.sinceAction;
    let armX = -swing * 0.6;
    if (death < 0 && t < 0.6) {
      if (type === 'archer') {
        // raise to the bowstring, hold, release
        const k = t < 0.15 ? t / 0.15 : t < 0.3 ? 1 : 1 - (t - 0.3) / 0.3;
        armX = -1.45 * k;
      } else {
        const k = t / 0.4;
        armX = k < 0.35 ? -2.3 * (k / 0.35) : k < 1 ? -2.3 + 3.0 * ((k - 0.35) / 0.65) : 0.7 * Math.max(0, 1 - (t - 0.4) / 0.2);
      }
    }
    this.part.position.copy(rig.shoulder);
    this.part.rotation.set(armX, 0, type === 'archer' ? -0.25 : 0.12);
    write('arm');
  }
}
