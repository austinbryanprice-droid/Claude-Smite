import * as THREE from 'three/webgpu';
import { abs, float, max, min, normalView, positionView, pow, saturate, smoothstep, uniform, uv, vec3, vec4 } from '../render/tsl';
import type { CCKind } from '../game/types';
import type { Unit } from '../sim/Unit';

/** Crowd control that stops a god outright; these get stars over the head. */
const DAZED = new Set<CCKind>(['stun', 'knockup', 'mesmerize', 'disorient', 'fear', 'taunt', 'polymorph', 'banish']);
const STAR = 0xffd65a;
const ROOT = 0x8fe05a;
const SLOW = 0x7fc8ff;
const SHIELD = 0xfff0c0;

function starMaterial(hex: number): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const c = new THREE.Color(hex);
  const d = uv().sub(0.5);
  // a four-point sparkle: two thin bars and a hot center
  const bars = smoothstep(0.07, 0, min(abs(d.x), abs(d.y))).mul(smoothstep(0.5, 0.1, d.length()));
  const core = smoothstep(0.18, 0, d.length());
  const f = max(bars, core);
  m.colorNode = vec4(vec3(c.r, c.g, c.b).mul(4).add(core.mul(3)).mul(f), 1);
  m.opacityNode = f;
  return m;
}

function ringMaterial(hex: number, fade: ReturnType<typeof uniform>): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true });
  const c = new THREE.Color(hex);
  // drawn on a flat quad: a soft band near the edge, clear inside
  const r = uv().sub(0.5).length().mul(2);
  const band = smoothstep(0.62, 0.82, r).mul(smoothstep(1, 0.88, r));
  m.colorNode = vec4(vec3(c.r, c.g, c.b).mul(3).mul(band), 1);
  m.opacityNode = band.mul(fade);
  return m;
}

function shieldMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const c = new THREE.Color(SHIELD);
  const rim = pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 2.5);
  m.colorNode = vec4(vec3(c.r, c.g, c.b).mul(1.6).mul(rim), 1);
  m.opacityNode = rim.mul(0.55).add(0.04);
  return m;
}

/** What one god shows: stars when dazed, a ground ring when rooted or slowed, a bubble while shielded. */
class Status {
  readonly group = new THREE.Group();
  private readonly stars: THREE.Sprite[] = [];
  private readonly ring: THREE.Mesh;
  private readonly rootMat: THREE.MeshBasicNodeMaterial;
  private readonly slowMat: THREE.MeshBasicNodeMaterial;
  private readonly bubble: THREE.Mesh;
  private readonly ringFade = uniform(1);

  constructor(starMat: THREE.SpriteNodeMaterial, shieldMat: THREE.MeshBasicNodeMaterial, ringGeo: THREE.PlaneGeometry, bubbleGeo: THREE.SphereGeometry) {
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(starMat);
      s.scale.setScalar(0.6);
      s.renderOrder = 14;
      this.stars.push(s);
      this.group.add(s);
    }
    this.rootMat = ringMaterial(ROOT, this.ringFade);
    this.slowMat = ringMaterial(SLOW, this.ringFade);
    this.ring = new THREE.Mesh(ringGeo, this.rootMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 12;
    this.group.add(this.ring);
    this.bubble = new THREE.Mesh(bubbleGeo, shieldMat);
    this.bubble.renderOrder = 12;
    this.group.add(this.bubble);
  }

  /** Returns false when there is nothing to show. */
  place(u: Unit, t: number): boolean {
    const c = u.combatant;
    let dazed = false;
    let rooted = false;
    let slowed = false;
    for (const a of c.cc.active) {
      if (DAZED.has(a.kind)) dazed = true;
      else if (a.kind === 'root' || a.kind === 'grab') rooted = true;
      else if (a.kind === 'slow' || a.kind === 'cripple') slowed = true;
    }
    const shielded = c.shieldTotal > 0.5;
    if (!dazed && !rooted && !slowed && !shielded) return false;
    const { x, z } = u;
    const y = u.body.y;
    const h = u.radius * 3.6;
    for (const [i, s] of this.stars.entries()) {
      s.visible = dazed;
      if (!dazed) continue;
      const a = t * 4 + (i / this.stars.length) * Math.PI * 2;
      s.position.set(x + Math.cos(a) * 0.55, y + h + 0.25 + Math.sin(a * 2) * 0.06, z + Math.sin(a) * 0.55);
    }
    this.ring.visible = rooted || slowed;
    if (this.ring.visible) {
      this.ring.material = rooted ? this.rootMat : this.slowMat;
      const pulse = 1 + Math.sin(t * (rooted ? 9 : 4)) * 0.06;
      const r = (u.radius + 0.55) * 2 * pulse;
      this.ring.scale.set(r, r, 1);
      this.ring.position.set(x, y + 0.12, z);
      this.ringFade.value = rooted ? 1 : 0.7;
    }
    this.bubble.visible = shielded;
    if (shielded) {
      const r = u.radius * 1.9;
      this.bubble.scale.set(r, r * 1.25, r);
      this.bubble.position.set(x, y + r * 0.95, z);
    }
    return true;
  }
}

/**
 * Status on gods, readable from the game camera: stars circle the head of a
 * stunned (or otherwise dazed) god, a ring holds a rooted or slowed one to
 * the ground, and a bubble wraps anyone carrying a shield.
 */
export class StatusAuras {
  readonly group = new THREE.Group();
  private readonly live = new Map<Unit, Status>();
  private readonly pool: Status[] = [];
  private readonly starMat = starMaterial(STAR);
  private readonly shieldMat = shieldMaterial();
  private readonly ringGeo = new THREE.PlaneGeometry(1, 1);
  private readonly bubbleGeo = new THREE.SphereGeometry(1, 20, 14);

  constructor() {
    this.group.name = 'status-auras';
  }

  frame(units: readonly Unit[], t: number, visible: (u: Unit) => boolean): void {
    const seen = new Set<Unit>();
    for (const u of units) {
      if (u.kind !== 'god' || !u.alive || !visible(u)) continue;
      let s = this.live.get(u);
      if (!s) {
        s = this.pool.pop() ?? new Status(this.starMat, this.shieldMat, this.ringGeo, this.bubbleGeo);
        if (!s.place(u, t)) {
          this.pool.push(s);
          continue;
        }
        this.group.add(s.group);
        this.live.set(u, s);
      } else if (!s.place(u, t)) continue;
      seen.add(u);
    }
    for (const [u, s] of this.live) {
      if (seen.has(u)) continue;
      this.group.remove(s.group);
      this.live.delete(u);
      this.pool.push(s);
    }
  }
}
