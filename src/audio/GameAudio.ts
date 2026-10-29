/**
 * Connects the match to the sound: listens to simulation events (casts,
 * hits, deaths, recalls), follows projectiles, lingering areas and
 * footsteps every frame, drives the music's intensity, the ambience and the
 * herald. It only reads game state; gameplay code never calls into it.
 */

import * as THREE from 'three/webgpu';
import type { CombatGame } from '../combat/CombatGame';
import { ULTIMATE_SLOT } from '../game/loadout';
import { ConquestLayout as L, nearestOnPolyline } from '../map/ConquestLayout';
import { isStructure, type Projectile, type SimEvent, type Unit, type Zone } from '../sim/Unit';
import type { Announcer } from './Announcer';
import type { AudioEngine, LoopHandle } from './AudioEngine';
import { skillPart, skillSound } from './bank';
import type { Music } from './music';

const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR'];

type Surface = 'stone' | 'grass' | 'dirt';

interface Tracked {
  loop: LoopHandle;
  seen: boolean;
}

/** Which god basic-hit sound each god makes. */
const GOD_HIT: Record<string, string> = { zeus: 'hit.zap', thor: 'hit.blunt', odin: 'hit.blade', loki: 'hit.blade', anubis: 'hit.sand' };
const GOD_TRAVEL: Record<string, string> = { zeus: 'travel.zeus', anubis: 'travel.anubis' };
const BOSSES = ['Treasure Wyrm', 'Molten Colossus'];

export class GameAudio {
  private readonly projectiles = new Map<Projectile, Tracked>();
  private readonly zones = new Map<Zone, Tracked>();
  private readonly recalls = new Map<Unit, LoopHandle>();
  private readonly strides = new Map<Unit, { x: number; z: number; acc: number; foot: number }>();
  private readonly windups = new Map<Unit, boolean>();
  private readonly leaps = new Map<Unit, string>();
  private readonly seenBoss = new Set<Unit>();
  private readonly seenFlash = new Set<number>();
  private ambience: LoopHandle[] = [];
  private heartbeat: LoopHandle | null = null;
  private heat = 0;
  private birdIn = 4;
  private crowIn = 30;
  private lastWave = 0;
  private firstBlood = false;
  private streak = 0;
  private multi = { count: 0, until: 0 };
  private titanWarnAt = -999;
  private ended = false;
  private time = 0;

  constructor(
    private readonly engine: AudioEngine,
    private readonly music: Music,
    private readonly herald: Announcer,
    private readonly game: CombatGame,
    private readonly camera: THREE.Camera,
    private readonly conquest: boolean,
  ) {
    game.sim.listeners.push((e) => this.onEvent(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    engine.onUnlock(() => this.startAmbience());
    this.music.play('battle');
  }

  private get me(): Unit {
    return this.game.player;
  }

  // -------------------------------------------------------------------------
  // Events

  private onEvent(e: SimEvent): void {
    if (!this.engine.ready) return;
    const me = this.me;
    switch (e.type) {
      case 'cast':
        this.onCast(e.unit, e.cast.skill.id, e.cast.targeting.type, e.x, e.z, e.cast.slot);
        break;
      case 'basic':
        this.onBasic(e.unit);
        break;
      case 'impact':
        this.onImpact(e.owner, e.x, e.z, e.big);
        break;
      case 'damage': {
        if (e.amount <= 0) break;
        const near = e.target === me || e.source === me;
        if (near) this.heat = Math.min(1.5, this.heat + 0.12 + (e.target === me ? 0.1 : 0));
        else if (e.target.kind === 'god' && this.dist(e.target) < 30) this.heat = Math.min(1.5, this.heat + 0.05);
        if (!e.ability && e.source) this.onBasicHit(e.source, e.target, e.crit);
        else if (e.ability && e.target === me) this.engine.play('hit.flesh', { gain: 0.35, vary: 0.1 }, 2, 0.15);
        if (e.target.kind === 'titan' && e.target.team === me.team && this.time - this.titanWarnAt > 40) {
          this.titanWarnAt = this.time;
          this.herald.say('Our Titan is under attack!', 'bad', 3);
        }
        break;
      }
      case 'heal':
        if (e.target === me && e.amount > 25) this.engine.play('heal', { gain: 0.5 }, 2, 1.2);
        break;
      case 'death':
        this.onDeath(e.unit, e.killer);
        break;
      case 'respawn':
        if (e.unit === me) this.engine.play('god.respawn', { gain: 0.8 }, 4);
        else if (e.unit.kind === 'phoenix') this.at('phoenix.rise', e.unit, { gain: 1, ref: 14 }, 4);
        break;
      case 'levelUp':
        if (e.unit !== me) break;
        if (e.level === 5) {
          this.engine.play('god.ultready', { gain: 0.8 }, 4);
          this.herald.say('Your ultimate has awakened.', 'good', 1);
        } else this.engine.play('god.levelup', { gain: 0.7 }, 4);
        break;
      case 'reward':
        if (e.unit === me && e.favor > 0) this.engine.play('favor', { gain: 0.35, vary: 0.05 }, 2, 0.08);
        break;
      case 'teleport':
        if (this.dist(e.unit) < 50 || Math.hypot(e.fromX - this.engine.listenerPos.x, e.fromZ - this.engine.listenerPos.z) < 50) {
          this.engine.play('teleport', { at: { x: e.fromX, z: e.fromZ }, gain: 0.6 }, 2);
          this.at('teleport', e.unit, { gain: 0.5, delay: 0.05 }, 2);
        }
        break;
      case 'recall':
        this.onRecall(e.unit, e.state);
        break;
    }
  }

  private onCast(u: Unit, id: string, targeting: string, x: number, z: number, slot: number): void {
    const ss = skillSound(id);
    const mine = u === this.me;
    const ult = slot === ULTIMATE_SLOT;
    const gain = (mine ? 1 : 0.85) * (ult ? 1.15 : 1);
    this.at(skillPart(id, 'cast'), u, { gain, ref: ult ? 12 : 8, vary: 0.02, wet: ult ? 0.2 : 0.05 }, mine ? 6 : 4);
    if (!ss.impact) return;
    if (targeting === 'leap') {
      this.leaps.set(u, id);
      return;
    }
    if (targeting === 'projectile') return;
    // instant areas, cones, lines and self bursts land where they were aimed
    const where = targeting === 'self' || targeting === 'dash' ? { x: u.x, z: u.z } : { x, z };
    this.engine.play(skillPart(id, 'impact'), { at: where, gain: gain * 0.9, delay: ss.impactDelay ?? 0.05, ref: 8, vary: 0.04 }, 4);
  }

  private onBasic(u: Unit): void {
    const mine = u === this.me;
    let name: string;
    let gain = mine ? 0.85 : 0.7;
    let gap = 0;
    let ref = 6;
    switch (u.kind) {
      case 'god':
      case 'dummy':
        name = `basic.${u.combatant.god.id}`;
        break;
      case 'minion':
        name = `basic.minion.${u.tag.split(':').pop()}`;
        gain = 0.42;
        gap = 0.04;
        break;
      case 'tower':
      case 'phoenix':
        name = 'tower.shot';
        gain = 1;
        ref = 12;
        break;
      case 'titan':
        name = 'titan.slam';
        gain = 1.2;
        ref = 20;
        break;
      case 'monster':
        name = u.name === 'Treasure Wyrm' ? 'basic.wyrm' : u.name === 'Molten Colossus' ? 'basic.colossus' : u.tag.endsWith('warden') ? 'basic.warden' : 'basic.monster';
        ref = u.radius > 2 ? 16 : 7;
        gain = u.radius > 2 ? 1.1 : 0.7;
        break;
      default:
        name = 'basic.minion.melee';
        gain = 0.5;
    }
    if (!this.engine.has(name)) name = 'basic.minion.melee';
    this.at(name, u, { gain, vary: 0.06, ref }, mine ? 5 : 2, gap);
  }

  private onBasicHit(src: Unit, target: Unit, crit: boolean): void {
    let name: string;
    let gain = src === this.me || target === this.me ? 0.75 : 0.55;
    let gap = 0;
    if (isStructure(target)) name = 'hit.structure';
    else if (src.kind === 'tower' || src.kind === 'phoenix') name = 'tower.hit';
    else if (src.kind === 'god' || src.kind === 'dummy') name = GOD_HIT[src.combatant.god.id] ?? 'hit.flesh';
    else if (src.kind === 'minion') {
      const t = src.tag.split(':').pop();
      name = t === 'brute' ? 'hit.blunt' : t === 'archer' ? 'hit.flesh' : 'hit.blade';
      gain *= 0.6;
      gap = 0.05;
    } else if (src.kind === 'monster') name = src.radius > 2 ? 'hit.blunt' : 'hit.monster';
    else name = 'hit.flesh';
    this.at(name, target, { gain, vary: 0.08 }, src === this.me ? 4 : 2, gap);
    if (crit) this.at('hit.crit', target, { gain: 0.6 }, 3);
  }

  private onImpact(owner: Unit, x: number, z: number, big: boolean): void {
    // the sim emits impacts while the projectile or zone still exists, so find which one this is
    for (const p of this.game.sim.projectiles) {
      if (p.owner !== owner || Math.abs(p.x - x) > 0.01 || Math.abs(p.z - z) > 0.01) continue;
      if (p.cast) this.engine.play(skillPart(p.cast.skill.id, 'impact'), { at: { x, z }, gain: 0.9, vary: 0.05, ref: 8 }, owner === this.me ? 5 : 3, 0.03);
      else if (p.shot && this.game.sim.units.some((u) => isStructure(u) && u.shielded() && Math.hypot(u.x - x, u.z - z) < u.radius + 1)) {
        this.engine.play('hit.structure', { at: { x, z }, gain: 0.4, vary: 0.1 }, 1, 0.08);
      }
      return;
    }
    for (const zn of this.game.sim.zones) {
      if (zn.owner !== owner || Math.abs(zn.x - x) > 0.01 || Math.abs(zn.z - z) > 0.01) continue;
      const name = skillPart(zn.cast.skill.id, 'tick');
      if (this.engine.has(name)) this.engine.play(name, { at: { x, z }, gain: 0.75, vary: 0.08, ref: 8 }, 3);
      return;
    }
    const leap = this.leaps.get(owner);
    if (leap && big) {
      this.leaps.delete(owner);
      this.engine.play(skillPart(leap, 'impact'), { at: { x, z }, gain: 1.1, ref: 12 }, 5);
    }
  }

  private onDeath(u: Unit, killer: Unit | null): void {
    const me = this.me;
    switch (u.kind) {
      case 'god':
        this.at('god.death', u, { gain: u === me ? 1 : 0.8, ref: 10 }, 5);
        if (killer === me) this.engine.play('kill.confirm', { gain: 0.7 }, 5);
        if (this.conquest && killer?.kind === 'god') this.announceKill(u, killer);
        if (u === me) {
          this.streak = 0;
          this.herald.say('You have fallen.', 'bad', 2);
        }
        break;
      case 'minion':
        this.at('minion.death', u, { gain: 0.5, vary: 0.08 }, 1, 0.06);
        break;
      case 'monster':
        if (BOSSES.includes(u.name)) {
          this.at(u.name === 'Treasure Wyrm' ? 'wyrm.roar' : 'colossus.roar', u, { gain: 1.2, ref: 22, rate: 0.75 }, 6);
          this.at('structure.collapse', u, { gain: 0.6, ref: 20, delay: 0.6 }, 5);
          if (killer && killer.team !== 'neutral') {
            const ours = killer.team === me.team;
            const what = u.name === 'Treasure Wyrm' ? "the Wyrm's hoard" : "the Colossus's fury";
            this.herald.say(ours ? `Our team claims ${what}.` : `The enemy claims ${what}.`, ours ? 'good' : 'bad', 3);
          }
        } else this.at('monster.death', u, { gain: 0.8, vary: 0.08, ref: u.radius > 1 ? 9 : 6 }, 3);
        break;
      case 'tower':
      case 'phoenix':
      case 'titan': {
        this.at(u.kind === 'phoenix' ? 'phoenix.collapse' : 'structure.collapse', u, { gain: 1.3, ref: 25 }, 6);
        if (u.kind === 'titan') break;
        const ours = u.team === me.team;
        const lines = u.kind === 'tower' ? ['Our tower has crumbled.', 'An enemy tower crumbles!'] : ['Our Phoenix burns out.', 'The enemy Phoenix is extinguished!'];
        this.herald.say(ours ? lines[0]! : lines[1]!, ours ? 'bad' : 'good', 2);
        break;
      }
      default:
        break;
    }
  }

  private announceKill(victim: Unit, killer: Unit): void {
    const me = this.me;
    if (!this.firstBlood) {
      this.firstBlood = true;
      this.herald.say(killer === me ? 'You drew first blood!' : 'First blood is spilled!', killer.team === me.team ? 'good' : 'bad', 4);
      if (killer === me) this.streak = 1;
      return;
    }
    if (killer !== me || victim === me) return;
    this.streak++;
    const now = this.time;
    this.multi.count = now < this.multi.until ? this.multi.count + 1 : 1;
    this.multi.until = now + 10;
    const multi = ['', '', 'Two gods fall!', 'Three gods fall!', 'Four gods fall!', 'Ascendant! Five gods fall!'];
    if (this.multi.count >= 2) this.herald.say(multi[Math.min(5, this.multi.count)]!, 'epic', 4);
    else if (this.streak === 3) this.herald.say('You are on a rampage!', 'epic', 3);
    else if (this.streak === 5) this.herald.say('Unstoppable! None can stand against you!', 'epic', 3);
    else this.herald.say('Enemy god slain.', 'good', 1);
  }

  private onRecall(u: Unit, state: 'start' | 'cancel' | 'done'): void {
    const old = this.recalls.get(u);
    if (state === 'start') {
      if (old || (u !== this.me && this.dist(u) > 40)) return;
      const l = this.engine.loop('recall.loop', { at: { x: u.x, z: u.z }, gain: u === this.me ? 0.7 : 0.45 });
      if (l) this.recalls.set(u, l);
      return;
    }
    old?.stop(0.25);
    this.recalls.delete(u);
    if (state === 'done') this.at('recall.done', u, { gain: 0.8 }, 3);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat || !this.engine.ready) return;
    const slot = SLOT_KEYS.indexOf(e.code);
    if (slot < 0 || !this.me.alive) return;
    if (this.me.combatant.canCast(slot)) this.engine.play('ui.deny', { bus: 'ui', gain: 0.6 }, 3, 0.15);
  }

  // -------------------------------------------------------------------------
  // Per frame

  frame(dt: number): void {
    this.time += dt;
    if (!this.engine.ready) return;
    const me = this.me;
    const fwd = this.camera.getWorldDirection(tmpDir);
    // the ears sit on the god (third-person games sound wrong with ears at the camera)
    this.engine.setListener(me.x, me.body.y + 1.7, me.z, fwd.x, fwd.z);

    this.followProjectiles();
    this.followZones();
    for (const [u, l] of this.recalls) {
      if (!u.alive || u.recall <= 0) {
        l.stop(0.2);
        this.recalls.delete(u);
      } else l.setPosition(u.x, u.body.y + 1, u.z);
    }
    this.footsteps();
    this.watchMonsters();
    this.watchMatch();
    this.updateMood(dt);
    this.ambientLife(dt);
  }

  private followProjectiles(): void {
    for (const t of this.projectiles.values()) t.seen = false;
    for (const p of this.game.sim.projectiles) {
      const t = this.projectiles.get(p);
      if (t) {
        t.seen = true;
        t.loop.setPosition(p.x, p.owner.body.y + 1.5, p.z);
        continue;
      }
      if (this.projectiles.size >= 16 || !this.engine.audible(p.x, p.z, 60)) continue;
      const name = this.travelFor(p);
      if (!name || !this.engine.has(name)) continue;
      const gain = p.cast ? 0.75 : p.owner.kind === 'minion' ? 0.25 : 0.5;
      const loop = this.engine.loop(name, { at: { x: p.x, y: 1.5, z: p.z }, gain, rate: 0.97 + Math.random() * 0.06, ref: 6 });
      if (loop) this.projectiles.set(p, { loop, seen: true });
    }
    for (const [p, t] of this.projectiles) {
      if (t.seen) continue;
      t.loop.stop(0.08);
      this.projectiles.delete(p);
    }
  }

  private travelFor(p: Projectile): string | null {
    if (p.cast) return skillPart(p.cast.skill.id, 'travel');
    const o = p.owner;
    if (o.kind === 'tower' || o.kind === 'phoenix') return 'travel.tower';
    if (o.kind === 'minion') return 'travel.arrow';
    if (o.kind === 'god' || o.kind === 'dummy') return GOD_TRAVEL[o.combatant.god.id] ?? null;
    return null;
  }

  private followZones(): void {
    for (const t of this.zones.values()) t.seen = false;
    for (const zn of this.game.sim.zones) {
      const t = this.zones.get(zn);
      if (t) {
        t.seen = true;
        t.loop.setPosition(zn.x, 1, zn.z);
        if (zn.ticks <= 0) t.loop.setGain(0, 0.15);
        continue;
      }
      const name = skillPart(zn.cast.skill.id, 'zone');
      if (!this.engine.has(name) || !this.engine.audible(zn.x, zn.z, 70)) continue;
      const loop = this.engine.loop(name, { at: { x: zn.x, y: 1, z: zn.z }, gain: 0.7, ref: 8 });
      if (loop) this.zones.set(zn, { loop, seen: true });
    }
    for (const [z, t] of this.zones) {
      if (t.seen) continue;
      t.loop.stop(0.4);
      this.zones.delete(z);
    }
  }

  private footsteps(): void {
    const lx = this.engine.listenerPos.x;
    const lz = this.engine.listenerPos.z;
    for (const u of this.game.sim.units) {
      if (isStructure(u) || u.kind === 'dummy') continue;
      const d = Math.hypot(u.x - lx, u.z - lz);
      const range = u.kind === 'minion' ? 22 : u.radius > 2 ? 60 : 38;
      let s = this.strides.get(u);
      if (!s) {
        s = { x: u.x, z: u.z, acc: 0, foot: 0 };
        this.strides.set(u, s);
      }
      const moved = Math.hypot(u.x - s.x, u.z - s.z);
      s.x = u.x;
      s.z = u.z;
      // leaps, blinks and recalls are not walking
      if (!u.alive || u.forced || moved > 3 || d > range || (u.stealth > 0 && u.team !== this.me.team)) {
        s.acc = 0;
        continue;
      }
      s.acc += moved;
      const stride = u.kind === 'minion' ? 1.4 : u.radius > 2 ? 4.2 : u.kind === 'monster' ? 1.8 : 2.3;
      if (s.acc < stride) continue;
      s.acc -= stride;
      s.foot ^= 1;
      const heavy = u.radius > 2 || u.tag.endsWith('warden') || u.tag.endsWith('brute');
      const name = heavy ? 'step.heavy' : u.kind === 'minion' ? 'step.minion' : `step.${this.surface(u.x, u.z)}`;
      const mine = u === this.me;
      const gain = mine ? 0.55 : u.kind === 'minion' ? 0.22 : heavy ? (u.radius > 2 ? 0.9 : 0.5) : 0.4;
      this.engine.play(name, { at: { x: u.x, y: u.body.y + 0.1, z: u.z }, gain, vary: 0.07, ref: heavy ? 10 : 4, rate: heavy && u.radius > 2 ? 0.8 : 1 }, mine ? 3 : 0, u.kind === 'minion' ? 0.05 : 0);
    }
    if (this.strides.size > 400) for (const u of this.strides.keys()) if (!this.game.sim.units.includes(u)) this.strides.delete(u);
  }

  private surface(x: number, z: number): Surface {
    if (!this.conquest) return 'stone';
    for (const p of L.plazas) if (Math.hypot(x - p.at[0], z - p.at[1]) < p.radius) return 'stone';
    for (const lane of L.lanes) if (nearestOnPolyline(lane.points, x, z).distance < lane.width * 0.55) return 'stone';
    for (const path of L.paths) if (nearestOnPolyline(path.points, x, z).distance < path.width * 0.6) return 'dirt';
    return 'grass';
  }

  private watchMonsters(): void {
    const sim = this.game.sim;
    for (const u of sim.units) {
      if (u.kind !== 'monster' && u.kind !== 'titan') continue;
      if (!u.alive) {
        this.windups.delete(u);
        continue;
      }
      // a boss arriving
      if (BOSSES.includes(u.name) && !this.seenBoss.has(u)) {
        this.seenBoss.add(u);
        this.at(u.name === 'Treasure Wyrm' ? 'wyrm.roar' : 'colossus.roar', u, { gain: 1, ref: 25 }, 5);
        if (this.conquest) this.herald.say(u.name === 'Treasure Wyrm' ? 'The Treasure Wyrm has awoken.' : 'The Molten Colossus rises from the deep.', 'epic', 2);
      }
      const brain = u.brain as { specialProgress?: number } | null;
      const winding = u.windup > 0 || (brain?.specialProgress ?? 0) > 0;
      const was = this.windups.get(u) ?? false;
      if (winding && !was) {
        const special = (brain?.specialProgress ?? 0) > 0;
        if (u.kind === 'titan') this.at('titan.windup', u, { gain: 1, ref: 18 }, 4);
        else if (special) this.at(u.name === 'Treasure Wyrm' ? 'wyrm.roar' : 'boss.windup', u, { gain: 1, ref: 18, rate: u.name === 'Treasure Wyrm' ? 1.15 : 1 }, 4);
        else if (u.radius > 2 || u.tag.endsWith('warden')) this.at('monster.aggro', u, { gain: 0.7, rate: u.radius > 2 ? 0.6 : 0.8, ref: 10 }, 3, 1.2);
      }
      this.windups.set(u, winding);
    }
    // a boss's area attack lands as a flash on the ground
    for (const f of sim.flashes) {
      if (this.seenFlash.has(f.id)) continue;
      this.seenFlash.add(f.id);
      const o = f.owner;
      if (o.kind === 'monster' && BOSSES.includes(o.name) && f.shape.type === 'circle') {
        this.engine.play(o.name === 'Treasure Wyrm' ? 'wyrm.sweep' : 'colossus.stomp', { at: { x: f.shape.x, z: f.shape.z }, gain: 1.2, ref: 18 }, 6);
      }
    }
    if (this.seenFlash.size > 500) this.seenFlash.clear();
  }

  private watchMatch(): void {
    const m = this.game.match;
    if (!m) return;
    if (m.wave !== this.lastWave) {
      if (m.wave === 1) this.herald.say('Minions are on the march!', 'neutral', 2);
      this.lastWave = m.wave;
      const base = L.bases.find((b) => b.team === this.me.team)!;
      this.engine.play('wave.horn', { at: { x: base.titan[0], z: base.titan[1] }, gain: m.wave === 1 ? 1 : 0.6, ref: 30 }, 4);
    }
    if (m.winner && !this.ended) {
      this.ended = true;
      const won = m.winner === this.me.team;
      setTimeout(() => {
        this.music.sting(won ? 'victory' : 'defeat');
        this.herald.say(won ? 'Victory! The enemy Titan has fallen.' : 'Defeat. Our Titan has fallen.', won ? 'epic' : 'bad', 9);
      }, 1800);
    }
  }

  private updateMood(dt: number): void {
    this.heat = Math.max(0, this.heat - dt * 0.18);
    const me = this.me;
    const c = me.combatant;
    const low = me.alive ? 1 - c.health / c.stats.maxHealth : 0;
    if (!this.ended) this.music.setIntensity(Math.min(1, this.heat + (low > 0.6 ? 0.3 : 0)), dt);
    const pulse = me.alive && low > 0.72;
    if (pulse && !this.heartbeat) this.heartbeat = this.engine.loop('heartbeat', { gain: 0, bus: 'sfx' });
    if (this.heartbeat) {
      if (!pulse) {
        this.heartbeat.stop(0.6);
        this.heartbeat = null;
      } else {
        this.heartbeat.setGain(0.25 + (low - 0.72) * 2, 0.3);
        this.heartbeat.setRate(1 + (low - 0.72) * 1.4);
      }
    }
  }

  /**
   * Start the ambience beds. The bank may still be rendering when audio
   * unlocks, so beds whose sound is not ready yet are retried each second.
   */
  private startAmbience(): void {
    const specs: [string, Parameters<AudioEngine['loop']>[1]][] = [];
    const add = (name: string, o: Parameters<AudioEngine['loop']>[1]) => specs.push([name, o]);
    add('amb.wind', { bus: 'ambience', gain: 0.55, pan: -0.5 });
    add('amb.wind', { bus: 'ambience', gain: 0.45, pan: 0.5, rate: 0.93 });
    add('amb.leaves', { bus: 'ambience', gain: 0.35, pan: 0.2 });
    add('amb.jungle', { bus: 'ambience', gain: this.conquest ? 0.18 : 0.08, pan: -0.2 });
    for (const b of Object.values(this.game.sim.bases)) {
      add('amb.fountain', { bus: 'ambience', at: { x: b.x, y: 1, z: b.z }, gain: 0.8, ref: 7 });
      add('amb.fire', { bus: 'ambience', at: { x: b.x + 6, y: 2, z: b.z }, gain: 0.5, ref: 4 });
      add('amb.fire', { bus: 'ambience', at: { x: b.x - 6, y: 2, z: b.z }, gain: 0.5, ref: 4, rate: 1.1 });
    }
    this.ambiencePending = specs;
    this.retryAmbience();
  }

  private ambiencePending: [string, Parameters<AudioEngine['loop']>[1]][] = [];
  private ambienceRetryIn = 0;

  private retryAmbience(): void {
    this.ambiencePending = this.ambiencePending.filter(([name, o]) => {
      const l = this.engine.loop(name, o);
      if (l) this.ambience.push(l);
      return !l;
    });
  }

  private ambientLife(dt: number): void {
    if (this.ambiencePending.length && (this.ambienceRetryIn -= dt) <= 0) {
      this.ambienceRetryIn = 1;
      this.retryAmbience();
    }
    const l = this.engine.listenerPos;
    this.birdIn -= dt;
    if (this.birdIn <= 0) {
      this.birdIn = 2.5 + Math.random() * 7;
      // quieter when the fighting is loud
      if (this.heat < 0.6) {
        const a = Math.random() * Math.PI * 2;
        const r = 14 + Math.random() * 30;
        this.engine.play('amb.bird', { bus: 'ambience', at: { x: l.x + Math.cos(a) * r, y: 8 + Math.random() * 8, z: l.z + Math.sin(a) * r }, gain: 0.6, vary: 0.12, ref: 10 }, 0);
      }
    }
    this.crowIn -= dt;
    if (this.crowIn <= 0) {
      this.crowIn = 25 + Math.random() * 40;
      const a = Math.random() * Math.PI * 2;
      this.engine.play('amb.crow', { bus: 'ambience', at: { x: l.x + Math.cos(a) * 45, y: 15, z: l.z + Math.sin(a) * 45 }, gain: 0.7, ref: 18 }, 0);
    }
  }

  // -------------------------------------------------------------------------

  private dist(u: Unit): number {
    return Math.hypot(u.x - this.engine.listenerPos.x, u.z - this.engine.listenerPos.z);
  }

  /** Play a sound at a unit. */
  private at(name: string, u: Unit, o: Parameters<AudioEngine['play']>[1] = {}, priority = 1, gap = 0): void {
    this.engine.play(name, { ...o, at: { x: u.x, y: u.body.y + 1.2, z: u.z } }, priority, gap);
  }
}

const tmpDir = new THREE.Vector3();
