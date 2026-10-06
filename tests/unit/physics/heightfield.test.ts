import { describe, expect, it } from 'vitest';
import { DEG2RAD, dot, type Vec3 } from '../../../src/core/math';
import {
  analyticHeightfield,
  flatHeightfield,
  heightGradient,
  heightNormal,
  heightSlopeDeg,
  isWalkableSlope,
  normalFromGradient,
  slopeDegFromNormal,
} from '../../../src/physics/heightfield';
import { MAX_WALKABLE_SLOPE_DEG, type Heightfield } from '../../../src/physics/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const expectV3 = (a: Vec3, e: Vec3, digits = 9): void =>
  (['x', 'y', 'z'] as const).forEach((k) => expect(a[k], k).toBeCloseTo(e[k], digits));

/** Plane rising along +x with the given slope angle. */
const slopeX = (deg: number): Heightfield => analyticHeightfield((x) => Math.tan(deg * DEG2RAD) * x);

describe('flatHeightfield', () => {
  it('is level, walkable and uses one material', () => {
    const hf = flatHeightfield(3);
    expect([hf.heightAt(10, -20), hf.heightAt(-1e5, 7), hf.materialAt(0, 0), hf.walkable(4, 4)]).toEqual([3, 3, 'grass', true]);
    expect(flatHeightfield(-2, 'stone').materialAt(1, 1)).toBe('stone');
    const n = heightNormal(hf, 5, 5);
    expect(n).toEqual(v(0, 1, 0));
    expect([Object.is(n.x, 0), Object.is(n.z, 0), heightSlopeDeg(hf, 5, 5)]).toEqual([true, true, 0]);
  });
});

describe('analyticHeightfield and gradient helpers', () => {
  it('recovers the gradient and normal of a plane', () => {
    const plane = analyticHeightfield((x, z) => 1 + 0.5 * x - 0.25 * z, 'dirt');
    expect(plane.heightAt(2, 4)).toBe(1);
    expect(plane.materialAt(9, 9)).toBe('dirt');
    const g = heightGradient(plane, 2, 4);
    expect([g.dx, g.dz]).toEqual([expect.closeTo(0.5, 9), expect.closeTo(-0.25, 9)]);
    const L = Math.sqrt(1.3125);
    const n = heightNormal(plane, 2, 4);
    expectV3(n, v(-0.5 / L, 1 / L, 0.25 / L));
    // The normal is perpendicular to both surface tangents.
    expect(dot(n, v(1, 0.5, 0))).toBeCloseTo(0, 9);
    expect(dot(n, v(0, -0.25, 1))).toBeCloseTo(0, 9);
  });

  it('central differences are exact for a quadratic', () => {
    const bowl = analyticHeightfield((x, z) => x * x + 2 * z * z);
    const g = heightGradient(bowl, 3, -1);
    expect([g.dx, g.dz]).toEqual([expect.closeTo(6, 9), expect.closeTo(-4, 9)]);
  });

  it('slope and walkability follow MAX_WALKABLE_SLOPE_DEG', () => {
    expect(MAX_WALKABLE_SLOPE_DEG).toBe(50);
    expect(heightSlopeDeg(slopeX(30), 0, 0)).toBeCloseTo(30, 6);
    expect([slopeX(49.9).walkable(3, 3), slopeX(50.1).walkable(3, 3), slopeX(80).walkable(0, 0)]).toEqual([true, false, false]);
    expect([isWalkableSlope(50), isWalkableSlope(50.0001), isWalkableSlope(Number.NaN)]).toEqual([true, false, false]);
    const nan = analyticHeightfield(() => Number.NaN);
    expect(nan.walkable(0, 0)).toBe(false);
  });

  it('accepts a material function', () => {
    const hf = analyticHeightfield(() => 0, (x) => (x < 0 ? 'sand' : 'rock'));
    expect([hf.materialAt(-1, 0), hf.materialAt(1, 0)]).toEqual(['sand', 'rock']);
  });

  it('normalFromGradient is unit length and slopeDegFromNormal tolerates rounding', () => {
    for (const [dx, dz] of [[0, 0], [1, 0], [-3, 2], [1e3, -1e3]]) {
      const n = normalFromGradient({ dx, dz });
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      expect(n.y).toBeGreaterThan(0);
    }
    expect(slopeDegFromNormal(v(0, 1 + 1e-15, 0))).toBe(0);
    expect(slopeDegFromNormal(v(1, 0, 0))).toBeCloseTo(90, 9);
  });
});
