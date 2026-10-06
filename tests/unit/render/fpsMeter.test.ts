import { describe, expect, it } from 'vitest';
import { FpsMeter } from '../../../src/debug/fpsMeter';

function run(meter: FpsMeter, dt: number, seconds: number): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) meter.tick(dt);
}

describe('FpsMeter', () => {
  it('reports 0 before the first tick', () => {
    expect(new FpsMeter().fps).toBe(0);
  });

  it('converges to ~60 fps with 1/60 s frames', () => {
    const meter = new FpsMeter();
    run(meter, 1 / 60, 2);
    expect(meter.fps).toBeCloseTo(60, 1);
  });

  it('converges to ~30 fps with 1/30 s frames', () => {
    const meter = new FpsMeter();
    run(meter, 1 / 30, 2);
    expect(meter.fps).toBeCloseTo(30, 1);
  });

  it('follows a drop from 60 to 30 fps within ~2.5 s', () => {
    const meter = new FpsMeter();
    run(meter, 1 / 60, 2);
    run(meter, 1 / 30, 0.5);
    expect(meter.fps).toBeGreaterThan(30.5); // still smoothing after one time constant
    run(meter, 1 / 30, 2);
    expect(Math.abs(meter.fps - 30)).toBeLessThan(0.5);
  });

  it('ignores zero, negative and non-finite deltas', () => {
    const meter = new FpsMeter();
    run(meter, 1 / 60, 1);
    const before = meter.fps;
    for (const dt of [0, -1 / 60, Number.NaN, Number.POSITIVE_INFINITY]) meter.tick(dt);
    expect(meter.fps).toBe(before);
  });
});
