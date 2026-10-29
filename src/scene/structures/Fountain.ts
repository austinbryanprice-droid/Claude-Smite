import * as THREE from 'three/webgpu';
import {
  abs, atan, color, dot, float, fract, mix, mx_noise_float, normalize, positionLocal, positionView, positionWorld, pow, sin,
  smoothstep, step, time, transformNormalToView, uv, vec3,
} from '../../render/tsl';
import type { Team } from '../../map/ConquestLayout';
import { flutedShaft, lathe } from '../Architecture';
import { Fire } from '../Effects';
import type { MaterialLibrary } from '../Materials';
import { agedMarble, mergeStatic, TEAM_STYLE, TeamMaterials } from './common';

/**
 * A team's fountain: a wide marble basin of glowing healing water around a
 * tiered fountain, ringed by braziers. Static scenery; the simulation owns
 * the healing zone.
 */
export class Fountain {
  readonly group = new THREE.Group();
  readonly fires: Fire[] = [];

  constructor(lib: MaterialLibrary, team: Team, radius: number, teamMats?: TeamMaterials) {
    const style = TEAM_STYLE[team];
    const tm = teamMats ?? new TeamMaterials(lib, style);
    this.group.name = `fountain-${team}`;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    const R = radius - 1.2;
    const marble = agedMarble(lib);

    // Basin rim: a low molded marble ring with a gold lip.
    add(lathe([
      [R - 0.9, -0.2], [R + 0.7, -0.2], [R + 0.75, 0.15], [R + 0.6, 0.3], [R + 0.62, 0.55], [R + 0.4, 0.62],
      [R - 0.5, 0.62], [R - 0.6, 0.5], [R - 0.6, 0.0], [R - 0.9, -0.2],
    ], 128), marble);
    add(new THREE.TorusGeometry(R + 0.05, 0.05, 8, 128).rotateX(Math.PI / 2), tm.trim, 0, 0.64);
    // a dashed rune inlay along the rim's top, like the jungle camps' floors
    const inlay = new THREE.MeshBasicNodeMaterial();
    inlay.colorNode = color(style.glow).mul(sin(time.mul(1.1)).mul(0.15).add(1)).mul(1.4);
    inlay.opacityNode = step(0.4, fract(atan(positionLocal.z, positionLocal.x).mul(90 / (2 * Math.PI))));
    inlay.alphaTest = 0.5;
    add(new THREE.RingGeometry(R - 0.32, R - 0.2, 160).rotateX(-Math.PI / 2), inlay, 0, 0.625).castShadow = false;

    // Water: deep team-tinted pool with drifting ripples and a glowing core.
    const water = new THREE.MeshStandardNodeMaterial();
    const p = positionWorld.xz;
    const r1 = mx_noise_float(vec3(p.mul(0.6), time.mul(0.35)));
    const r2 = mx_noise_float(vec3(p.mul(1.7).add(9), time.mul(0.6)));
    const nrm = normalize(vec3(r1.mul(0.12).add(r2.mul(0.06)), 1, r2.mul(0.12).sub(r1.mul(0.06))));
    water.normalNode = transformNormalToView(nrm);
    const d = uv().sub(0.5).length().mul(2);
    const viewDir = normalize(positionView.negate());
    const fres = pow(float(1).sub(abs(dot(transformNormalToView(nrm), viewDir))), float(3));
    const deep = mix(color(style.glow).mul(0.5), color(0x06141f), smoothstep(0.0, 1.0, d));
    water.colorNode = deep;
    water.roughnessNode = float(0.04);
    water.metalnessNode = float(0);
    const caustic = smoothstep(0.55, 0.9, mx_noise_float(vec3(p.mul(0.9), time.mul(0.5))).mul(0.5).add(0.5));
    water.emissiveNode = color(style.glow).mul(float(1).sub(d).mul(0.9).add(caustic.mul(0.25)).add(fres.mul(0.2))).mul(0.9);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(R - 0.55, 96).rotateX(-Math.PI / 2), water);
    pool.position.y = 0.4;
    pool.receiveShadow = true;
    this.group.add(pool);

    // Tiered fountain in the middle.
    add(lathe([
      [0.001, 0], [2.2, 0], [2.2, 0.5], [1.6, 0.6], [0.9, 0.7], [0.75, 1.8], [1.8, 2.2], [2.3, 2.45], [2.2, 2.6],
      [1.6, 2.5], [0.55, 2.55], [0.5, 3.6], [1.2, 3.9], [1.45, 4.05], [1.35, 4.15], [0.4, 4.15], [0.35, 4.9], [0.001, 4.95],
    ], 64), marble);
    add(new THREE.TorusGeometry(2.25, 0.06, 8, 64).rotateX(Math.PI / 2), tm.trim, 0, 2.5);
    add(new THREE.TorusGeometry(1.4, 0.05, 8, 64).rotateX(Math.PI / 2), tm.trim, 0, 4.08);
    const crystalGeo = new THREE.OctahedronGeometry(0.45, 0);
    crystalGeo.scale(1, 1.8, 1);
    const crystal = add(crystalGeo, tm.crystal, 0, 5.8);
    crystal.castShadow = false;
    // Water sheets spilling from the bowls, as glowing translucent skirts.
    const spill = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const sv = uv();
    const streak = mx_noise_float(vec3(sv.x.mul(40), sv.y.mul(3).add(time.mul(2.5)), 0)).mul(0.5).add(0.5);
    spill.colorNode = color(style.glow).mul(streak.mul(0.8).add(0.2)).mul(sv.y.mul(0.8).add(0.2)).mul(0.8);
    for (const [r, top, h] of [[2.25, 2.45, 2.0], [1.42, 4.05, 1.3]] as const) {
      const sheet = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.03, r + 0.25, h, 64, 1, true), spill);
      sheet.position.y = top - h / 2;
      sheet.renderOrder = 12;
      this.group.add(sheet);
    }

    // Arcing jets from the lower bowl's rim out into the pool, each landing in a ripple.
    const jetMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const ju = uv();
    const flow = mx_noise_float(vec3(ju.x.mul(14).sub(time.mul(3.2)), ju.y.mul(2), 0)).mul(0.5).add(0.5);
    jetMat.colorNode = color(style.glow).mul(flow.mul(0.7).add(0.35)).mul(smoothstep(1.0, 0.75, ju.x)).mul(0.9);
    const rippleMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // from the circle's UVs: merging bakes each ripple's offset into its positions
    const rd = uv().sub(0.5).length().mul(1.6);
    const wave = smoothstep(0.75, 1.0, fract(rd.mul(1.6).sub(time.mul(0.9))));
    rippleMat.colorNode = color(style.glow).mul(wave).mul(smoothstep(0.75, 0.2, rd)).mul(0.6);
    const jets = 8;
    const rippleGeo = new THREE.CircleGeometry(0.8, 32).rotateX(-Math.PI / 2);
    for (let i = 0; i < jets; i++) {
      const a = (i / jets) * Math.PI * 2 + Math.PI / jets;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const r = 2.3 + t * 3.4;
        // a parabola from the rim (y 2.5) over a 3.3 m crest down to the water (y 0.4)
        const y = 2.5 + 3.3 * t - 5.4 * t * t;
        pts.push(dir.clone().multiplyScalar(r).setY(Math.max(0.4, y)));
      }
      const jet = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.07, 6, false), jetMat);
      jet.renderOrder = 12;
      this.group.add(jet);
      const ripple = new THREE.Mesh(rippleGeo, rippleMat);
      ripple.position.copy(dir.clone().multiplyScalar(5.7)).setY(0.42);
      ripple.renderOrder = 11;
      this.group.add(ripple);
    }

    // Healing light column.
    const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const by = uv().y;
    const pulse = sin(time.mul(1.5).sub(by.mul(8))).mul(0.25).add(0.75);
    beamMat.colorNode = color(style.glow).mul(float(1).sub(by)).mul(pulse).mul(0.35);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 22, 32, 1, true), beamMat);
    beam.position.y = 6 + 11;
    beam.renderOrder = 13;
    this.group.add(beam);
    const light = new THREE.PointLight(style.fire.light, 120, 30, 2);
    light.position.y = 6;
    this.group.add(light);

    // Ring of fluted posts with braziers.
    const posts = 8;
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2 + Math.PI / posts;
      const x = Math.cos(a) * (radius + 1.6);
      const z = Math.sin(a) * (radius + 1.6);
      add(lathe([[0.001, 0], [0.6, 0], [0.6, 0.3], [0.45, 0.4], [0.001, 0.4]], 24), marble, x, 0, z);
      add(flutedShaft(0.3, 2.2, 12, 36, 6), marble, x, 0.4, z);
      add(lathe([[0.001, 0], [0.25, 0], [0.55, 0.25], [0.62, 0.42], [0.5, 0.4], [0.001, 0.25]], 24), tm.trim, x, 2.6, z);
      const fire = new Fire(new THREE.Vector3(x, 2.95, z), 0.85, i * 3.1 + (team === 'order' ? 0 : 50), 16, style.fire);
      this.fires.push(fire);
      this.group.add(fire.group);
    }
    mergeStatic(this.group, this.fires.map((f) => f.group));
  }

  update(time: number): void {
    for (const f of this.fires) f.update(time);
  }
}
