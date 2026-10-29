/**
 * TSL (three.js shading language) re-exported with loose typing.
 *
 * The @types/three TSL definitions are extremely strict about node swizzle
 * and vector widths, which costs a lot of casting for no runtime benefit in
 * shader-building code. Render and scene code imports TSL from here instead.
 */
import * as TSL from 'three/tsl';

const T = TSL as any;

export const Fn: any = T.Fn;
export const If: any = T.If;
export const Loop: any = T.Loop;
export const PI: any = T.PI;
export const TWO_PI: any = T.TWO_PI;
export const abs: any = T.abs;
export const atan: any = T.atan;
export const attribute: any = T.attribute;
export const billboarding: any = T.billboarding;
export const bool: any = T.bool;
export const builtinAOContext: any = T.builtinAOContext;
export const cameraPosition: any = T.cameraPosition;
export const cdl: any = T.cdl;
export const clamp: any = T.clamp;
export const color: any = T.color;
export const cos: any = T.cos;
export const cross: any = T.cross;
export const dot: any = T.dot;
export const emissive: any = T.emissive;
export const exp: any = T.exp;
export const faceDirection: any = T.faceDirection;
export const float: any = T.float;
export const floor: any = T.floor;
export const fog: any = T.fog;
export const fract: any = T.fract;
export const hash: any = T.hash;
export const instanceIndex: any = T.instanceIndex;
export const int: any = T.int;
export const length: any = T.length;
export const luminance: any = T.luminance;
export const mat3: any = T.mat3;
export const max: any = T.max;
export const min: any = T.min;
export const mix: any = T.mix;
export const modelWorldMatrix: any = T.modelWorldMatrix;
export const mrt: any = T.mrt;
export const mx_fractal_noise_float: any = T.mx_fractal_noise_float;
export const mx_noise_float: any = T.mx_noise_float;
export const mx_worley_noise_float: any = T.mx_worley_noise_float;
export const normalGeometry: any = T.normalGeometry;
export const normalLocal: any = T.normalLocal;
export const normalView: any = T.normalView;
export const normalWorld: any = T.normalWorld;
export const normalize: any = T.normalize;
export const oneMinus: any = T.oneMinus;
export const output: any = T.output;
export const packNormalToRGB: any = T.packNormalToRGB;
export const pass: any = T.pass;
export const positionGeometry: any = T.positionGeometry;
export const positionLocal: any = T.positionLocal;
export const positionView: any = T.positionView;
export const positionWorld: any = T.positionWorld;
export const pow: any = T.pow;
export const reflect: any = T.reflect;
export const remap: any = T.remap;
export const renderOutput: any = T.renderOutput;
export const rotate: any = T.rotate;
export const sample: any = T.sample;
export const saturate: any = T.saturate;
export const screenCoordinate: any = T.screenCoordinate;
export const screenUV: any = T.screenUV;
export const select: any = T.select;
export const sign: any = T.sign;
export const sin: any = T.sin;
export const smoothstep: any = T.smoothstep;
export const sqrt: any = T.sqrt;
export const step: any = T.step;
export const texture: any = T.texture;
export const time: any = T.time;
export const transformNormalToView: any = T.transformNormalToView;
export const uniform: any = T.uniform;
export const uniformArray: any = T.uniformArray;
export const unpackRGBToNormal: any = T.unpackRGBToNormal;
export const uv: any = T.uv;
export const varying: any = T.varying;
export const vec2: any = T.vec2;
export const vec3: any = T.vec3;
export const vec4: any = T.vec4;
export const velocity: any = T.velocity;
export const vertexIndex: any = T.vertexIndex;
export const dFdx: any = T.dFdx;
export const dFdy: any = T.dFdy;
export const log2: any = T.log2;
export const normalViewGeometry: any = T.normalViewGeometry;
