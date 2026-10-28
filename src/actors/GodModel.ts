import * as THREE from 'three/webgpu';
import {
  color, float, fract, max, min, mix, mx_noise_float, positionLocal, sin, smoothstep, step, time, uniform, uv, vec3,
} from '../render/tsl';
import { lathe } from '../scene/Architecture';

/** Locomotion input the model animates from. All values are per frame. */
export interface LocomotionState {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Movement direction relative to facing: x = right, y = forward (normalized or zero). */
  localDir: THREE.Vector2;
  grounded: boolean;
  /** Vertical velocity, m/s (for jump poses). */
  verticalSpeed: number;
}

interface Limb {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  end: THREE.Object3D;
}

/**
 * Placeholder god: a procedurally modeled armored figure (about 2.4 m, gods
 * are larger than mortals) with a procedural walk, run, strafe, idle and jump.
 * The real gods will replace the mesh; the animation interface
 * (`animate(dt, state)`) and the attachment points (`hand`, `head`) stay.
 */
export class GodModel {
  readonly root = new THREE.Group();
  readonly hips = new THREE.Group();
  readonly chest = new THREE.Group();
  readonly head = new THREE.Group();
  readonly rightHand: THREE.Object3D;
  readonly leftHand: THREE.Object3D;
  private readonly legs: [Limb, Limb];
  private readonly arms: [Limb, Limb];
  private readonly capeSway = uniform(0);
  private readonly capeLift = uniform(0);
  private phase = 0;
  private smoothedSpeed = 0;
  private hipYaw = 0;
  private breath = 0;
  /** 0..1 blend toward a casting pose, for skills later. */
  castWeight = 0;

  readonly height = 2.45;

  constructor(palette: { cloth?: number; trim?: number; glow?: number } = {}) {
    const skin = new THREE.MeshPhysicalNodeMaterial({ color: 0xb98a6a, roughness: 0.48, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffc4a0) });
    const gold = new THREE.MeshPhysicalNodeMaterial({ color: palette.trim ?? 0xe0b04a, metalness: 1, roughness: 0.24, clearcoat: 0.3 });
    // hammered-metal variation so the armor isn't a flat mirror
    gold.roughnessNode = float(0.22).add(mx_noise_float(positionLocal.mul(38)).mul(0.08));
    const steel = new THREE.MeshPhysicalNodeMaterial({ color: 0x9aa3ad, metalness: 1, roughness: 0.3 });
    const leather = new THREE.MeshStandardNodeMaterial({ color: 0x3b2417, roughness: 0.7 });
    const cloth = new THREE.MeshPhysicalNodeMaterial({
      color: palette.cloth ?? 0x8a1218, roughness: 0.85, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff8a7a), side: THREE.DoubleSide,
    });
    const glowColor = new THREE.Color(palette.glow ?? 0x6fe3ff);
    const eyes = new THREE.MeshBasicNodeMaterial({ color: glowColor });
    eyes.colorNode = color(glowColor).mul(12);

    const m = (g: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    this.root.name = 'god';
    this.root.add(this.hips);
    this.hips.position.y = 1.18;

    // --- pelvis, belt and armored skirt (pteruges)
    m(new THREE.SphereGeometry(0.27, 24, 16).scale(1.25, 0.8, 0.9), leather, this.hips, 0, 0.02, 0);
    m(new THREE.TorusGeometry(0.31, 0.055, 12, 40).rotateX(Math.PI / 2).scale(1.15, 1, 0.9), gold, this.hips, 0, 0.12, 0);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const strip = m(new THREE.BoxGeometry(0.11, 0.42, 0.025), i % 2 ? leather : cloth, this.hips, Math.sin(a) * 0.34, -0.12, Math.cos(a) * 0.29);
      strip.rotation.set(Math.cos(a) * 0.18, a, -Math.sin(a) * 0.18);
      const tip = m(new THREE.BoxGeometry(0.11, 0.05, 0.03), gold, strip, 0, -0.2, 0);
      tip.castShadow = false;
    }

    // --- torso: waist -> chest
    const spine = new THREE.Group();
    spine.position.y = 0.12;
    this.hips.add(spine);
    spine.add(this.chest);
    this.chest.position.y = 0.3;
    m(new THREE.CylinderGeometry(0.25, 0.27, 0.32, 24), leather, spine, 0, 0.16, 0);
    // sculpted cuirass (muscle armor)
    const cuirass = lathe([
      [0.001, -0.18], [0.27, -0.18], [0.31, -0.08], [0.36, 0.08], [0.39, 0.22], [0.37, 0.34], [0.3, 0.42], [0.16, 0.47], [0.001, 0.48],
    ], 40);
    cuirass.scale(1.12, 1, 0.78);
    m(cuirass, gold, this.chest, 0, 0.0, 0);
    // pectoral ridges
    for (const sx of [-1, 1]) {
      const pec = m(new THREE.SphereGeometry(0.15, 20, 12).scale(1.1, 0.75, 0.55), gold, this.chest, sx * 0.13, 0.22, 0.2);
      pec.rotation.z = sx * 0.2;
    }
    // glowing sigil on the chest
    const sigil = m(new THREE.TorusGeometry(0.07, 0.012, 8, 24), eyes, this.chest, 0, 0.06, 0.29);
    sigil.castShadow = false;

    // --- neck and head
    const neck = m(new THREE.CylinderGeometry(0.085, 0.1, 0.16, 16), skin, this.chest, 0, 0.52, 0);
    neck.castShadow = true;
    this.chest.add(this.head);
    this.head.position.y = 0.72;
    m(new THREE.SphereGeometry(0.135, 32, 24).scale(0.92, 1.12, 1.0), skin, this.head, 0, 0, 0.01);
    // beard (sculpted, like a marble statue)
    m(new THREE.SphereGeometry(0.11, 20, 14).scale(1.0, 1.15, 0.8), new THREE.MeshStandardNodeMaterial({ color: 0xd9d6d0, roughness: 0.9 }), this.head, 0, -0.1, 0.06);
    // helmet: crested Corinthian-style
    const helm = lathe([
      [0.001, 0.2], [0.08, 0.195], [0.13, 0.16], [0.155, 0.08], [0.16, 0.0], [0.155, -0.06], [0.16, -0.08], [0.001, -0.08],
    ], 40);
    helm.scale(1, 1, 1.08);
    m(helm, gold, this.head, 0, 0.02, -0.005);
    const crest = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 32, Math.PI).scale(1, 1.15, 1), cloth);
    crest.rotation.y = Math.PI / 2;
    crest.position.set(0, 0.11, -0.01);
    crest.castShadow = true;
    this.head.add(crest);
    for (const sx of [-1, 1]) {
      const eye = m(new THREE.SphereGeometry(0.018, 10, 8).scale(1.4, 0.7, 0.5), eyes, this.head, sx * 0.05, 0.02, 0.125);
      eye.castShadow = false;
    }

    // --- arms
    const makeArm = (sx: number): Limb => {
      const shoulder = new THREE.Group();
      shoulder.position.set(sx * 0.46, 0.36, 0);
      this.chest.add(shoulder);
      // pauldron
      const pauldron = m(new THREE.SphereGeometry(0.17, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(1.15, 0.9, 1.1), gold, shoulder, sx * 0.03, 0.04, 0);
      pauldron.rotation.z = -sx * 0.35;
      const upper = new THREE.Group();
      shoulder.add(upper);
      m(new THREE.CapsuleGeometry(0.085, 0.28, 6, 14), skin, upper, 0, -0.2, 0);
      const lower = new THREE.Group();
      lower.position.y = -0.4;
      upper.add(lower);
      m(new THREE.CapsuleGeometry(0.072, 0.26, 6, 14), skin, lower, 0, -0.17, 0);
      // bracer
      m(new THREE.CylinderGeometry(0.085, 0.078, 0.2, 18), gold, lower, 0, -0.22, 0);
      const hand = new THREE.Group();
      hand.position.y = -0.4;
      lower.add(hand);
      m(new THREE.SphereGeometry(0.07, 14, 10).scale(0.9, 1.2, 0.7), skin, hand, 0, -0.04, 0);
      return { upper, lower, end: hand };
    };
    this.arms = [makeArm(-1), makeArm(1)];
    this.leftHand = this.arms[0].end;
    this.rightHand = this.arms[1].end;

    // --- legs
    const makeLeg = (sx: number): Limb => {
      const upper = new THREE.Group();
      upper.position.set(sx * 0.17, -0.06, 0);
      this.hips.add(upper);
      m(new THREE.CapsuleGeometry(0.11, 0.38, 6, 14), skin, upper, 0, -0.26, 0);
      const lower = new THREE.Group();
      lower.position.y = -0.54;
      upper.add(lower);
      m(new THREE.CapsuleGeometry(0.085, 0.36, 6, 14), skin, lower, 0, -0.22, 0);
      // greave
      const greave = m(lathe([[0.1, 0], [0.105, 0.1], [0.115, 0.22], [0.11, 0.34], [0.1, 0.4]], 24), gold, lower, 0, -0.46, 0.012);
      greave.scale.set(1, 1, 1.1);
      // knee guard
      m(new THREE.SphereGeometry(0.08, 14, 10).scale(1, 1, 0.6), gold, lower, 0, 0.0, 0.06);
      const foot = new THREE.Group();
      foot.position.y = -0.52;
      lower.add(foot);
      m(new THREE.BoxGeometry(0.13, 0.08, 0.28), leather, foot, 0, -0.06, 0.06);
      return { upper, lower, end: foot };
    };
    this.legs = [makeLeg(-1), makeLeg(1)];

    // --- spear in the right hand (tip glows; feeds bloom)
    const spear = new THREE.Group();
    spear.position.set(0, -0.04, 0);
    spear.rotation.set(Math.PI / 2 - 0.15, 0, 0);
    this.rightHand.add(spear);
    m(new THREE.CylinderGeometry(0.022, 0.026, 2.6, 10), leather, spear, 0, 0.2, 0);
    m(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 12), gold, spear, 0, 0.9, 0);
    const blade = m(new THREE.OctahedronGeometry(0.11, 0).scale(0.6, 2.4, 0.18), steel, spear, 0, 1.73, 0);
    blade.castShadow = true;
    const edge = new THREE.MeshBasicNodeMaterial();
    edge.colorNode = color(glowColor).mul(sin(time.mul(3)).mul(0.25).add(1)).mul(6);
    edge.transparent = true;
    edge.blending = THREE.AdditiveBlending;
    edge.depthWrite = false;
    const glow = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0).scale(0.66, 2.5, 0.12), edge);
    glow.position.y = 1.73;
    spear.add(glow);

    // --- cape: a cloth strip whose motion runs in the vertex shader
    this.buildCape(cloth, gold);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
    });
  }

  private buildCape(cloth: THREE.Material, gold: THREE.Material): void {
    const H = 1.3;
    const geo = new THREE.PlaneGeometry(1, H, 16, 26);
    geo.translate(0, -H / 2, 0);
    // Static drape baked into the mesh so the folds get real normals: the cape
    // flares from the shoulders to the hem, wraps around the back, and falls in
    // vertical folds that deepen toward the hem.
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const t = -pos.getY(i) / H;
      const width = 0.6 + 0.26 * Math.pow(t, 0.8);
      const px = x * width;
      const wrap = 0.2 * (x * 2) ** 2 * (1 - t * 0.6);
      const fold = Math.sin(x * Math.PI * 7 + 0.6) * 0.035 * (0.25 + t) + Math.sin(x * Math.PI * 3.3) * 0.02 * t;
      pos.setXYZ(i, px, pos.getY(i), wrap + fold);
    }
    geo.computeVertexNormals();
    const mat = (cloth as THREE.MeshPhysicalNodeMaterial).clone();
    const v = uv();
    const down = float(1).sub(v.y); // 0 at the shoulders, 1 at the hem
    const flap = sin(time.mul(3.1).add(positionLocal.y.mul(3.0)).add(positionLocal.x.mul(2))).mul(0.04).mul(down);
    const ripple = mx_noise_float(vec3(positionLocal.xy.mul(3), time.mul(0.8))).mul(0.04).mul(down);
    // Lifts backward with speed, sways sideways when turning.
    const back = this.capeLift.mul(down.mul(down)).mul(0.9).add(down.mul(0.12));
    const side = this.capeSway.mul(down.mul(down)).mul(0.4);
    const curl = smoothstep(0.0, 1.0, down).mul(this.capeLift).mul(0.25);
    mat.positionNode = positionLocal.add(vec3(side, curl, back.add(flap).add(ripple).negate()));
    // Gold-embroidered border and a meander band above the hem.
    const edgeX = min(v.x, float(1).sub(v.x));
    const border = float(1).sub(smoothstep(0.035, 0.045, edgeX)).max(float(1).sub(smoothstep(0.05, 0.06, v.y)));
    const band = smoothstep(0.1, 0.11, v.y).mul(float(1).sub(smoothstep(0.17, 0.18, v.y)));
    const meander = step(0.5, fract(v.x.mul(14).add(step(0.5, fract(v.y.mul(28))).mul(0.5)))).mul(band);
    const trim = max(border, meander);
    const base = mix(color(0x5a0d12), color(0xa3151c), v.y.mul(0.7).add(0.15));
    mat.colorNode = mix(base, color(0xe3b04b), trim);
    mat.metalnessNode = trim;
    mat.roughnessNode = mix(float(0.85), float(0.32), trim);
    mat.sheenColor = new THREE.Color(0xff8a7a);
    const cape = new THREE.Mesh(geo, mat);
    cape.position.set(0, 0.42, -0.24);
    cape.castShadow = true;
    cape.receiveShadow = true;
    this.chest.add(cape);
    // clasp
    for (const sx of [-1, 1]) {
      const clasp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.035, 20).rotateX(Math.PI / 2), gold);
      clasp.position.set(sx * 0.32, 0.42, -0.22);
      this.chest.add(clasp);
    }
  }

  /** Drives the procedural animation. */
  animate(dt: number, s: LocomotionState): void {
    const k = 1 - Math.exp(-dt * 10);
    this.smoothedSpeed += (s.speed - this.smoothedSpeed) * k;
    const speed = this.smoothedSpeed;
    const run = Math.min(1, speed / 7);
    const walking = Math.min(1, speed / 1.2);
    const forward = s.localDir.y;
    const backward = forward < -0.3;
    // stride frequency grows with speed (about 1.6 strides/s walking, 2.6 running)
    const stride = 1.1 + run * 0.7;
    this.phase += (speed / (stride * 2)) * Math.PI * 2 * dt * (backward ? -1 : 1);
    const p = this.phase;
    this.breath += dt;

    // hips turn toward strafe direction (legs follow movement, torso keeps aiming)
    const strafeYaw = speed > 0.5 && !backward ? Math.atan2(s.localDir.x, Math.max(0.2, forward)) * 0.6 : 0;
    this.hipYaw += (strafeYaw - this.hipYaw) * k;
    this.hips.rotation.y = -this.hipYaw;
    this.chest.parent!.rotation.y = this.hipYaw; // counter-rotate the spine

    const swing = (0.5 + run * 0.35) * walking;
    const bob = Math.abs(Math.sin(p)) * 0.06 * walking * (0.6 + run);
    this.hips.position.y = 1.18 - 0.03 * walking + bob - run * 0.06;
    this.hips.rotation.z = Math.sin(p) * 0.04 * walking;
    this.chest.rotation.x = run * 0.22 + (s.grounded ? 0 : -0.1);
    this.chest.rotation.y = -Math.sin(p) * 0.1 * walking;
    this.chest.scale.setScalar(1 + Math.sin(this.breath * 1.6) * 0.012 * (1 - walking));
    this.head.rotation.x = -run * 0.15;

    const [L, R] = this.legs;
    const legPose = (leg: Limb, ph: number) => {
      const thigh = Math.sin(ph) * swing;
      // knee bends during the swing phase (leg moving forward)
      const knee = Math.max(0, Math.cos(ph)) * (0.4 + run * 0.9) * walking + 0.08;
      leg.upper.rotation.x = -thigh - run * 0.15;
      leg.lower.rotation.x = knee;
      leg.end.rotation.x = -knee * 0.4 + thigh * 0.2;
    };
    legPose(L, p);
    legPose(R, p + Math.PI);

    const [la, ra] = this.arms;
    const armSwing = swing * 0.7;
    la.upper.rotation.set(Math.sin(p) * armSwing - 0.05, 0, 0.12 + run * 0.1);
    la.lower.rotation.x = -0.25 - run * 0.7;
    // right arm holds the spear: less swing, raised forward; blends into a cast pose
    const cast = this.castWeight;
    ra.upper.rotation.set(
      THREE.MathUtils.lerp(Math.sin(p + Math.PI) * armSwing * 0.4 - 0.35, -2.4, cast),
      0,
      THREE.MathUtils.lerp(-0.18, -0.1, cast),
    );
    ra.lower.rotation.x = THREE.MathUtils.lerp(-0.9 - run * 0.2, -0.2, cast);

    if (!s.grounded) {
      const tuck = THREE.MathUtils.clamp(0.5 - s.verticalSpeed * 0.08, 0, 1);
      L.upper.rotation.x = -0.6 * tuck;
      L.lower.rotation.x = 1.1 * tuck;
      R.upper.rotation.x = -0.2 * tuck;
      R.lower.rotation.x = 0.6 * tuck;
    }

    this.capeLift.value += (Math.min(1, speed / 6) * (backward ? 0.3 : 1) - this.capeLift.value) * k;
    this.capeSway.value += (-s.localDir.x * Math.min(1, speed / 6) - this.capeSway.value) * k;
  }
}
