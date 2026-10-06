import { describe, expect, it } from 'vitest';
import { SHAKE_MAX_ANGLE, SHAKE_OFFSET_LIMIT } from '../../../src/camera/constants';
import { CameraShake, shakeNoise } from '../../../src/camera/shake';

const DT = 1 / 60;
const ZERO = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
const ANGLES = ['yaw', 'pitch', 'roll'] as const;

describe('CameraShake (Req 35.8)', () => {
  it('adds trauma up to 1, ignores non-positive amounts and loses 1.6 per real second', () => {
    const shake = new CameraShake();
    shake.addTrauma(0.7);
    shake.addTrauma(0.7);
    expect(shake.trauma).toBe(1);
    shake.addTrauma(-1);
    shake.addTrauma(Number.NaN);
    expect(shake.trauma).toBe(1);
    shake.update(0.25, 1);
    expect(shake.trauma).toBeCloseTo(0.6, 12);
    shake.update(0.5, 1);
    expect(shake.trauma).toBe(0);
  });

  it('gives exact zeros without trauma and at 0% intensity', () => {
    const shake = new CameraShake();
    expect(shake.update(DT, 1)).toEqual(ZERO);
    shake.addTrauma(1);
    for (let i = 0; i < 30; i++) expect(shake.update(DT, 0)).toEqual(ZERO);
    expect(shake.trauma).toBeCloseTo(1 - 1.6 * 30 * DT, 9);
  });

  it('scales with trauma² times the intensity', () => {
    const full = new CameraShake(7);
    const halfTrauma = new CameraShake(7);
    const quarterIntensity = new CameraShake(7);
    full.addTrauma(1);
    halfTrauma.addTrauma(0.5);
    quarterIntensity.addTrauma(1);
    const a = full.update(DT, 1);
    const b = halfTrauma.update(DT, 1);
    const c = quarterIntensity.update(DT, 0.25);
    expect(b).toEqual(c); // 0.5² · 100% = 1² · 25%
    for (const k of ANGLES) expect(c[k]).toBe(a[k] * 0.25);
    expect(a).not.toEqual(ZERO);
  });

  it('stays within 0.2 m and 3° and repeats for the same seed', () => {
    const shake = new CameraShake();
    const twin = new CameraShake();
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      shake.addTrauma(1);
      twin.addTrauma(1);
      const s = shake.update(DT, 1);
      expect(twin.update(DT, 1)).toEqual(s);
      expect(Math.hypot(s.x, s.y, s.z)).toBeLessThanOrEqual(SHAKE_OFFSET_LIMIT + 1e-12);
      for (const k of ANGLES) expect(Math.abs(s[k])).toBeLessThanOrEqual(SHAKE_MAX_ANGLE);
      peak = Math.max(peak, Math.abs(s.roll));
    }
    expect(peak).toBeGreaterThan(SHAKE_MAX_ANGLE * 0.5);
  });

  it('uses continuous seeded noise in [−1, 1]', () => {
    for (let i = 0; i < 1000; i++) {
      const t = i * 0.0137;
      const n = shakeNoise(3, t);
      expect(Math.abs(n)).toBeLessThanOrEqual(1);
      expect(shakeNoise(3, t)).toBe(n);
      expect(Math.abs(shakeNoise(3, t + 1e-7) - n)).toBeLessThan(1e-4);
    }
    expect(shakeNoise(3, 0.5)).not.toBe(shakeNoise(4, 0.5));
  });
});
