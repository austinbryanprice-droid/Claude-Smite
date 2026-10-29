import * as THREE from 'three/webgpu';
import { smoothstep, uv, vec3, vec4 } from '../render/tsl';
import { BUFF_KINDS, buffMark, type BuffKind } from '../sim/Jungle';
import type { Unit } from '../sim/Unit';
import { BUFF_GLOW } from './MonsterViews';

const TRAIL = 6;

function wispMaterial(hex: number, intensity: number): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const c = new THREE.Color(hex);
  const r = uv().sub(0.5).length().mul(2);
  const f = smoothstep(1, 0, r).pow(2.2);
  // white-hot center, buff-colored halo
  const core = smoothstep(0.35, 0, r);
  m.colorNode = vec4(vec3(c.r, c.g, c.b).mul(intensity).add(core.mul(intensity * 0.6)).mul(f), 1);
  m.opacityNode = f;
  return m;
}

/** One orbiting wisp with a fading trail. */
class Wisp {
  readonly group = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];

  constructor(kind: BuffKind) {
    const hex = BUFF_GLOW[kind] ?? 0xffffff;
    for (let i = 0; i < TRAIL; i++) {
      const s = new THREE.Sprite(wispMaterial(hex, i === 0 ? 4 : 2.2 * (1 - i / TRAIL)));
      const size = i === 0 ? 0.42 : 0.3 * (1 - i / (TRAIL + 1));
      s.scale.setScalar(size);
      s.renderOrder = 13;
      this.sprites.push(s);
      this.group.add(s);
    }
  }

  /** `phase` places this wisp around the god; each buff gets its own tilt and speed. */
  place(x: number, y: number, z: number, t: number, phase: number, tilt: number): void {
    for (const [i, s] of this.sprites.entries()) {
      const a = t * 2.6 + phase - i * 0.16;
      const r = 0.95;
      const ox = Math.cos(a) * r;
      const oz = Math.sin(a) * r;
      s.position.set(x + ox, y + Math.sin(a * 1 + tilt) * 0.35 + Math.sin(t * 3 + phase) * 0.08, z + oz);
    }
  }
}

/**
 * Jungle buffs on gods: one glowing wisp per buff, circling the god at chest
 * height in the buff's color, so you can tell at a glance who holds Might.
 */
export class BuffAuras {
  readonly group = new THREE.Group();
  private readonly live = new Map<string, Wisp>();
  private readonly pool = new Map<BuffKind, Wisp[]>();

  constructor() {
    this.group.name = 'buff-auras';
  }

  frame(units: readonly Unit[], t: number, visible: (u: Unit) => boolean): void {
    const seen = new Set<string>();
    for (const u of units) {
      if (u.kind !== 'god' || !u.alive || !visible(u)) continue;
      let n = 0;
      for (const kind of BUFF_KINDS) {
        if (!u.marks.has(buffMark(kind))) continue;
        const key = `${u.id}:${kind}`;
        seen.add(key);
        let w = this.live.get(key);
        if (!w) {
          w = this.pool.get(kind)?.pop() ?? new Wisp(kind);
          this.group.add(w.group);
          this.live.set(key, w);
        }
        w.place(u.x, u.body.y + 1.35, u.z, t, n * 2.1 + u.id, n * 1.3);
        n++;
      }
    }
    for (const [key, w] of this.live) {
      if (seen.has(key)) continue;
      this.group.remove(w.group);
      this.live.delete(key);
      const kind = key.split(':')[1] as BuffKind;
      if (!this.pool.has(kind)) this.pool.set(kind, []);
      this.pool.get(kind)!.push(w);
    }
  }
}
