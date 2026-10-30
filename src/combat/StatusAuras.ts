import * as THREE from 'three/webgpu';
import { abs, float, max, min, normalView, positionView, pow, saturate, smoothstep, uv, vec3, vec4 } from '../render/tsl';
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

function ringMaterial(hex: number, fade: number): THREE.MeshBasicNodeMaterial {
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

/** The materials every god's status shares, so a new status builds no shader. */
interface StatusLook {
  star: THREE.SpriteNodeMaterial;
  shield: THREE.MeshBasicNodeMaterial;
  root: THREE.MeshBasicNodeMaterial;
  slow: THREE.MeshBasicNodeMaterial;
  ring: THREE.PlaneGeometry;
  bubble: THREE.SphereGeometry;
}

/** What one god shows: stars when dazed, a ground ring when rooted or slowed, a bubble while shielded. */
class Status {
  readonly group = new THREE.Group();
  readonly stars: THREE.Sprite[] = [];
  readonly ring: THREE.Mesh;
  readonly bubble: THREE.Mesh;

  constructor(private readonly look: StatusLook) {
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(look.star);
      s.scale.setScalar(0.6);
      s.renderOrder = 14;
      this.stars.push(s);
      this.group.add(s);
    }
    this.ring = new THREE.Mesh(look.ring, look.root);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 12;
    this.group.add(this.ring);
    this.bubble = new THREE.Mesh(look.bubble, look.shield);
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
      this.ring.material = rooted ? this.look.root : this.look.slow;
      const pulse = 1 + Math.sin(t * (rooted ? 9 : 4)) * 0.06;
      const r = (u.radius + 0.55) * 2 * pulse;
      this.ring.scale.set(r, r, 1);
      this.ring.position.set(x, y + 0.12, z);
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
  private readonly look: StatusLook = {
    star: starMaterial(STAR),
    shield: shieldMaterial(),
    root: ringMaterial(ROOT, 1),
    slow: ringMaterial(SLOW, 0.7),
    ring: new THREE.PlaneGeometry(1, 1),
    bubble: new THREE.SphereGeometry(1, 20, 14),
  };

  constructor() {
    this.group.name = 'status-auras';
  }

  /**
   * Shows every part of two idle statuses (the ring rooted on one, slowed on
   * the other) until the returned function puts them away, so that a loading
   * frame prepares their shaders: the first stun or root of a match built them.
   */
  prime(): () => void {
    const shown = [new Status(this.look), new Status(this.look)];
    shown[1]!.ring.material = this.look.slow;
    for (const s of shown) this.group.add(s.group);
    return () => {
      for (const s of shown) {
        this.group.remove(s.group);
        this.pool.push(s);
      }
    };
  }

  frame(units: readonly Unit[], t: number, visible: (u: Unit) => boolean): void {
    const seen = new Set<Unit>();
    for (const u of units) {
      if (u.kind !== 'god' || !u.alive || !visible(u)) continue;
      let s = this.live.get(u);
      if (!s) {
        s = this.pool.pop() ?? new Status(this.look);
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
