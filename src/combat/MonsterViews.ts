import * as THREE from 'three/webgpu';
import { float, mix, mx_noise_float, normalWorld, positionLocal, positionWorld, smoothstep, uv, vec3 } from '../render/tsl';
import type { CampKind } from '../map/ConquestLayout';
import { BUFF_COLOR } from '../scene/conquest/Props';
import type { Unit } from '../sim/Unit';

/**
 * Jungle monsters. Two original designs:
 *  - Thornbacks: stocky tusked boars with a ridge of bone spines whose tips
 *    glow amber, mossy fur, ember eyes. The camp's Alpha is half again as big
 *    with an extra crest of crystal shards.
 *  - Wardens: hulking mossy stone guardians that keep the buff altars, with
 *    a crystal heart, eye slit and rune bands lit in the buff's color, and
 *    shards orbiting their heads. They wind up a two-fisted slam.
 * Each monster is a small hierarchy of rigid parts posed every frame.
 */

/** Buff camp colors: the map's altar crystal colors, so a Warden matches its altar. */
export const BUFF_GLOW = BUFF_COLOR;

const AMBER = 0xffa53a;

export interface MonsterView {
  root: THREE.Group;
  height: number;
  /** Pose for this frame. `windup` is the sim's slam windup, `wobble` the hit spring. */
  animate(u: Unit, dt: number, deathTime: number, wobble: number): void;
}

// ---------------------------------------------------------------------------
// Materials (shared by every monster)

let shared: ReturnType<typeof buildShared> | null = null;
const glowCache = new Map<number, THREE.Material>();

function n(s: number, p = positionLocal) {
  return mx_noise_float(p.mul(s)).mul(0.5).add(0.5);
}

function buildShared() {
  // shaggy fur: dark umber with moss-green tips, darker underneath
  const fur = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x8fa060) });
  const streak = mx_noise_float(vec3(positionLocal.x.mul(18), positionLocal.y.mul(5), positionLocal.z.mul(18))).mul(0.5).add(0.5);
  const top = smoothstep(-0.2, 0.8, normalWorld.y);
  fur.colorNode = mix(vec3(0.09, 0.06, 0.035), mix(vec3(0.24, 0.16, 0.08), vec3(0.3, 0.34, 0.12), n(4).mul(top)), streak.mul(0.6).add(top.mul(0.4)));
  // bare hide on the snout and legs
  const hide = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  hide.colorNode = mix(vec3(0.2, 0.12, 0.08), vec3(0.34, 0.22, 0.15), n(14));
  // bone that heats up to amber toward its tip (cone uv.y is 1 at the tip)
  const bone = new THREE.MeshStandardNodeMaterial({ roughness: 0.45 });
  const tip = smoothstep(0.45, 1, uv().y);
  bone.colorNode = mix(vec3(0.82, 0.76, 0.6), vec3(1, 0.62, 0.22), tip);
  bone.emissiveNode = vec3(1, 0.45, 0.1).mul(tip.mul(tip).mul(2.2));
  const hoof = new THREE.MeshStandardNodeMaterial({ color: 0x1b1410, roughness: 0.5 });
  // weathered stone with moss on every upward face
  const stone = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
  const grain = n(3.5, positionWorld).mul(0.6).add(n(14, positionWorld).mul(0.4));
  const moss = smoothstep(0.2, 0.7, normalWorld.y.add(n(2.2, positionWorld).sub(0.5).mul(0.7)));
  const rockCol = mix(vec3(0.16, 0.16, 0.19), vec3(0.38, 0.35, 0.32), grain);
  stone.colorNode = mix(rockCol, mix(vec3(0.17, 0.3, 0.07), vec3(0.32, 0.46, 0.12), n(9, positionWorld)), moss.mul(0.92));
  stone.roughnessNode = float(0.95).sub(moss.mul(0.1));
  return { fur, hide, bone, hoof, stone };
}

function mats() {
  return (shared ??= buildShared());
}

/** Unlit HDR glow so bloom picks it up. */
function glow(hex: number, strength = 4): THREE.Material {
  const key = hex * 16 + strength;
  let m = glowCache.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    const g = new THREE.MeshBasicNodeMaterial();
    g.colorNode = vec3(c.r, c.g, c.b).mul(float(strength).mul(n(30).mul(0.4).add(0.8)));
    glowCache.set(key, (m = g));
  }
  return m;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
}

/**
 * A chunky rock for the Warden's body: a round lump with soft facets, not
 * squashed flat like the map's boulders, so the parts overlap into one body.
 */
function rock(radius: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 3);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const f = (x: number, y: number, z: number) =>
    Math.sin(x * 2.1 + seed) * Math.sin(y * 2.3 + seed * 1.7) * Math.sin(z * 1.9 + seed * 0.6);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).divideScalar(radius);
    let d = 1 + f(v.x * 1.5, v.y * 1.5, v.z * 1.5) * 0.16 + f(v.x * 4, v.y * 4, v.z * 4) * 0.05;
    // a few flat fractured faces
    d -= Math.max(0, Math.abs(v.x * 0.8 + v.z * 0.5 + Math.sin(seed)) - 0.75) * 0.5;
    v.multiplyScalar(d * radius);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function mesh(parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, shadow = true): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  o.castShadow = shadow;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}

function pivot(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------------------
// Thornback

function thornback(alpha: boolean): MonsterView {
  const m = mats();
  const root = new THREE.Group();
  const s = alpha ? 1.8 : 1.25;
  const rig = pivot(root, 0, 0, 0);
  rig.scale.setScalar(s);
  const body = pivot(rig, 0, 0.72, 0);
  // barrel body with a hump over the shoulders, front sitting higher
  mesh(body, geo('tb-body', () => new THREE.SphereGeometry(0.5, 24, 16).scale(0.62, 0.55, 1)), m.fur, 0, 0, -0.05, 0.08);
  mesh(body, geo('tb-hump', () => new THREE.SphereGeometry(0.42, 20, 14).scale(0.85, 0.85, 1)), m.fur, 0, 0.12, 0.25);
  mesh(body, geo('tb-tail', () => new THREE.ConeGeometry(0.06, 0.3, 8)), m.hide, 0, 0.08, -0.55, -2.2);
  // ridge of spines along the back, tilted toward the tail
  const spines = alpha ? 11 : 7;
  for (let i = 0; i < spines; i++) {
    const k = i / (spines - 1);
    const len = (0.32 + Math.sin(k * Math.PI) * 0.28) * (alpha ? 1.15 : 1);
    const g = geo(`tb-spine-${len.toFixed(2)}`, () => new THREE.ConeGeometry(0.05, len, 7).translate(0, len / 2, 0));
    const z = 0.42 - k * 0.85;
    const y = 0.26 + Math.sin(k * Math.PI) * 0.08 + (1 - k) * 0.04;
    mesh(body, g, m.bone, 0, y, z, -0.55 - k * 0.4, 0, 0);
    // smaller side rows
    if (i % 2 === 0 && i > 0 && i < spines - 1) {
      for (const sx of [-1, 1]) mesh(body, g, m.bone, sx * 0.17, y - 0.08, z, -0.6 - k * 0.3, 0, sx * 0.5).scale.setScalar(0.6);
    }
  }
  if (alpha) {
    // the Alpha's crest: amber crystal shards over the shoulders
    const shard = geo('tb-shard', () => new THREE.OctahedronGeometry(0.1, 0).scale(0.6, 1.8, 0.6).translate(0, 0.16, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.32;
      mesh(body, shard, glow(AMBER, 3), Math.sin(a) * 0.32, 0.38 + Math.cos(a) * 0.04, 0.3, -0.3, 0, -a * 1.2);
    }
  }
  // head on a neck pivot so it can bob and thrust
  const head = pivot(body, 0, 0.05, 0.55);
  mesh(head, geo('tb-skull', () => new THREE.SphereGeometry(0.27, 20, 14).scale(0.9, 0.82, 1.15)), m.fur, 0, 0, 0.1);
  // tapering snout ending in a leathery nose pad with nostrils
  mesh(head, geo('tb-snout', () => new THREE.CylinderGeometry(0.1, 0.16, 0.3, 14).rotateX(Math.PI / 2).scale(1.1, 0.9, 1)), m.hide, 0, -0.07, 0.36);
  mesh(head, geo('tb-nose', () => new THREE.SphereGeometry(0.11, 14, 10).scale(1.15, 0.85, 0.45)), m.hide, 0, -0.07, 0.51);
  for (const sx of [-1, 1]) mesh(head, geo('tb-nostril', () => new THREE.SphereGeometry(0.025, 8, 6)), m.hoof, sx * 0.045, -0.06, 0.555, 0, 0, 0, false);
  const tusk = geo('tb-tusk', () => new THREE.ConeGeometry(0.035, 0.26, 8).translate(0, 0.13, 0));
  for (const sx of [-1, 1]) {
    mesh(head, tusk, m.bone, sx * 0.12, -0.12, 0.42, -0.5, 0, -sx * 0.35);
    mesh(head, geo('tb-eye', () => new THREE.SphereGeometry(0.035, 10, 8)), glow(AMBER, 6), sx * 0.13, 0.07, 0.28, 0, 0, 0, false);
    mesh(head, geo('tb-ear', () => new THREE.ConeGeometry(0.07, 0.18, 6).translate(0, 0.09, 0)), m.fur, sx * 0.17, 0.16, 0.02, -0.7, 0, -sx * 0.6);
  }
  // four legs hanging from hip pivots
  const legs: THREE.Group[] = [];
  for (const [x, z] of [[-0.22, 0.32], [0.22, 0.32], [-0.22, -0.34], [0.22, -0.34]] as const) {
    const leg = pivot(body, x, -0.12, z);
    mesh(leg, geo('tb-thigh', () => new THREE.CapsuleGeometry(0.1, 0.22, 4, 10)), m.fur, 0, -0.14, 0);
    mesh(leg, geo('tb-shin', () => new THREE.CapsuleGeometry(0.065, 0.24, 4, 8)), m.hide, 0, -0.38, 0.02);
    mesh(leg, geo('tb-hoof', () => new THREE.CylinderGeometry(0.07, 0.085, 0.08, 10)), m.hoof, 0, -0.56, 0.03);
    legs.push(leg);
  }

  let phase = Math.random() * 10;
  let breath = Math.random() * 10;
  return {
    root,
    height: 1.25 * s,
    animate(u, dt, deathTime, wobble) {
      const speed = Math.hypot(u.vx, u.vz);
      phase += dt * (3 + speed * 2.2);
      breath += dt * 2.2;
      const gait = Math.min(1, speed / 2);
      // trot: diagonal pairs swing together
      const sw = Math.sin(phase) * 0.7 * gait;
      legs[0]!.rotation.x = sw;
      legs[3]!.rotation.x = sw;
      legs[1]!.rotation.x = -sw;
      legs[2]!.rotation.x = -sw;
      body.position.y = 0.72 + Math.abs(Math.cos(phase)) * 0.05 * gait + Math.sin(breath) * 0.01;
      // gore: dip the head, then toss the tusks up
      const a = u.sinceAction;
      const gore = a < 0.45 ? Math.sin((a / 0.45) * Math.PI) : 0;
      head.rotation.x = gore * 0.55 - Math.sin(breath * 0.5) * 0.05 + (a < 0.2 ? 0.25 : 0) * (1 - a / 0.2);
      head.position.z = 0.55 + gore * 0.12;
      body.rotation.x = -gore * 0.08 + wobble * 0.05;
      body.rotation.z = wobble * 0.08;
      if (deathTime >= 0) {
        // keel over on its side, then sink into the ground
        const t = Math.min(1, deathTime / 0.5);
        body.rotation.z = t * t * 1.5;
        body.position.y = 0.72 - t * 0.35 - Math.max(0, deathTime - 1.6) * 0.5;
        for (const l of legs) l.rotation.x *= 1 - t;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Warden

function warden(buff: number): MonsterView {
  const m = mats();
  const lit = glow(buff, 5);
  const dim = glow(buff, 2.2);
  const root = new THREE.Group();
  const hips = pivot(root, 0, 1.25, 0);
  mesh(hips, geo('wd-pelvis', () => rock(0.66, 11)), m.stone, 0, 0, 0);
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = pivot(hips, sx * 0.55, -0.05, 0);
    mesh(leg, geo('wd-thigh', () => rock(0.46, 12).scale(1, 1.6, 1)), m.stone, 0, -0.45, 0);
    mesh(leg, geo('wd-foot', () => rock(0.5, 13).scale(1.1, 0.75, 1.35)), m.stone, 0, -1.0, 0.12);
    legs.push(leg);
  }
  // torso leans forward from the waist
  const torso = pivot(hips, 0, 0.25, 0);
  torso.rotation.x = 0.18;
  mesh(torso, geo('wd-chest', () => rock(1.05, 14).scale(1.3, 1.25, 0.95)), m.stone, 0, 0.9, 0);
  mesh(torso, geo('wd-back', () => rock(0.75, 15)), m.stone, 0, 1.35, -0.45);
  // the crystal heart in a ring of runes
  const heart = mesh(torso, geo('wd-heart', () => new THREE.OctahedronGeometry(0.26, 0).scale(0.8, 1.3, 0.6)), lit, 0, 0.95, 0.82, 0, 0, 0, false);
  const ring = mesh(torso, geo('wd-ring', () => new THREE.TorusGeometry(0.42, 0.035, 6, 32)), dim, 0, 0.95, 0.78, 0, 0, 0, false);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    mesh(torso, geo('wd-rune', () => new THREE.BoxGeometry(0.05, 0.16, 0.04)), dim, Math.cos(a) * 0.56, 0.95 + Math.sin(a) * 0.56, 0.72, 0, 0, a, false);
  }
  // small head sunk between the shoulders, with a glowing eye slit
  const head = pivot(torso, 0, 1.75, 0.35);
  mesh(head, geo('wd-head', () => rock(0.4, 16).scale(1, 1.05, 1)), m.stone, 0, 0, 0);
  mesh(head, geo('wd-brow', () => new THREE.BoxGeometry(0.46, 0.06, 0.08)), lit, 0, 0.03, 0.3, 0, 0, 0, false);
  // shards orbiting the head
  const orbit = pivot(head, 0, 0.35, 0);
  const shard = geo('wd-shard', () => new THREE.OctahedronGeometry(0.1, 0).scale(0.6, 1.6, 0.6));
  const shards = [0, 1, 2].map((i) => mesh(orbit, shard, lit, Math.cos((i / 3) * Math.PI * 2) * 0.7, 0, Math.sin((i / 3) * Math.PI * 2) * 0.7, 0, 0, 0, false));
  // arms: shoulder boulder, upper arm, forearm and a huge fist, with rune bands
  const arms: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    mesh(torso, geo('wd-shoulder', () => rock(0.66, 17)), m.stone, sx * 1.22, 1.5, 0);
    const arm = pivot(torso, sx * 1.35, 1.35, 0.05);
    arm.rotation.z = sx * 0.12;
    mesh(arm, geo('wd-upper', () => rock(0.44, 18).scale(1, 1.9, 1)), m.stone, 0, -0.55, 0);
    mesh(arm, geo('wd-band', () => new THREE.TorusGeometry(0.36, 0.035, 6, 24).rotateX(Math.PI / 2)), dim, 0, -0.85, 0, 0, 0, 0, false);
    mesh(arm, geo('wd-fore', () => rock(0.5, 19).scale(1, 1.7, 1)), m.stone, 0, -1.3, 0.05);
    mesh(arm, geo('wd-fist', () => rock(0.64, 20).scale(1.05, 0.95, 1.1)), m.stone, 0, -1.95, 0.1);
    arms.push(arm);
  }

  let phase = Math.random() * 10;
  let t = Math.random() * 10;
  let raise = 0;
  return {
    root,
    height: 3.6,
    animate(u, dt, deathTime, wobble) {
      t += dt;
      const speed = Math.hypot(u.vx, u.vz);
      const gait = Math.min(1, speed / 1.5);
      phase += dt * (1.5 + speed * 1.4);
      // heavy stomping walk with a side-to-side sway
      legs[0]!.rotation.x = Math.sin(phase) * 0.45 * gait;
      legs[1]!.rotation.x = -Math.sin(phase) * 0.45 * gait;
      hips.position.y = 1.25 + Math.abs(Math.cos(phase)) * 0.08 * gait + Math.sin(t * 1.3) * 0.03;
      torso.rotation.z = Math.sin(phase) * 0.06 * gait + wobble * 0.03;
      // slam: raise both fists overhead during the windup, then bring them down
      const a = u.sinceAction;
      const goal = u.windup > 0 ? 1 : 0;
      raise += (goal - raise) * (1 - Math.exp(-dt * (goal ? 9 : 26)));
      const smash = a < 0.35 ? Math.sin((a / 0.35) * Math.PI) : 0;
      for (const [i, arm] of arms.entries()) {
        const sx = i === 0 ? -1 : 1;
        const swing = Math.sin(phase + i * Math.PI) * 0.35 * gait;
        arm.rotation.x = -raise * 2.6 + smash * 0.7 + swing;
        arm.rotation.z = sx * (0.12 + raise * 0.3);
      }
      torso.rotation.x = 0.18 - raise * 0.25 + smash * 0.35;
      // living crystal: the heart pulses, the shards orbit, the head looks about
      const pulse = 1 + Math.sin(t * 3) * 0.08 + raise * 0.25;
      heart.scale.setScalar(pulse);
      heart.rotation.y = t * 0.8;
      ring.rotation.z = t * 0.4;
      orbit.rotation.y = t * 1.2;
      for (const [i, s] of shards.entries()) s.position.y = Math.sin(t * 2 + i * 2) * 0.12;
      head.rotation.y = Math.sin(t * 0.4) * 0.25 * (1 - gait);
      if (deathTime >= 0) {
        // crumble: the body slumps and sinks, the arms drop, the light goes out
        const k = Math.min(1, deathTime / 1.1);
        hips.position.y = 1.25 - k * k * 1.0 - Math.max(0, deathTime - 1.4) * 0.8;
        torso.rotation.x = 0.18 + k * 0.7;
        for (const arm of arms) arm.rotation.x = k * 0.8;
        heart.scale.setScalar(Math.max(0.01, 1 - k));
        orbit.visible = k < 0.4;
      } else orbit.visible = true;
    },
  };
}

/** The camp kind is encoded in the monster's tag: `<team>-<kind>-<i>:<type>`. */
function campKindOf(u: Unit): CampKind {
  return u.tag.split(':')[0]!.split('-')[1] as CampKind;
}

export function createMonsterView(u: Unit): MonsterView {
  const type = u.tag.split(':')[1];
  if (type === 'warden') return warden(BUFF_GLOW[campKindOf(u)] ?? 0xffffff);
  return thornback(type === 'thornbackAlpha');
}
