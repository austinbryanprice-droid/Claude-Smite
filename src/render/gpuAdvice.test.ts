import { describe, expect, it } from 'vitest';
import { cardFromRenderer, gpuAdvice } from './gpuAdvice';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/141.0.0.0`;

describe('cardFromRenderer', () => {
  it('pulls the card out of ANGLE renderer strings', () => {
    expect(cardFromRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU (0x00002757) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('NVIDIA GeForce RTX 4090 Laptop GPU');
    expect(cardFromRenderer('ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('Intel(R) UHD Graphics');
    expect(cardFromRenderer('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('AMD Radeon(TM) Graphics');
    expect(cardFromRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)')).toBe('ANGLE Metal Renderer: Apple M3 Max');
    expect(gpuAdvice(cardFromRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), CHROME)?.text).toMatch(/graphics acceleration/);
    expect(cardFromRenderer('Mali-G78')).toBe('Mali-G78');
  });
});

describe('gpuAdvice', () => {
  it('flags integrated graphics and names the Chrome flag', () => {
    for (const name of ['Intel(R) UHD Graphics', 'Intel(R) Iris(R) Xe Graphics', 'intel gen-12lp', 'Intel(R) Arc(TM) Graphics', 'Intel(R) Arc(TM) 140V GPU (16GB)', 'AMD Radeon(TM) Graphics', 'AMD Radeon 780M Graphics', 'AMD Radeon(TM) 610M']) {
      expect(gpuAdvice(name, CHROME)?.copy, name).toBe('chrome://flags/#force-high-performance-gpu');
    }
    expect(gpuAdvice('Intel(R) UHD Graphics', EDGE)?.copy).toBe('edge://flags/#force-high-performance-gpu');
  });

  it('leaves dedicated cards alone', () => {
    for (const name of ['NVIDIA GeForce RTX 4090 Laptop GPU', 'nvidia lovelace', 'AMD Radeon RX 7600M XT', 'AMD Radeon RX 7900 XTX', 'AMD Radeon Pro W7900', 'Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Arc(TM) B580 Graphics', 'intel xe-hpg', 'Apple M3 Max']) {
      expect(gpuAdvice(name, CHROME), name).toBeNull();
    }
  });

  it('calls out software rendering', () => {
    expect(gpuAdvice('SwiftShader Device (Subzero)', CHROME)?.text).toMatch(/graphics acceleration/);
    expect(gpuAdvice('Microsoft Basic Render Driver', CHROME)?.text).toMatch(/graphics acceleration/);
  });
});
