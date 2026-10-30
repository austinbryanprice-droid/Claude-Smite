import * as THREE from 'three/webgpu';
import { abs, float, mix, mx_noise_float, mx_worley_noise_float, normalWorld, positionLocal, sin, smoothstep, time, uniform, uv, vec3, vec4 } from '../render/tsl';
import type { CampKind } from '../map/ConquestLayout';
import { BUFF_COLOR } from '../scene/conquest/Props';
import { MonsterBrain } from '../sim/Jungle';
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
export const BUFF_GLOW: Partial<Record<string, number>> = { ...BUFF_COLOR, fury: 0xff6a1a };

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
  // object space, so the stone's pattern stays on the Warden as it walks and swings
  const grain = n(3.5).mul(0.6).add(n(14).mul(0.4));
  const moss = smoothstep(0.2, 0.7, normalWorld.y.add(n(2.2).sub(0.5).mul(0.7)));
  const rockCol = mix(vec3(0.16, 0.16, 0.19), vec3(0.38, 0.35, 0.32), grain);
  stone.colorNode = mix(rockCol, mix(vec3(0.17, 0.3, 0.07), vec3(0.32, 0.46, 0.12), n(9)), moss.mul(0.92));
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
    const g = new THREE.MeshBasicNodeMaterial();
    // uniforms rather than constants, so every glow colour shares one shader
    g.colorNode = uniform(new THREE.Color(hex)).mul(uniform(strength).mul(n(30).mul(0.4).add(0.8)));
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

interface GiantOptions {
  /** Color of the heart, eyes and runes. */
  glow: number;
  /** Body material. */
  stone: THREE.Material;
  scale: number;
  /** The Colossus: a crown of basalt horns, spiked shoulders and a light in its chest. */
  molten?: boolean;
}

/**
 * Stone giants: the Warden, and at twice the size in molten basalt the
 * Molten Colossus. Same rig: stomping walk, two-fist slam, a crumbling death.
 */
function giant(o: GiantOptions): MonsterView {
  const lit = glow(o.glow, 5);
  const dim = glow(o.glow, 2.2);
  const stone = o.stone;
  const root = new THREE.Group();
  const body = pivot(root, 0, 0, 0);
  body.scale.setScalar(o.scale);
  const hips = pivot(body, 0, 1.25, 0);
  mesh(hips, geo('wd-pelvis', () => rock(0.66, 11)), stone, 0, 0, 0);
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const leg = pivot(hips, sx * 0.55, -0.05, 0);
    mesh(leg, geo('wd-thigh', () => rock(0.46, 12).scale(1, 1.6, 1)), stone, 0, -0.45, 0);
    mesh(leg, geo('wd-foot', () => rock(0.5, 13).scale(1.1, 0.75, 1.35)), stone, 0, -1.0, 0.12);
    legs.push(leg);
  }
  // torso leans forward from the waist
  const torso = pivot(hips, 0, 0.25, 0);
  torso.rotation.x = 0.18;
  mesh(torso, geo('wd-chest', () => rock(1.05, 14).scale(1.3, 1.25, 0.95)), stone, 0, 0.9, 0);
  mesh(torso, geo('wd-back', () => rock(0.75, 15)), stone, 0, 1.35, -0.45);
  // the crystal heart in a ring of runes
  const heart = mesh(torso, geo('wd-heart', () => new THREE.OctahedronGeometry(0.26, 0).scale(0.8, 1.3, 0.6)), lit, 0, 0.95, 0.82, 0, 0, 0, false);
  const ring = mesh(torso, geo('wd-ring', () => new THREE.TorusGeometry(0.42, 0.035, 6, 32)), dim, 0, 0.95, 0.78, 0, 0, 0, false);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    mesh(torso, geo('wd-rune', () => new THREE.BoxGeometry(0.05, 0.16, 0.04)), dim, Math.cos(a) * 0.56, 0.95 + Math.sin(a) * 0.56, 0.72, 0, 0, a, false);
  }
  // small head sunk between the shoulders, with a glowing eye slit
  const head = pivot(torso, 0, 1.75, 0.35);
  mesh(head, geo('wd-head', () => rock(0.4, 16).scale(1, 1.05, 1)), stone, 0, 0, 0);
  mesh(head, geo('wd-brow', () => new THREE.BoxGeometry(0.46, 0.06, 0.08)), lit, 0, 0.03, 0.3, 0, 0, 0, false);
  // shards orbiting the head
  const orbit = pivot(head, 0, 0.35, 0);
  const shard = geo('wd-shard', () => new THREE.OctahedronGeometry(0.1, 0).scale(0.6, 1.6, 0.6));
  const shards = [0, 1, 2].map((i) => mesh(orbit, shard, lit, Math.cos((i / 3) * Math.PI * 2) * 0.7, 0, Math.sin((i / 3) * Math.PI * 2) * 0.7, 0, 0, 0, false));
  // arms: shoulder boulder, upper arm, forearm and a huge fist, with rune bands
  const arms: THREE.Group[] = [];
  // a soft halo instead of a real light: adding a light mid-match makes every lit shader recompile
  let core: THREE.Sprite | null = null;
  let embers: Embers | null = null;
  if (o.molten) {
    // a crown of basalt horns with molten tips, spiked shoulders, a fire in its chest
    const horn = geo('mc-horn', () => new THREE.ConeGeometry(0.11, 0.7, 7).translate(0, 0.35, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.42;
      mesh(head, horn, stone, Math.sin(a) * 0.3, 0.3, -0.05 + Math.cos(a) * 0.05, -0.35, 0, -a * 0.9);
      mesh(head, geo('mc-horn-tip', () => new THREE.ConeGeometry(0.05, 0.2, 6).translate(0, 0.62, 0)), lit, Math.sin(a) * 0.3, 0.3, -0.05 + Math.cos(a) * 0.05, -0.35, 0, -a * 0.9, false);
    }
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) mesh(torso, geo('mc-spike', () => new THREE.ConeGeometry(0.14, 0.75, 7).translate(0, 0.37, 0)), stone, sx * (1.15 + i * 0.18), 1.95 - i * 0.12, -0.1 - i * 0.12, -0.3, 0, -sx * (0.5 + i * 0.2));
    }
    embers = makeEmbers(body);
    core = new THREE.Sprite(emberMat!);
    core.position.set(0, 0.95, 0.95);
    torso.add(core);
  }
  for (const sx of [-1, 1]) {
    mesh(torso, geo('wd-shoulder', () => rock(0.66, 17)), stone, sx * 1.22, 1.5, 0);
    const arm = pivot(torso, sx * 1.35, 1.35, 0.05);
    arm.rotation.z = sx * 0.12;
    mesh(arm, geo('wd-upper', () => rock(0.44, 18).scale(1, 1.9, 1)), stone, 0, -0.55, 0);
    mesh(arm, geo('wd-band', () => new THREE.TorusGeometry(0.36, 0.035, 6, 24).rotateX(Math.PI / 2)), dim, 0, -0.85, 0, 0, 0, 0, false);
    mesh(arm, geo('wd-fore', () => rock(0.5, 19).scale(1, 1.7, 1)), stone, 0, -1.3, 0.05);
    mesh(arm, geo('wd-fist', () => rock(0.64, 20).scale(1.05, 0.95, 1.1)), stone, 0, -1.95, 0.1);
    arms.push(arm);
  }

  let phase = Math.random() * 10;
  let t = Math.random() * 10;
  let raise = 0;
  return {
    root,
    height: 3.6 * o.scale,
    animate(u, dt, deathTime, wobble) {
      t += dt;
      // a boss's area attack: crouch and raise both fists high, then smash
      const special = u.brain instanceof MonsterBrain ? u.brain.specialProgress : 0;
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
      const goal = u.windup > 0 || special > 0 ? 1 : 0;
      raise += (goal - raise) * (1 - Math.exp(-dt * (goal ? 9 : 26)));
      const smash = a < 0.35 ? Math.sin((a / 0.35) * Math.PI) : 0;
      for (const [i, arm] of arms.entries()) {
        const sx = i === 0 ? -1 : 1;
        const swing = Math.sin(phase + i * Math.PI) * 0.35 * gait;
        arm.rotation.x = -raise * (2.6 + special * 0.4) + smash * 0.7 + swing;
        arm.rotation.z = sx * (0.12 + raise * 0.3 - special * 0.2);
      }
      torso.rotation.x = 0.18 - raise * 0.25 + smash * 0.35 - special * 0.15;
      hips.position.y -= special * 0.25;
      core?.scale.setScalar(1.3 + raise * 0.9 + Math.sin(t * 5) * 0.12);
      embers?.step(dt, deathTime >= 0 ? 0 : 1 + raise * 2);
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
        core?.scale.setScalar(Math.max(0.001, 1.3 * (1 - k)));
        orbit.visible = k < 0.4;
      } else orbit.visible = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Molten Colossus material

const EMBERS = 26;
let emberMat: THREE.SpriteNodeMaterial | null = null;

interface Embers {
  /** Advance the sparks; `rate` scales how fast they rise and how many show (0 lets them die out). */
  step(dt: number, rate: number): void;
}

/** Sparks that drift up off the Colossus's body and wink out. */
function makeEmbers(parent: THREE.Object3D): Embers {
  if (!emberMat) {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = uv().sub(0.5).length().mul(2);
    const f = smoothstep(1, 0, r).pow(2);
    m.colorNode = vec4(vec3(1, 0.42, 0.08).mul(6).add(smoothstep(0.3, 0, r).mul(4)).mul(f), 1);
    m.opacityNode = f;
    emberMat = m;
  }
  const sparks = Array.from({ length: EMBERS }, () => {
    const s = new THREE.Sprite(emberMat!);
    parent.add(s);
    return { s, age: Math.random() * 2.5, life: 1.6 + Math.random() * 1.4, x: 0, y: 0, z: 0, vx: 0, vz: 0 };
  });
  const respawn = (p: (typeof sparks)[number]) => {
    const a = Math.random() * Math.PI * 2;
    const r = 0.5 + Math.random() * 1.1;
    p.x = Math.cos(a) * r;
    p.z = Math.sin(a) * r * 0.7;
    p.y = 0.6 + Math.random() * 2.2;
    p.vx = (Math.random() - 0.5) * 0.3;
    p.vz = (Math.random() - 0.5) * 0.3;
    p.age = 0;
  };
  for (const p of sparks) respawn(p);
  return {
    step(dt, rate) {
      for (const p of sparks) {
        p.age += dt * Math.max(0.5, rate);
        if (p.age > p.life) {
          if (rate <= 0) {
            p.s.visible = false;
            continue;
          }
          respawn(p);
        }
        const k = p.age / p.life;
        p.s.visible = true;
        p.s.position.set(p.x + p.vx * p.age + Math.sin(p.age * 3 + p.life) * 0.08, p.y + p.age * 0.9, p.z + p.vz * p.age);
        // flare in, then shrink to nothing
        p.s.scale.setScalar(0.14 * Math.min(1, k * 6) * (1 - k));
      }
    },
  };
}

let lava: THREE.Material | null = null;

/** Black basalt split by a network of glowing molten cracks that throb slowly. */
function lavaStone(): THREE.Material {
  if (lava) return lava;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
  // object space, so the cracks stay put on the Colossus's body as it moves
  const p = positionLocal;
  const basalt = mix(vec3(0.05, 0.04, 0.04), vec3(0.17, 0.13, 0.12), n(2.5, p).mul(0.7).add(n(11, p).mul(0.3)));
  // noise zero-crossings make a branching crack network; a finer octave adds hairline cracks
  const wide = smoothstep(0.06, 0.0, abs(mx_noise_float(p.mul(0.9))));
  const fine = smoothstep(0.03, 0.0, abs(mx_noise_float(p.mul(2.6).add(7)))).mul(0.45);
  const crack = wide.add(fine).clamp(0, 1);
  const throb = sin(time.mul(1.8).add(n(0.6, p).mul(6))).mul(0.25).add(0.85);
  m.colorNode = mix(basalt, vec3(1, 0.45, 0.12), crack.mul(0.6));
  m.emissiveNode = mix(vec3(1, 0.22, 0.02), vec3(1, 0.7, 0.25), crack.pow(3)).mul(crack.mul(throb).mul(4));
  m.roughnessNode = float(0.92).sub(crack.mul(0.4));
  return (lava = m);
}

// ---------------------------------------------------------------------------
// Treasure Wyrm

const WYRM_SEGMENTS = 36;
const FORWARD = new THREE.Vector3(0, 0, 1);
/** Where the coil ends and the neck rises, along the body (0 = tail tip, 1 = head). */
const COIL_END = 0.62;

/** Body thickness along the wyrm: a thin tail, a heavy coil, a tapering neck. */
function wyrmRadius(s: number): number {
  if (s < COIL_END) return 0.12 + 0.68 * Math.min(1, s / 0.45) ** 0.7;
  return 0.8 - ((s - COIL_END) / (1 - COIL_END)) * 0.3;
}

function bezier(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, t: number): THREE.Vector3 {
  const u = 1 - t;
  return out
    .copy(a)
    .multiplyScalar(u * u * u)
    .addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t)
    .addScaledVector(d, t * t * t);
}

/**
 * A great golden serpent coiled on its hoard: overlapping gold scales with a
 * cream belly, turquoise crystal fins down its spine, a horned head with a
 * ruby set in its brow. It sways, lunges to bite, lifts its tail and whirls
 * for its sweep, and slumps onto its coils when slain.
 */
function wyrm(): MonsterView {
  const scales = new THREE.MeshPhysicalNodeMaterial({ metalness: 0.8, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  // object space: the coils move every frame, and world-space scales would slide across them
  const cell = mx_worley_noise_float(positionLocal.mul(3.2));
  const rim = smoothstep(0.15, 0.55, cell);
  const belly = smoothstep(-0.05, -0.45, normalWorld.y);
  const gold = mix(vec3(1, 0.8, 0.32), vec3(0.5, 0.27, 0.06), rim);
  scales.colorNode = mix(gold, vec3(0.95, 0.86, 0.62), belly.mul(0.85));
  scales.roughnessNode = float(0.22).add(rim.mul(0.3)).add(belly.mul(0.3));
  scales.metalnessNode = float(0.9).sub(belly.mul(0.6));
  const fin = glow(0x2fe8d0, 2.6);
  const finHot = glow(0x8ffff0, 4);
  const ruby = glow(0xff2a4a, 5);
  const ivory = new THREE.MeshStandardNodeMaterial({ color: 0xf2e6c8, roughness: 0.4 });

  const root = new THREE.Group();
  const body = pivot(root, 0, 0, 0);
  const seg = geo('wy-seg', () => new THREE.SphereGeometry(1, 20, 14));
  const finGeo = geo('wy-fin', () => new THREE.ConeGeometry(0.16, 1, 4).translate(0, 0.5, 0).scale(0.5, 1, 1.6));
  const segs = Array.from({ length: WYRM_SEGMENTS }, () => mesh(body, seg, scales));
  const fins = segs.map((_, i) => (i % 2 === 0 && i > 2 ? mesh(body, finGeo, i > WYRM_SEGMENTS * 0.8 ? finHot : fin, 0, 0, 0, 0, 0, 0, false) : null));

  // the head: skull, snout, jaw on a hinge, horns, frills, eyes and the brow ruby (front is +Z)
  const head = pivot(body, 0, 0, 0);
  mesh(head, geo('wy-skull', () => new THREE.SphereGeometry(0.62, 22, 16).scale(0.95, 0.75, 1.15)), scales, 0, 0.05, 0);
  mesh(head, geo('wy-snout', () => new THREE.SphereGeometry(0.42, 18, 12).scale(0.85, 0.55, 1.6)), scales, 0, 0.0, 0.75);
  mesh(head, geo('wy-brow', () => new THREE.SphereGeometry(0.2, 10, 8).scale(1, 0.6, 1)), ruby, 0, 0.42, 0.3, 0, 0, 0, false);
  for (const sx of [-1, 1]) {
    mesh(head, geo('wy-eye', () => new THREE.SphereGeometry(0.09, 10, 8).scale(1, 0.7, 1.3)), finHot, sx * 0.4, 0.2, 0.45, 0, 0, 0, false);
    const horn = geo('wy-horn', () => new THREE.ConeGeometry(0.11, 1.5, 9).translate(0, 0.75, 0));
    mesh(head, horn, ivory, sx * 0.32, 0.35, -0.25, -1.9, 0, -sx * 0.35);
    mesh(head, geo('wy-horn2', () => new THREE.ConeGeometry(0.07, 0.8, 8).translate(0, 0.4, 0)), ivory, sx * 0.5, 0.15, -0.3, -1.7, 0, -sx * 0.9);
    // crystal frills fanning back from the jaw
    for (let i = 0; i < 3; i++) mesh(head, finGeo, fin, sx * 0.55, -0.05 - i * 0.12, -0.15 - i * 0.1, -1.4 - i * 0.15, 0, -sx * (1.1 + i * 0.25), false).scale.set(1, 0.7 - i * 0.12, 0.6);
    for (let i = 0; i < 4; i++) mesh(head, geo('wy-tooth', () => new THREE.ConeGeometry(0.035, 0.16, 6)), ivory, sx * (0.12 + i * 0.07), -0.2, 1.15 - i * 0.18, Math.PI, 0, 0);
  }
  const jaw = pivot(head, 0, -0.15, 0.15);
  mesh(jaw, geo('wy-jaw', () => new THREE.SphereGeometry(0.36, 16, 10).scale(0.85, 0.35, 1.7)), scales, 0, -0.1, 0.5);
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) mesh(jaw, geo('wy-tooth', () => new THREE.ConeGeometry(0.035, 0.16, 6)), ivory, sx * (0.12 + i * 0.07), 0.02, 0.95 - i * 0.18);

  const P = Array.from({ length: WYRM_SEGMENTS }, () => new THREE.Vector3());
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const tan = new THREE.Vector3();
  const up = new THREE.Vector3();
  const side = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  let t = Math.random() * 10;
  let bite = 0;
  let spin = 0;
  return {
    root,
    height: 5.6,
    animate(u, dt, deathTime, wobble) {
      t += dt;
      const special = u.brain instanceof MonsterBrain ? u.brain.specialProgress : 0;
      const since = u.sinceAction;
      // bite: wind up (rear back) then lunge forward and down
      const goal = u.windup > 0 ? -0.4 : since < 0.35 ? Math.sin((since / 0.35) * Math.PI) : 0;
      bite += (goal - bite) * (1 - Math.exp(-dt * 14));
      // tail sweep: after the special lands, the whole wyrm whirls once
      const whirl = since < 0.6 && special === 0 && u.windup <= 0 && spin > 0 ? since / 0.6 : 0;
      if (special > 0) spin = 1;
      if (since >= 0.6) spin = 0;
      body.rotation.y = whirl > 0 ? (1 - (1 - whirl) ** 3) * Math.PI * 2 : 0;
      const dead = deathTime >= 0 ? Math.min(1, deathTime / 1.2) : 0;
      // the coil, spiraling out from the tail tip to the back of the hoard
      const coilN = Math.round(WYRM_SEGMENTS * COIL_END);
      for (let i = 0; i < coilN; i++) {
        const s = i / (WYRM_SEGMENTS - 1);
        const k = s / COIL_END;
        const phi = Math.PI - (1 - k) * Math.PI * 2 * 1.45;
        const R = 0.9 + 2.7 * k;
        const lift = special * Math.max(0, 1 - k * 2.2) * 2.2 + Math.sin(t * 2 + k * 9) * 0.05 * (1 - k);
        P[i]!.set(Math.sin(phi) * R, wyrmRadius(s) * 0.85 + lift * (1 - dead), Math.cos(phi) * R);
      }
      // the neck: a curve rising from the back of the coil, swaying, lunging for bites
      const end = P[coilN - 1]!;
      a.copy(end);
      b.set(end.x - 2, end.y + 0.6, end.z + 0.4);
      c.set(-0.4 + Math.sin(t * 0.9) * 0.5 + wobble * 0.1, 5.6 - special * 0.6, -1.2 + bite * 1.0 - special * 0.8);
      d.set(Math.sin(t * 1.1) * 0.4, 4.7 - bite * 1.9 + special * 0.6 + Math.sin(t * 1.7) * 0.15, 1.4 + bite * 2.3 - special * 1.2);
      if (dead > 0) {
        // slump: the neck falls forward across the coils
        c.lerp(b.clone().setY(0.9), dead);
        d.lerp(new THREE.Vector3(d.x, 0.7, 3.2), dead);
      }
      for (let i = coilN; i < WYRM_SEGMENTS; i++) {
        const k = (i - coilN + 1) / (WYRM_SEGMENTS - coilN);
        bezier(P[i]!, a, b, c, d, k);
      }
      // place each scale segment along the curve, stretched along it so they overlap
      for (let i = 0; i < WYRM_SEGMENTS; i++) {
        const p = P[i]!;
        tan.subVectors(P[Math.min(WYRM_SEGMENTS - 1, i + 1)]!, P[Math.max(0, i - 1)]!).normalize();
        up.set(0, 1, 0);
        if (Math.abs(tan.y) > 0.9) up.set(0, 0, -1);
        side.crossVectors(up, tan).normalize();
        up.crossVectors(tan, side).normalize();
        basis.makeBasis(side, up, tan);
        const r = wyrmRadius(i / (WYRM_SEGMENTS - 1));
        const sm = segs[i]!;
        sm.position.copy(p);
        sm.quaternion.setFromRotationMatrix(basis);
        sm.scale.set(r, r * 0.92, r * 1.55);
        const f = fins[i];
        if (f) {
          f.position.copy(p).addScaledVector(up, r * 0.8);
          f.quaternion.setFromRotationMatrix(basis);
          f.rotateX(-0.5);
          f.scale.setScalar(0.5 + r * 1.1);
        }
      }
      // the head rides the end of the neck, looking along it and a little down
      const last = P[WYRM_SEGMENTS - 1]!;
      tan.subVectors(last, P[WYRM_SEGMENTS - 2]!).normalize();
      head.position.copy(last).addScaledVector(tan, 0.4);
      // (in the body's own frame: lookAt would want world space)
      head.quaternion.setFromUnitVectors(FORWARD, tan.setY(tan.y * 0.3 - 0.35).normalize());
      jaw.rotation.x = Math.max(0, bite) * 0.7 + Math.max(0, -bite) * 0.4 + special * 0.5 + (dead > 0 ? 0.3 : 0);
      root.position.y = -Math.max(0, deathTime - 1.8) * 0.6;
    },
  };
}

/** The camp kind is encoded in the monster's tag: `<team>-<kind>-<i>:<type>`. */
function campKindOf(u: Unit): CampKind {
  return u.tag.split(':')[0]!.split('-')[1] as CampKind;
}

/**
 * One of every monster, for drawing once while the match loads so their
 * shaders are compiled before the first camp appears instead of mid-fight.
 */
export function monsterWarmup(): THREE.Object3D[] {
  const buffs = ['might', 'wisdom', 'swiftness', 'insight'] as const;
  return [
    thornback(false),
    thornback(true),
    ...buffs.map((b) => giant({ glow: BUFF_GLOW[b] ?? 0xffffff, stone: mats().stone, scale: 1 })),
    giant({ glow: 0xff6a1a, stone: lavaStone(), scale: 2.1, molten: true }),
    wyrm(),
  ].map((v) => v.root);
}

export function createMonsterView(u: Unit): MonsterView {
  const type = u.tag.split(':')[1];
  if (type === 'warden') return giant({ glow: BUFF_GLOW[campKindOf(u)] ?? 0xffffff, stone: mats().stone, scale: 1 });
  if (type === 'moltenColossus') return giant({ glow: 0xff6a1a, stone: lavaStone(), scale: 2.1, molten: true });
  if (type === 'treasureWyrm') return wyrm();
  return thornback(type === 'thornbackAlpha');
}
