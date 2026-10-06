import { describe, expect, it } from 'vitest';
import { easeOutCubic, easeOutQuad, smoothDamp } from '../../../src/camera/smoothing';

describe('smoothDamp', () => {
  it('approaches a step without overshoot and leaves the value alone for dt 0', () => {
    const s = { value: 0, velocity: 0 };
    let prev = 0;
    for (let i = 0; i < 180; i++) {
      const value = smoothDamp(s, 1, 0.2, 1 / 60);
      expect(value).toBeGreaterThanOrEqual(prev);
      expect(value).toBeLessThanOrEqual(1);
      prev = value;
    }
    expect(prev).toBeCloseTo(1, 6);
    expect(smoothDamp(s, 1, 0.2, 0)).toBe(prev);
  });

  it('follows the critically damped response at any frame rate', () => {
    const after = (fps: number, frames: number): number => {
      const s = { value: 0, velocity: 0 };
      for (let i = 0; i < frames; i++) smoothDamp(s, 1, 0.2, 1 / fps);
      return s.value;
    };
    // 0.3 s with smooth time 0.2 s (ω = 10/s): 1 − (1 + ωt)·e^(−ωt).
    const analytic = 1 - 4 * Math.exp(-3);
    expect(after(30, 9)).toBeCloseTo(analytic, 2);
    expect(after(60, 18)).toBeCloseTo(analytic, 2);
    expect(after(150, 45)).toBeCloseTo(analytic, 2);
  });
});

describe('easing', () => {
  it('eases out from 0 to 1 and clamps outside [0, 1]', () => {
    expect([easeOutQuad(-1), easeOutQuad(0), easeOutQuad(0.5), easeOutQuad(1), easeOutQuad(2)]).toEqual([0, 0, 0.75, 1, 1]);
    expect([easeOutCubic(-1), easeOutCubic(0), easeOutCubic(0.5), easeOutCubic(1), easeOutCubic(2)]).toEqual([0, 0, 0.875, 1, 1]);
  });
});
