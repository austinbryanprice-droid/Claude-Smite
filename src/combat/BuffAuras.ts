import * as THREE from 'three/webgpu';
import { attribute, smoothstep, uv, vec2, vec4 } from '../render/tsl';
import { spriteQuads } from '../render/shared';
import { BUFF_KINDS, buffMark } from '../sim/Jungle';
import type { Unit } from '../sim/Unit';
import { BUFF_GLOW } from './MonsterViews';

const TRAIL = 6;
/** Each wisp's puffs, head first: a bright head and a fading trail. */
const PUFF_SIZE = Array.from({ length: TRAIL }, (_, i) => (i === 0 ? 0.42 : 0.3 * (1 - i / (TRAIL + 1))));
const PUFF_GLOW = Array.from({ length: TRAIL }, (_, i) => (i === 0 ? 4 : 2.2 * (1 - i / TRAIL)));
const COLORS = new Map(BUFF_KINDS.map((k) => [k, new THREE.Color(BUFF_GLOW[k] ?? 0xffffff)]));

/** A soft puff placed by its instance's `at` (xyz, size) and lit by its `tint` (buff color, intensity). */
function wispMaterial(): THREE.SpriteNodeMaterial {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const at = attribute('at', 'vec4');
  const tint = attribute('tint', 'vec4');
  const r = uv().sub(0.5).length().mul(2);
  const f = smoothstep(1, 0, r).pow(2.2);
  // white-hot center, buff-colored halo
  const core = smoothstep(0.35, 0, r);
  m.colorNode = vec4(tint.rgb.mul(tint.w).add(core.mul(tint.w.mul(0.6))).mul(f), 1);
  m.opacityNode = f;
  m.positionNode = at.xyz;
  m.scaleNode = vec2(at.w, at.w);
  return m;
}

/**
 * Jungle buffs on gods: one glowing wisp per buff, circling the god at chest
 * height in the buff's color, so you can tell at a glance who holds Might.
 * Every puff of every wisp is one instance of a single sprite: one draw and
 * one shader, built while loading, however many buffs are out.
 */
export class BuffAuras {
  readonly group = new THREE.Group();
  private readonly sprite = new THREE.Sprite(wispMaterial());
  private at!: THREE.InstancedBufferAttribute;
  private tint!: THREE.InstancedBufferAttribute;
  private capacity = 0;

  constructor() {
    this.group.name = 'buff-auras';
    this.sprite.renderOrder = 13;
    this.sprite.frustumCulled = false;
    this.sprite.visible = false;
    // drawn while loading anyway, so the first buff taken generates no shader
    this.sprite.userData.shownLater = true;
    this.resize(10);
    this.group.add(this.sprite);
  }

  /** Room for `wisps` wisps. */
  private resize(wisps: number): void {
    this.capacity = wisps;
    const g = spriteQuads(wisps * TRAIL, true);
    const make = () => new THREE.InstancedBufferAttribute(new Float32Array(wisps * TRAIL * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('at', (this.at = make()));
    g.setAttribute('tint', (this.tint = make()));
    g.instanceCount = 0;
    this.sprite.geometry = g;
  }

  frame(units: readonly Unit[], t: number, visible: (u: Unit) => boolean): void {
    let count = 0;
    for (const u of units) {
      if (u.kind !== 'god' || !u.alive || !visible(u)) continue;
      for (const kind of BUFF_KINDS) if (u.marks.has(buffMark(kind))) count++;
    }
    if (count > this.capacity) this.resize(Math.max(count, this.capacity * 2));
    let w = 0;
    for (const u of units) {
      if (u.kind !== 'god' || !u.alive || !visible(u)) continue;
      let n = 0;
      for (const kind of BUFF_KINDS) {
        if (!u.marks.has(buffMark(kind))) continue;
        this.place(w++, COLORS.get(kind)!, u.x, u.body.y + 1.35, u.z, t, n * 2.1 + u.id, n * 1.3);
        n++;
      }
    }
    this.sprite.visible = count > 0;
    (this.sprite.geometry as THREE.InstancedBufferGeometry).instanceCount = count * TRAIL;
    if (count === 0) return;
    this.at.needsUpdate = true;
    this.tint.needsUpdate = true;
  }

  /** Wisp `w` circles (x, y, z); `phase` places it around the god, `tilt` gives each buff its own orbit. */
  private place(w: number, c: THREE.Color, x: number, y: number, z: number, t: number, phase: number, tilt: number): void {
    for (let i = 0; i < TRAIL; i++) {
      const a = t * 2.6 + phase - i * 0.16;
      const r = 0.95;
      const k = w * TRAIL + i;
      this.at.setXYZW(k, x + Math.cos(a) * r, y + Math.sin(a + tilt) * 0.35 + Math.sin(t * 3 + phase) * 0.08, z + Math.sin(a) * r, PUFF_SIZE[i]!);
      this.tint.setXYZW(k, c.r, c.g, c.b, PUFF_GLOW[i]!);
    }
  }
}
