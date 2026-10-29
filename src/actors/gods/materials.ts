import * as THREE from 'three/webgpu';
import {
  abs, attribute, color, float, fract, max, min, mix, mx_fractal_noise_float, mx_noise_float, normalView,
  positionLocal, positionView, pow, saturate, sin, smoothstep, time, uv, vec3,
} from '../../render/tsl';

/**
 * Stylized PBR materials for the gods, keyed by the material names the build
 * script writes (tools/gods/forge). Mesh data channels:
 * - `color` (COLOR_0): per material. Skin: r = crease, g = ridge, b = face.
 *   Hair: r = root..tip. Eyes: r = 1 at the pupil.
 * - `_edge`: distance to an armor plate's border in meters (1 elsewhere).
 * - `_side`: 0 on the inside face of a plate.
 */
export interface GodPalette {
  skin: number;
  /** Second skin tone for creases and shadowed areas. */
  skinDeep: number;
  gold: number;
  steel: number;
  cloth: number;
  clothDeep: number;
  cloth2: number;
  leather: number;
  hair: number;
  hairTip: number;
  fur: number;
  glow: number;
  eye: number;
  gem: number;
}

const PALETTES: Record<string, GodPalette> = {
  zeus: {
    skin: 0xc48a66, skinDeep: 0x7a3a2a, gold: 0xf7c450, steel: 0xc8d2dc, cloth: 0x2457c8, clothDeep: 0x0d1f5c,
    cloth2: 0xeee4d0, leather: 0x5a3420, hair: 0xaab4c4, hairTip: 0xf2f4f8, fur: 0xd8d0c0, glow: 0x6fd8ff,
    eye: 0x8fe8ff, gem: 0x39b8ff,
  },
  thor: {
    skin: 0xdba07e, skinDeep: 0x8f4030, gold: 0xe0a640, steel: 0xb4c0cc, cloth: 0xa01c1c, clothDeep: 0x420808,
    cloth2: 0x3a3f4a, leather: 0x4a2a18, hair: 0xa8381a, hairTip: 0xe8783a, fur: 0x5a3c26, glow: 0x9fd0ff,
    eye: 0xbfe4ff, gem: 0x4aa8ff,
  },
  odin: {
    skin: 0xc8906c, skinDeep: 0x7a3a28, gold: 0xe0a33a, steel: 0x7e8a9c, cloth: 0x2b3240, clothDeep: 0x0e1118,
    cloth2: 0x6a1c1c, leather: 0x3a2416, hair: 0xb8bcc2, hairTip: 0xeceef0, fur: 0x5a5048, glow: 0xffc955,
    eye: 0xffd27a, gem: 0xffa62a,
  },
  loki: {
    skin: 0xd8b49a, skinDeep: 0x6a3a40, gold: 0xd8bd4a, steel: 0x6a7480, cloth: 0x1c6a2c, clothDeep: 0x06200c,
    cloth2: 0x141418, leather: 0x241a14, hair: 0x14110f, hairTip: 0x3a2c22, fur: 0x2a2a26, glow: 0x6dff5a,
    eye: 0x9dff7a, gem: 0x3dff7a,
  },
  anubis: {
    skin: 0x2a2018, skinDeep: 0x0c0806, gold: 0xf2b84a, steel: 0x2a3e8a, cloth: 0xf0e6d0, clothDeep: 0x9a8a6a,
    cloth2: 0x1c3f9a, leather: 0x3a2412, hair: 0x14100c, hairTip: 0x2a2018, fur: 0x1e1712, glow: 0xffa040,
    eye: 0xffb050, gem: 0x2fd0c0,
  },
};

const EINHERJAR: Partial<GodPalette> = { cloth: 0x4a4f5a, clothDeep: 0x1a1d22, glow: 0x9ad8ff, eye: 0x9ad8ff };

export function paletteOf(id: string, variant?: string): GodPalette {
  const p = PALETTES[id] ?? PALETTES.zeus!;
  return variant === 'einherjar' ? { ...p, ...EINHERJAR } : p;
}

let studio: THREE.DataTexture | null = null;

/**
 * A painted "studio" environment for character metals: bright warm sky,
 * dark ground, a key light and a rim light. Reflecting only the real sky
 * makes gold read as flat yellow; this gives it the dark-to-bright range
 * stylized metal needs.
 */
function studioEnv(): THREE.DataTexture {
  if (studio) return studio;
  const w = 256;
  const h = 128;
  const data = new Float32Array(w * h * 4);
  const key = new THREE.Vector3(0.55, 0.6, 0.6).normalize();
  const rimDir = new THREE.Vector3(-0.5, 0.35, -0.8).normalize();
  const fill = new THREE.Vector3(-0.8, 0.2, 0.5).normalize();
  const d = new THREE.Vector3();
  for (let j = 0; j < h; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI;
    for (let i = 0; i < w; i++) {
      const lon = ((i + 0.5) / w) * Math.PI * 2 - Math.PI;
      d.set(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      const y = d.y;
      let r: number, g: number, b: number;
      if (y > 0) {
        // dim zenith, bright band at the horizon: curved metal gets light-dark-light streaks
        const t = Math.pow(y, 0.6);
        const band = Math.exp(-y * y * 40) * 1.6;
        r = 0.55 - t * 0.2 + band; g = 0.56 - t * 0.18 + band * 0.95; b = 0.62 - t * 0.1 + band * 0.85;
      } else {
        const t = Math.pow(-y, 0.4);
        const band = Math.exp(-y * y * 60) * 0.9;
        r = 0.28 - t * 0.22 + band; g = 0.2 - t * 0.16 + band * 0.85; b = 0.13 - t * 0.1 + band * 0.7;
      }
      // tall softboxes left and right of the key make vertical highlights
      for (const sx of [-1, 1]) {
        const ax = Math.abs(lon - sx * 1.15);
        r += Math.exp(-ax * ax * 30) * Math.exp(-lat * lat * 3) * 1.4;
        g += Math.exp(-ax * ax * 30) * Math.exp(-lat * lat * 3) * 1.35;
        b += Math.exp(-ax * ax * 30) * Math.exp(-lat * lat * 3) * 1.3;
      }
      const k = Math.pow(Math.max(0, d.dot(key)), 60) * 14 + Math.pow(Math.max(0, d.dot(key)), 8) * 1.2;
      const rr = Math.pow(Math.max(0, d.dot(rimDir)), 40) * 7;
      const ff = Math.pow(Math.max(0, d.dot(fill)), 20) * 1.5;
      const o = (j * w + i) * 4;
      data[o] = r + k * 1.0 + rr * 0.8 + ff * 0.7;
      data[o + 1] = g + k * 0.95 + rr * 0.9 + ff * 0.8;
      data[o + 2] = b + k * 0.85 + rr * 1.0 + ff * 1.0;
      data[o + 3] = 1;
    }
  }
  studio = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  studio.mapping = THREE.EquirectangularReflectionMapping;
  studio.colorSpace = THREE.LinearSRGBColorSpace;
  studio.minFilter = THREE.LinearFilter;
  studio.magFilter = THREE.LinearFilter;
  studio.flipY = true;
  studio.needsUpdate = true;
  return studio;
}

const edge = () => attribute('_edge', 'float');
const side = () => attribute('_side', 'float');
const data = () => attribute('color', 'vec4');
/** Baked per-vertex ambient occlusion (tools/gods/forge/ao.py). */
const ao = () => attribute('_ao', 'float');

/** Fresnel-ish rim factor in view space, for the painted rim light Smite characters have. */
const rim = () => pow(float(1).sub(saturate(normalView.dot(positionView.normalize().negate()))), 3);

function skinMaterial(p: GodPalette): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.55, sheen: 0.35, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff9a7a) });
  const d = data();
  const crease = d.x;
  const ridge = d.y;
  const mottle = mx_fractal_noise_float(positionLocal.mul(18), 3).mul(0.5).add(0.5);
  const fine = mx_noise_float(positionLocal.mul(220)).mul(0.04);
  const base = mix(color(p.skin), color(p.skinDeep), crease.mul(0.75).add(mottle.mul(0.12)));
  // warm subsurface-looking tint in creases, light catches the ridges of muscle
  const lit = base.mul(float(1).add(ridge.mul(0.22))).add(fine);
  // painted face shading: deep eye sockets and tinted lips
  const lips = d.z;
  const socket = d.w;
  const lipColor = color(p.skin).mul(vec3(0.82, 0.5, 0.48));
  const painted = mix(mix(lit, color(p.skinDeep).mul(0.55), socket.mul(0.65)), lipColor, lips.mul(0.55));
  m.colorNode = painted;
  m.roughnessNode = float(0.5).add(crease.mul(0.15)).sub(ridge.mul(0.12)).add(mx_noise_float(positionLocal.mul(90)).mul(0.06)).sub(lips.mul(0.2));
  // a little warm back-scatter at grazing angles
  m.emissiveNode = color(p.skinDeep).mul(rim().mul(0.18));
  return m;
}

function metalMaterial(base: number, trim: number, opts: { engrave?: boolean; dark?: number } = {}): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ metalness: 1, roughness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.2 });
  m.envMap = studioEnv();
  m.envMapIntensity = 1.0;
  const e = edge();
  const inside = float(1).sub(side());
  const band = float(1).sub(smoothstep(0.012, 0.02, e)); // polished trim along plate borders
  const groove = smoothstep(0.02, 0.024, e).mul(float(1).sub(smoothstep(0.026, 0.03, e))); // engraved line inside the trim
  const hammer = mx_fractal_noise_float(positionLocal.mul(30), 2).mul(0.5).add(0.5);
  let col: any = mix(color(base).mul(0.88), color(base), hammer.mul(0.6).add(0.4));
  if (opts.engrave) {
    // scrolling filigree: a band of interference lines that reads as engraving
    const fil = abs(sin(positionLocal.x.mul(140).add(sin(positionLocal.y.mul(90)).mul(2.2)))).mul(abs(sin(positionLocal.y.mul(120).add(positionLocal.z.mul(60)))));
    const inBand = smoothstep(0.03, 0.035, e).mul(float(1).sub(smoothstep(0.06, 0.065, e)));
    col = col.mul(float(1).sub(smoothstep(0.75, 0.95, fil).mul(inBand).mul(0.45)));
  }
  col = mix(col, color(trim), band);
  col = col.mul(float(1).sub(groove.mul(0.55))).mul(float(1).sub(inside.mul(0.55)));
  m.colorNode = col;
  m.roughnessNode = mix(float(0.22).add(hammer.mul(0.1)), float(0.12), band).add(groove.mul(0.3)).add(inside.mul(0.3));
  m.emissiveNode = color(trim).mul(rim().mul(0.08));
  return m;
}

function clothMaterial(c: number, deep: number, trim: number, opts: { pattern?: boolean } = {}): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.82, sheen: 0.8, sheenRoughness: 0.45, side: THREE.DoubleSide });
  m.sheenColor = new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.35);
  const v = uv();
  const weave = mx_noise_float(positionLocal.mul(vec3(260, 260, 260))).mul(0.06);
  const folds = mx_fractal_noise_float(positionLocal.mul(6), 2).mul(0.5).add(0.5);
  let col: any = mix(color(deep), color(c), folds.mul(0.5).add(0.45)).add(weave);
  if (opts.pattern) {
    // gold embroidered border: along uv edges (cloth panels have 0..1 uv)
    const ex = min(v.x, float(1).sub(v.x));
    const ey = float(1).sub(v.y);
    const borderX = float(1).sub(smoothstep(0.035, 0.05, ex));
    const borderY = float(1).sub(smoothstep(0.05, 0.065, ey));
    const meanderBand = smoothstep(0.08, 0.09, ey).mul(float(1).sub(smoothstep(0.16, 0.17, ey)));
    const meander = fract(v.x.mul(18).add(fract(v.y.mul(36)).step(0.5).mul(0.5))).step(0.5).mul(meanderBand);
    // shells cut from the body have no panel uv; their border comes from _edge
    const shellBorder = float(1).sub(smoothstep(0.018, 0.024, edge()));
    const t = max(max(max(borderX, borderY), meander), shellBorder);
    col = mix(col, color(trim), t);
    m.metalnessNode = t.mul(0.9);
    m.roughnessNode = mix(float(0.82), float(0.3), t);
  }
  m.colorNode = col;
  return m;
}

/** Striped headcloth (a nemes): bands of cloth and gold along uv.y, gold-trimmed hem. */
function stripesMaterial(c: number, trim: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.7, sheen: 0.5, sheenRoughness: 0.4, side: THREE.DoubleSide });
  m.sheenColor = new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.4);
  const v = uv();
  const weave = mx_noise_float(positionLocal.mul(vec3(240, 240, 240))).mul(0.05);
  const band = smoothstep(0.42, 0.5, fract(v.y.mul(9))).mul(float(1).sub(smoothstep(0.92, 1.0, fract(v.y.mul(9)))));
  const hem = float(1).sub(smoothstep(0.03, 0.045, min(v.x, float(1).sub(v.x)))).max(smoothstep(0.95, 0.965, v.y));
  const t = max(band, hem);
  m.colorNode = mix(color(c).add(weave), color(trim), t);
  m.metalnessNode = t.mul(0.9);
  m.roughnessNode = mix(float(0.7), float(0.28), t);
  return m;
}

function leatherMaterial(c: number, trim: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.6, clearcoat: 0.15, clearcoatRoughness: 0.5 });
  const e = edge();
  const grain = mx_fractal_noise_float(positionLocal.mul(70), 3).mul(0.5).add(0.5);
  const stitch = smoothstep(0.006, 0.008, e).mul(float(1).sub(smoothstep(0.01, 0.012, e))).mul(fract(positionLocal.y.mul(260).add(positionLocal.x.mul(260))).step(0.5));
  const band = float(1).sub(smoothstep(0.004, 0.006, e));
  let col: any = mix(color(c).mul(0.65), color(c).mul(1.15), grain);
  col = mix(col, color(0xd8c8a0), stitch.mul(0.6));
  col = mix(col, color(trim), band);
  m.colorNode = col;
  m.metalnessNode = band;
  m.roughnessNode = mix(float(0.55).add(grain.mul(0.2)), float(0.25), band);
  return m;
}

function hairMaterial(root: number, tip: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.45, sheen: 0.35, sheenRoughness: 0.35, side: THREE.DoubleSide });
  m.sheenColor = new THREE.Color(tip);
  const v = uv();
  const strands = abs(sin(v.x.mul(6.283).mul(7).add(mx_noise_float(positionLocal.mul(40)).mul(2)))).pow(0.6);
  const t = data().x; // root 0 .. tip 1
  const tint = data().y.mul(0.16).add(0.88); // per-clump variation
  // roots sit in the shadow of the clumps around them
  const occl = smoothstep(0.0, 0.45, t).mul(0.55).add(0.45);
  // painted shine band a third of the way down each lock, broken up by the strands
  const shine = smoothstep(0.18, 0.3, t).mul(float(1).sub(smoothstep(0.38, 0.52, t))).mul(strands).mul(0.22);
  m.colorNode = mix(color(root), color(tip), t.mul(0.8)).mul(strands.mul(0.3).add(0.62)).mul(occl).mul(tint).add(color(tip).mul(shine));
  m.roughnessNode = float(0.5).sub(strands.mul(0.15));
  return m;
}

function glowMaterial(c: number, strength = 6): THREE.Material {
  const m = new THREE.MeshBasicNodeMaterial();
  const flicker = sin(time.mul(9)).mul(0.08).add(sin(time.mul(23.0)).mul(0.05)).add(1);
  m.colorNode = color(c).mul(strength).mul(flicker);
  return m;
}

function eyeMaterial(c: number): THREE.Material {
  // a lit, wet eye: off-white sclera, a colored iris with a dark limbal ring and pupil,
  // and a faint godly glow in the iris only
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03 });
  const d = data().x; // 1 at the pupil, falling off toward the white
  const iris = smoothstep(0.84, 0.87, d);
  const limbal = smoothstep(0.84, 0.87, d).mul(float(1).sub(smoothstep(0.87, 0.9, d)));
  const pupil = smoothstep(0.965, 0.975, d);
  const fibers = mx_noise_float(positionLocal.mul(900)).mul(0.25).add(0.85);
  const sclera = mix(color(0xd8cfc4), color(0xf2ece4), smoothstep(0.3, 0.75, d));
  let col: any = mix(sclera, color(c).mul(fibers), iris);
  col = mix(col, color(c).mul(0.15), limbal.mul(0.8));
  col = mix(col, color(0x050404), pupil);
  m.colorNode = col;
  m.emissiveNode = color(c).mul(iris.mul(float(1).sub(pupil)).mul(fibers).mul(1.4));
  return m;
}

function gemMaterial(c: number): THREE.Material {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.05, metalness: 0, clearcoat: 1, transmission: 0 });
  m.colorNode = color(c).mul(0.6);
  m.emissiveNode = color(c).mul(rim().mul(2).add(0.8).mul(sin(time.mul(2)).mul(0.2).add(1)));
  return m;
}

const cache = new Map<string, Map<string, THREE.Material>>();

/** Materials for one god (shared by every instance), keyed by the material names the build script writes. */
export function godMaterials(id: string, variant?: string): Map<string, THREE.Material> {
  const key = `${id}/${variant ?? ''}`;
  let m = cache.get(key);
  if (!m) cache.set(key, (m = buildMaterials(id, variant)));
  return m;
}

function buildMaterials(id: string, variant?: string): Map<string, THREE.Material> {
  const p = paletteOf(id, variant);
  const m = new Map<string, THREE.Material>();
  m.set('skin', skinMaterial(p));
  m.set('gold', metalMaterial(p.gold, 0xffe7a0, { engrave: true }));
  m.set('goldplain', metalMaterial(p.gold, 0xffe7a0));
  m.set('steel', metalMaterial(p.steel, p.gold, { engrave: true }));
  m.set('cloth', clothMaterial(p.cloth, p.clothDeep, p.gold, { pattern: true }));
  m.set('clothplain', clothMaterial(p.cloth, p.clothDeep, p.gold));
  m.set('cloth2', clothMaterial(p.cloth2, new THREE.Color(p.cloth2).multiplyScalar(0.55).getHex(), p.gold, { pattern: true }));
  m.set('leather', leatherMaterial(p.leather, p.gold));
  m.set('stripes', stripesMaterial(p.cloth2, p.gold));
  m.set('hair', hairMaterial(p.hair, p.hairTip));
  m.set('fur', hairMaterial(p.fur, new THREE.Color(p.fur).lerp(new THREE.Color(0xffe8c8), 0.3).getHex()));
  m.set('glow', glowMaterial(p.glow));
  m.set('eye', eyeMaterial(p.eye));
  m.set('gem', gemMaterial(p.gem));
  m.set('default', new THREE.MeshStandardNodeMaterial({ color: 0x888888 }));
  for (const [name, mat] of m) {
    mat.name = name;
    // contact shadows on everything lit; glow and eyes stay bright
    const nm = mat as THREE.MeshPhysicalNodeMaterial;
    if (nm.colorNode && name !== 'glow' && name !== 'eye') nm.colorNode = nm.colorNode.mul(mix(float(1), ao(), 0.92));
  }
  return m;
}
