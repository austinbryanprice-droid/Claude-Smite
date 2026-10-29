/**
 * The Web Audio side: one context (created on the first user gesture, as
 * browsers require), a mixer of buses with a shared reverb, positional
 * voices with distance falloff, loops that follow moving things, and the
 * player's volume settings.
 *
 * Sounds are rendered to Float32Arrays ahead of time (see bank.ts) and only
 * become AudioBuffers once the context exists.
 */

import { RATE } from './dsp';

export type Bus = 'music' | 'sfx' | 'ui' | 'voice' | 'ambience';

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  voice: number;
  ambience: number;
  muted: boolean;
}

const STORAGE_KEY = 'ascendant.audio';
const DEFAULTS: AudioSettings = { master: 0.8, music: 0.55, sfx: 0.85, voice: 0.9, ambience: 0.6, muted: false };

/** Mixer trims so the sliders' defaults land at a good balance. */
const BUS_TRIM: Record<Bus, number> = { music: 0.55, sfx: 0.75, ui: 0.6, voice: 1, ambience: 0.7 };
const REVERB_SEND: Record<Bus, number> = { music: 0.28, sfx: 0.16, ui: 0.05, voice: 0.12, ambience: 0.1 };

export interface PlayOptions {
  /** World position; omit for flat (UI, music, the player's own feedback). */
  at?: { x: number; y?: number; z: number };
  gain?: number;
  /** Playback rate (pitch); a random spread is added on top when `vary` is set. */
  rate?: number;
  vary?: number;
  bus?: Bus;
  /** Seconds from now. */
  delay?: number;
  /** Extra reverb send (0..1) on top of the bus's. */
  wet?: number;
  /** Which variant to play; random when omitted. */
  variant?: number;
  /** Stereo pan for flat sounds (-1..1). */
  pan?: number;
  /** Positional reference distance (meters at full volume); bigger = carries further. */
  ref?: number;
}

export interface LoopHandle {
  setPosition(x: number, y: number, z: number): void;
  setGain(g: number, ramp?: number): void;
  setRate(r: number): void;
  stop(fade?: number): void;
  readonly alive: boolean;
}

/** Positional sounds beyond this many meters from the listener are skipped. */
const CULL = 95;
const MAX_VOICES = 56;

interface Voice {
  src: AudioBufferSourceNode;
  started: number;
  priority: number;
  name: string;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses = {} as Record<Bus, GainNode>;
  private reverbIn!: GainNode;
  private readonly raw = new Map<string, { data: Float32Array[]; loop: boolean }>();
  private readonly buffers = new Map<string, AudioBuffer[]>();
  private readonly voices: Voice[] = [];
  private readonly lastPlayed = new Map<string, number>();
  readonly listenerPos = { x: 0, y: 0, z: 0 };
  settings: AudioSettings = loadSettings();
  private readonly unlockListeners: (() => void)[] = [];

  constructor() {
    const unlock = () => {
      this.unlock();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Runs `fn` once audio is unlocked (immediately if it already is). */
  onUnlock(fn: () => void): void {
    if (this.ready) fn();
    else this.unlockListeners.push(fn);
  }

  /** Create or resume the context. Must run inside a user gesture. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().then(() => this.flushUnlock());
    else this.flushUnlock();
  }

  private flushUnlock(): void {
    if (!this.ready) return;
    const fns = this.unlockListeners.splice(0);
    for (const f of fns) f();
  }

  private build(): void {
    const ctx = this.ctx!;
    // a gentle bus compressor and limiter keep big fights from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(limiter).connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 2.6);
    this.reverbIn = ctx.createGain();
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.9;
    this.reverbIn.connect(reverb).connect(reverbOut).connect(this.master);

    for (const b of Object.keys(BUS_TRIM) as Bus[]) {
      const g = ctx.createGain();
      g.connect(this.master);
      const send = ctx.createGain();
      send.gain.value = REVERB_SEND[b];
      g.connect(send).connect(this.reverbIn);
      this.buses[b] = g;
    }
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = 0;
      l.positionY.value = 0;
      l.positionZ.value = 0;
    }
    this.applySettings();
    for (const [name, r] of this.raw) this.toBuffers(name, r.data);
    // keep audio going across tab switches
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.ctx?.state === 'suspended') void this.ctx.resume();
    });
  }

  // -------------------------------------------------------------------------
  // Settings

  setSettings(s: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...s };
    saveSettings(this.settings);
    this.applySettings();
  }

  private applySettings(): void {
    if (!this.ctx) return;
    const s = this.settings;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, now, 0.03);
    const vol: Record<Bus, number> = { music: s.music, sfx: s.sfx, ui: s.sfx, voice: s.voice, ambience: s.ambience };
    for (const b of Object.keys(BUS_TRIM) as Bus[]) this.buses[b].gain.setTargetAtTime(vol[b] * vol[b] * BUS_TRIM[b] * 1.4, now, 0.03);
  }

  /** The bus node, for modules that build their own graphs (music). */
  bus(b: Bus): GainNode | null {
    return this.ctx ? this.buses[b] : null;
  }

  // -------------------------------------------------------------------------
  // Sounds

  /** Store rendered sample data under a name. */
  register(name: string, data: Float32Array[], loop = false): void {
    this.raw.set(name, { data, loop });
    if (this.ctx) this.toBuffers(name, data);
  }

  has(name: string): boolean {
    return this.raw.has(name);
  }

  private toBuffers(name: string, data: Float32Array[]): void {
    const ctx = this.ctx!;
    this.buffers.set(
      name,
      data.map((d) => {
        const b = ctx.createBuffer(1, d.length, RATE);
        b.copyToChannel(d as Float32Array<ArrayBuffer>, 0);
        return b;
      }),
    );
  }

  buffer(name: string, variant?: number): AudioBuffer | null {
    const list = this.buffers.get(name);
    if (!list || !list.length) return null;
    return list[variant !== undefined ? variant % list.length : Math.floor(Math.random() * list.length)]!;
  }

  /** Whether a positional sound here would be audible at all. */
  audible(x: number, z: number, range = CULL): boolean {
    return Math.hypot(x - this.listenerPos.x, z - this.listenerPos.z) < range;
  }

  /**
   * Play a one-shot. `minGap` drops repeats of the same name closer together
   * than that many seconds (crowds of minions hitting at once).
   */
  play(name: string, o: PlayOptions = {}, priority = 1, minGap = 0): AudioBufferSourceNode | null {
    if (!this.ready || this.settings.muted) return null;
    const ctx = this.ctx!;
    if (o.at && !this.audible(o.at.x, o.at.z, CULL * (o.ref ?? 6) / 6)) return null;
    const now = ctx.currentTime;
    if (minGap > 0) {
      const last = this.lastPlayed.get(name) ?? -1;
      if (now - last < minGap) return null;
    }
    const buffer = this.buffer(name, o.variant);
    if (!buffer) return null;
    if (!this.makeRoom(priority)) return null;
    this.lastPlayed.set(name, now);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const rate = (o.rate ?? 1) * (o.vary ? 1 + (Math.random() * 2 - 1) * o.vary : 1);
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g);
    const out = this.route(g, o);
    void out;
    const when = now + (o.delay ?? 0);
    src.start(when);
    const v: Voice = { src, started: when, priority, name };
    this.voices.push(v);
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      g.disconnect();
    };
    return src;
  }

  /** Start a loop that can follow something around. */
  loop(name: string, o: PlayOptions = {}): LoopHandle | null {
    if (!this.ready) return null;
    const ctx = this.ctx!;
    const buffer = this.buffer(name, o.variant ?? 0);
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    const g = ctx.createGain();
    const target = o.gain ?? 1;
    g.gain.value = 0;
    g.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
    src.connect(g);
    const panner = this.route(g, o);
    src.start(ctx.currentTime, Math.random() * buffer.duration);
    let alive = true;
    return {
      get alive() {
        return alive;
      },
      setPosition: (x, y, z) => {
        if (!panner || !alive) return;
        setPannerPos(panner, x, y, z, ctx.currentTime);
      },
      setGain: (v, ramp = 0.08) => {
        if (alive) g.gain.setTargetAtTime(v, ctx.currentTime, ramp);
      },
      setRate: (r) => {
        if (alive) src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.05);
      },
      stop: (fade = 0.15) => {
        if (!alive) return;
        alive = false;
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + fade);
        src.stop(t + fade + 0.05);
        src.onended = () => g.disconnect();
      },
    };
  }

  /** Connect a voice's gain to its bus, through a panner when positioned. */
  private route(g: GainNode, o: PlayOptions): PannerNode | null {
    const ctx = this.ctx!;
    const bus = this.buses[o.bus ?? 'sfx'];
    let node: AudioNode = g;
    let panner: PannerNode | null = null;
    if (o.at) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.ref ?? 6;
      panner.maxDistance = 400;
      panner.rolloffFactor = 1.1;
      setPannerPos(panner, o.at.x, o.at.y ?? 1.5, o.at.z, ctx.currentTime, true);
      node.connect(panner);
      node = panner;
    } else if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = o.pan;
      node.connect(p);
      node = p;
    }
    node.connect(bus);
    if (o.wet) {
      const s = ctx.createGain();
      s.gain.value = o.wet;
      node.connect(s).connect(this.reverbIn);
    }
    return panner;
  }

  /** Steal the oldest, least important voice when the pool is full. */
  private makeRoom(priority: number): boolean {
    if (this.voices.length < MAX_VOICES) return true;
    let worst = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      if (v.priority > priority) continue;
      if (worst < 0 || v.priority < this.voices[worst]!.priority || (v.priority === this.voices[worst]!.priority && v.started < this.voices[worst]!.started)) worst = i;
    }
    if (worst < 0) return false;
    const v = this.voices.splice(worst, 1)[0]!;
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
    return true;
  }

  /** Place the ears: at `pos`, facing `forward` (horizontal), up is +Y. */
  setListener(x: number, y: number, z: number, fx: number, fz: number): void {
    this.listenerPos.x = x;
    this.listenerPos.y = y;
    this.listenerPos.z = z;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    const len = Math.hypot(fx, fz) || 1;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx / len, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(fz / len, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(x, y, z);
      l.setOrientation(fx / len, 0, fz / len, 0, 1, 0);
    }
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }
}

function setPannerPos(p: PannerNode, x: number, y: number, z: number, t: number, snap = false): void {
  if (p.positionX) {
    if (snap) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.positionX.setTargetAtTime(x, t, 0.03);
      p.positionY.setTargetAtTime(y, t, 0.03);
      p.positionZ.setTargetAtTime(z, t, 0.03);
    }
  } else p.setPosition(x, y, z);
}

/** A synthetic hall: stereo decaying noise that darkens as it fades. */
function impulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.round(seconds * ctx.sampleRate);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    let seed = ch ? 0x9e3779b9 : 0x2545f491;
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const n = ((seed >>> 0) / 4294967296) * 2 - 1;
      const t = i / len;
      const cut = 0.6 - t * 0.5;
      lp += (n - lp) * cut;
      const pre = i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1;
      d[i] = lp * Math.pow(1 - t, 3.2) * pre * 0.6;
    }
  }
  return b;
}

function loadSettings(): AudioSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AudioSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
