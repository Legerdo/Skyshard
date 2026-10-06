import { describe, expect, it } from 'vitest';
import {
  DEG2RAD,
  RAD2DEG,
  add,
  addInto,
  addScaled,
  angleDelta,
  approach,
  clamp,
  clamp01,
  copyV3,
  cross,
  damp,
  dirFromYaw,
  distance,
  distanceSqXZ,
  distanceXZ,
  dot,
  isFiniteNum,
  isFiniteV3,
  length,
  lengthSq,
  lengthXZ,
  lerp,
  lerpAngle,
  lerpV3,
  lerpV3Into,
  normalize,
  normalizeInto,
  scale,
  scaleInto,
  setV3,
  smoothstep,
  sub,
  subInto,
  v3,
  wrapAngle,
  yawFromDir,
  type Vec3,
} from '../../../src/core/math';

const PI = Math.PI;

/** Deterministic angles over several turns, including the ±π seam and exact multiples of π. */
const SAMPLE_ANGLES: readonly number[] = [
  0,
  PI,
  -PI,
  2 * PI,
  -2 * PI,
  3 * PI,
  -3 * PI,
  PI / 2,
  -PI / 2,
  1e-12,
  -1e-12,
  100,
  -100,
  1234.5678,
  ...Array.from({ length: 201 }, (_, i) => -20 + i * 0.2),
];

/** Same direction on the unit circle (tolerant of which side of the seam a value lands). */
const expectSameAngle = (actual: number, expected: number): void => {
  expect(Math.cos(actual)).toBeCloseTo(Math.cos(expected), 9);
  expect(Math.sin(actual)).toBeCloseTo(Math.sin(expected), 9);
};

const expectV3Close = (actual: Readonly<Vec3>, expected: Readonly<Vec3>, digits = 12): void => {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
};

describe('vector basics', () => {
  it('builds, copies and combines vectors into new objects without mutating inputs', () => {
    expect(v3()).toEqual({ x: 0, y: 0, z: 0 });
    const a = v3(1, 2, 3);
    const b = v3(4, -5, 6);
    const copy = copyV3(a);
    expect(copy).toEqual(a);
    expect(copy).not.toBe(a);

    expect(add(a, b)).toEqual({ x: 5, y: -3, z: 9 });
    expect(sub(a, b)).toEqual({ x: -3, y: 7, z: -3 });
    expect(scale(a, 2)).toEqual({ x: 2, y: 4, z: 6 });
    expect(addScaled(a, b, 0.5)).toEqual({ x: 3, y: -0.5, z: 6 });
    expect(lerpV3(a, b, 0.5)).toEqual({ x: 2.5, y: -1.5, z: 4.5 });
    expect(dot(a, b)).toBe(12);
    expect(cross(v3(1, 0, 0), v3(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
    expect(dot(cross(a, b), a)).toBeCloseTo(0, 12);

    for (const result of [add(a, b), sub(a, b), scale(a, 1), addScaled(a, b, 0), lerpV3(a, b, 0)]) {
      expect(result).not.toBe(a);
      expect(result).not.toBe(b);
    }
    expect(a).toEqual({ x: 1, y: 2, z: 3 });
    expect(b).toEqual({ x: 4, y: -5, z: 6 });
  });

  it('measures full and horizontal (XZ) lengths and distances', () => {
    const p = v3(3, 12, 4);
    expect(lengthSq(p)).toBe(169);
    expect(length(p)).toBe(13);
    expect(lengthXZ(p)).toBe(5);
    expect(distance(p, v3())).toBe(13);
    const below = v3(0, -100, 0);
    expect(distanceXZ(p, below)).toBe(5);
    expect(distanceSqXZ(p, below)).toBe(25);
  });
});

describe('normalize', () => {
  it('returns the zero vector for zero and near-zero input', () => {
    expect(normalize(v3())).toEqual({ x: 0, y: 0, z: 0 });
    expect(normalize(v3(1e-10, -1e-10, 0))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('returns a new unit vector in the same direction otherwise', () => {
    const input = v3(3, 0, -4);
    const unit = normalize(input);
    expectV3Close(unit, { x: 0.6, y: 0, z: -0.8 });
    expect(length(unit)).toBeCloseTo(1, 15);
    expect(unit).not.toBe(input);
    expect(input).toEqual({ x: 3, y: 0, z: -4 });
    expectV3Close(normalize(v3(2e-9, 0, 0)), { x: 1, y: 0, z: 0 });
  });
});

describe('angles', () => {
  it('wrapAngle maps any angle into (−π, π] without changing its direction', () => {
    for (const a of SAMPLE_ANGLES) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-PI);
      expect(w).toBeLessThanOrEqual(PI);
      expectSameAngle(w, a);
    }
    expect(wrapAngle(PI)).toBe(PI);
    expect(wrapAngle(-PI)).toBe(PI);
    expect(wrapAngle(0.5)).toBe(0.5);
    expect(wrapAngle(2 * PI)).toBe(0);
    expect(wrapAngle(Number.NaN)).toBeNaN();
  });

  it('angleDelta takes the shortest signed path across the ±π seam', () => {
    expect(angleDelta(170 * DEG2RAD, -170 * DEG2RAD)).toBeCloseTo(20 * DEG2RAD, 12);
    expect(angleDelta(-170 * DEG2RAD, 170 * DEG2RAD)).toBeCloseTo(-20 * DEG2RAD, 12);
    expect(angleDelta(PI - 0.1, -PI + 0.1)).toBeCloseTo(0.2, 12);
    expect(angleDelta(0, PI / 2)).toBe(PI / 2);
    expect(angleDelta(PI / 2, 0)).toBe(-PI / 2);
    expect(angleDelta(0, PI)).toBe(PI); // exactly opposite resolves to +π
    expect(angleDelta(0, -PI)).toBe(PI);
    for (const from of SAMPLE_ANGLES.slice(0, 40)) {
      for (const to of SAMPLE_ANGLES.slice(-40)) {
        const d = angleDelta(from, to);
        expect(Math.abs(d)).toBeLessThanOrEqual(PI);
        expectSameAngle(from + d, to);
      }
    }
  });

  it('lerpAngle interpolates along the short arc', () => {
    expect(lerpAngle(170 * DEG2RAD, -170 * DEG2RAD, 0.25)).toBeCloseTo(175 * DEG2RAD, 12);
    expect(lerpAngle(-170 * DEG2RAD, 170 * DEG2RAD, 0.25)).toBeCloseTo(-175 * DEG2RAD, 12);
    expectSameAngle(lerpAngle(170 * DEG2RAD, -170 * DEG2RAD, 0.5), PI);
    expect(lerpAngle(0.3, 1.1, 0)).toBe(0.3);
    expect(lerpAngle(0.3, 1.1, 1)).toBeCloseTo(1.1, 15);
  });

  it('yaw 0 faces +Z, positive yaw turns toward +X, and yaw/dir round-trip', () => {
    expectV3Close(dirFromYaw(0), { x: 0, y: 0, z: 1 });
    expectV3Close(dirFromYaw(PI / 2), { x: 1, y: 0, z: 0 });
    expectV3Close(dirFromYaw(-PI / 2), { x: -1, y: 0, z: 0 });
    expectV3Close(dirFromYaw(PI), { x: 0, y: 0, z: -1 });
    expect(yawFromDir(0, 1)).toBe(0);
    expect(yawFromDir(1, 0)).toBe(PI / 2);
    expect(yawFromDir(-1, 0)).toBe(-PI / 2);
    expect(yawFromDir(0, -1)).toBe(PI);
    expect(yawFromDir(-0, -1)).toBe(PI); // canonical +π, never −π
    expect(yawFromDir(0, 0)).toBe(0);

    for (const yaw of SAMPLE_ANGLES) {
      const dir = dirFromYaw(yaw);
      expect(dir.y).toBe(0);
      expect(length(dir)).toBeCloseTo(1, 12);
      expect(angleDelta(yawFromDir(dir.x, dir.z), yaw)).toBeCloseTo(0, 9);
    }
    for (const [x, z] of [
      [3, 4],
      [-2, 0.5],
      [0.1, -7],
      [-5, -5],
    ] as const) {
      expectV3Close(dirFromYaw(yawFromDir(x, z)), normalize(v3(x, 0, z)));
    }
  });
});

describe('scalar easing', () => {
  it('smoothstep hits 0 and 1 at the edges, 0.5 at the midpoint, and clamps outside', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(2, 6, 2)).toBe(0);
    expect(smoothstep(2, 6, 6)).toBe(1);
    expect(smoothstep(2, 6, 4)).toBe(0.5);
    expect(smoothstep(2, 6, -10)).toBe(0);
    expect(smoothstep(2, 6, 10)).toBe(1);
    expect(smoothstep(3, 3, 2.9)).toBe(0); // equal edges act as a step
    expect(smoothstep(3, 3, 3)).toBe(1);
    let previous = 0;
    for (let i = 0; i <= 100; i++) {
      const value = smoothstep(0, 1, i / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('damp converges to the target without overshooting and is frame-rate independent', () => {
    let value = 0;
    let previous = value;
    for (let i = 0; i < 180; i++) {
      value = damp(value, 10, 8, 1 / 60);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThanOrEqual(10);
      previous = value;
    }
    expect(value).toBeCloseTo(10, 6);
    expect(damp(damp(2, -3, 5, 0.05), -3, 5, 0.05)).toBeCloseTo(damp(2, -3, 5, 0.1), 12);
    expect(damp(2, -3, 5, 0)).toBe(2);
    expect(damp(2, -3, 5, 1e6)).toBe(-3);
  });

  it('approach moves by at most maxDelta and snaps onto the target', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(9, 10, 3)).toBe(10);
    expect(approach(0, -10, 4)).toBe(-4);
    expect(approach(5, 5, 1)).toBe(5);
    expect(approach(1, 10, -2)).toBe(1);
  });

  it('lerp, clamp, clamp01 and degree conversions', () => {
    expect(lerp(2, 6, 0)).toBe(2);
    expect(lerp(2, 6, 1)).toBe(6);
    expect(lerp(2, 6, 0.25)).toBe(3);
    expect(lerp(2, 6, 1.5)).toBe(8);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(clamp01(1.2)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.3)).toBe(0.3);
    expect(180 * DEG2RAD).toBeCloseTo(PI, 15);
    expect(PI * RAD2DEG).toBeCloseTo(180, 12);
  });
});

describe('validation', () => {
  it('isFiniteNum and isFiniteV3 reject NaN, infinities and non-numbers', () => {
    expect(isFiniteNum(1.5)).toBe(true);
    expect(isFiniteNum(0)).toBe(true);
    for (const bad of [Number.NaN, Infinity, -Infinity, '1', null, undefined, {}]) {
      expect(isFiniteNum(bad)).toBe(false);
    }
    expect(isFiniteV3(v3(1, -2, 3))).toBe(true);
    expect(isFiniteV3(v3(Number.NaN, 0, 0))).toBe(false);
    expect(isFiniteV3(v3(0, Infinity, 0))).toBe(false);
    expect(isFiniteV3(v3(0, 0, -Infinity))).toBe(false);
  });
});

describe('allocation-free *Into variants', () => {
  it('write into out, return that same object, and match the allocating versions', () => {
    const a = v3(1, 2, 3);
    const b = v3(-4, 5, 0.5);
    const out = v3(99, 99, 99);

    expect(setV3(out, 7, 8, 9)).toBe(out);
    expect(out).toEqual({ x: 7, y: 8, z: 9 });
    expect(addInto(out, a, b)).toBe(out);
    expect(out).toEqual(add(a, b));
    expect(subInto(out, a, b)).toBe(out);
    expect(out).toEqual(sub(a, b));
    expect(scaleInto(out, a, -2)).toBe(out);
    expect(out).toEqual(scale(a, -2));
    expect(normalizeInto(out, b)).toBe(out);
    expect(out).toEqual(normalize(b));
    expect(normalizeInto(out, v3(1e-12, 0, 0))).toBe(out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(lerpV3Into(out, a, b, 0.25)).toBe(out);
    expect(out).toEqual(lerpV3(a, b, 0.25));

    expect(a).toEqual({ x: 1, y: 2, z: 3 });
    expect(b).toEqual({ x: -4, y: 5, z: 0.5 });
  });

  it('allow out to alias an input and keep the concrete out type', () => {
    const p = v3(1, 2, 3);
    addInto(p, p, v3(1, 1, 1));
    expect(p).toEqual({ x: 2, y: 3, z: 4 });
    subInto(p, v3(10, 10, 10), p);
    expect(p).toEqual({ x: 8, y: 7, z: 6 });
    scaleInto(p, p, 0.5);
    expect(p).toEqual({ x: 4, y: 3.5, z: 3 });
    lerpV3Into(p, v3(0, 0, 0), p, 0.5);
    expect(p).toEqual({ x: 2, y: 1.75, z: 1.5 });
    const q = v3(0, 3, 4);
    normalizeInto(q, q);
    expectV3Close(q, { x: 0, y: 0.6, z: 0.8 });

    const tagged = { x: 0, y: 0, z: 0, tag: 'kept' };
    expect(addInto(tagged, v3(1, 0, 0), v3(0, 1, 0)).tag).toBe('kept');
    expect(tagged).toEqual({ x: 1, y: 1, z: 0, tag: 'kept' });
  });
});
