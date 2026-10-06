import { describe, expect, it } from 'vitest';
import { dirFromYaw, dot, length, scale, sub, type Vec3 } from '../../../src/core/math';
import {
  MAX_SHAPE_COORD,
  closestPointOnShape,
  closestToVerticalSegment,
  isValidShape,
  raycastShape,
  shapeBounds,
  type ShapeProximity,
} from '../../../src/physics/primitives';
import type { ColliderShape } from '../../../src/physics/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const AXES = ['x', 'y', 'z'] as const;
const expectV3 = (a: Vec3, e: Vec3, msg?: string, digits = 9): void =>
  AXES.forEach((k) => expect(a[k], `${msg ?? ''} .${k}`).toBeCloseTo(e[k], digits));
const [R2, R3] = [Math.SQRT1_2, 1 / Math.sqrt(3)];

/** Deterministic PRNG (mulberry32) for sampled checks. */
function rng(seed: number): (lo: number, hi: number) => number {
  let a = seed >>> 0;
  return (lo, hi) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return lo + (hi - lo) * (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

const box: ColliderShape = { kind: 'aabb', min: v(0, 0, 0), max: v(2, 1, 4) };
const cyl: ColliderShape = { kind: 'cylinder', base: v(0, 0, 0), radius: 1, height: 2 };
const ball: ColliderShape = { kind: 'sphere', center: v(1, 2, 3), radius: 2 };
const pill: ColliderShape = { kind: 'capsule', a: v(0, 1, 0), b: v(0, 3, 0), radius: 0.5 };
const log: ColliderShape = { kind: 'capsule', a: v(0, 0, 0), b: v(4, 0, 0), radius: 1 };
const slant: ColliderShape = { kind: 'capsule', a: v(-1, 0.5, 1), b: v(2, 2.5, -1), radius: 0.6 };
// yaw π/2 turns local +Z to world +X: half (1, 0.5, 3) spans x ±3, z ±1.
const obb: ColliderShape = { kind: 'obb', center: v(0, 0, 0), half: v(1, 0.5, 3), yaw: Math.PI / 2 };
const obbAsAabb: ColliderShape = { kind: 'aabb', min: v(-3, -0.5, -1), max: v(3, 0.5, 1) };
const tilted: ColliderShape = { kind: 'obb', center: v(5, 1, -3), half: v(1, 1, 2), yaw: 0.7 };
const SHAPES: readonly ColliderShape[] = [box, cyl, ball, pill, log, slant, obb, tilted];

const expectProx = (r: ShapeProximity, point: Vec3, queryPoint: Vec3, normal: Vec3, distance: number): void => {
  expectV3(r.point, point, 'point');
  expectV3(r.queryPoint, queryPoint, 'queryPoint');
  expectV3(r.normal, normal, 'normal');
  expect(r.distance).toBeCloseTo(distance, 9);
};

describe('isValidShape', () => {
  it('accepts well-formed shapes, including boundary values', () => {
    for (const s of SHAPES) expect(isValidShape(s), s.kind).toBe(true);
    const edge: ColliderShape[] = [
      { kind: 'aabb', min: v(1, 1, 1), max: v(1, 1, 1) },
      { kind: 'aabb', min: v(-MAX_SHAPE_COORD, 0, 0), max: v(MAX_SHAPE_COORD, 1, 1) },
      { kind: 'obb', center: v(0, 0, 0), half: v(0, 0, 0), yaw: -12 },
      { kind: 'cylinder', base: v(0, 0, 0), radius: 1e-6, height: 0 },
      { kind: 'capsule', a: v(1, 2, 3), b: v(1, 2, 3), radius: 0.1 },
    ];
    for (const s of edge) expect(isValidShape(s), JSON.stringify(s)).toBe(true);
  });

  it('rejects non-finite, out-of-range, non-positive radii, negative extents, inverted boxes and unknown kinds', () => {
    const bad = [
      { kind: 'aabb', min: v(0, Number.NaN, 0), max: v(2, 1, 4) },
      { kind: 'aabb', min: v(0, 0, 0), max: v(Number.POSITIVE_INFINITY, 1, 4) },
      { kind: 'aabb', min: v(3, 0, 0), max: v(2, 1, 4) },
      { kind: 'aabb', min: v(0, 0, 0), max: v(2, 1, MAX_SHAPE_COORD + 1) },
      { kind: 'obb', center: v(0, 0, 0), half: v(1, -0.1, 1), yaw: 0 },
      { kind: 'obb', center: v(0, 0, 0), half: v(1, 1, 1), yaw: Number.NaN },
      { kind: 'cylinder', base: v(0, 0, 0), radius: 0, height: 2 },
      { kind: 'cylinder', base: v(0, 0, 0), radius: 1, height: -1 },
      { kind: 'sphere', center: v(0, 0, 0), radius: -1 },
      { kind: 'sphere', center: v(-2e6, 0, 0), radius: 1 },
      { kind: 'sphere', radius: 1 },
      { kind: 'capsule', a: v(0, 0, 0), b: v(0, 1, 0), radius: Number.NaN },
      { kind: 'capsule', a: v(0, 0, 0), b: v(0, 1, 0), radius: 2e6 },
      { kind: 'cone', center: v(0, 0, 0), radius: 1 },
      null,
    ];
    for (const s of bad) expect(isValidShape(s as unknown as ColliderShape), JSON.stringify(s)).toBe(false);
  });
});

describe('shapeBounds', () => {
  it('has the expected extents and contains every closest point', () => {
    expect(shapeBounds(pill)).toEqual({ min: v(-0.5, 0.5, -0.5), max: v(0.5, 3.5, 0.5) });
    expect(shapeBounds(cyl)).toEqual({ min: v(-1, 0, -1), max: v(1, 2, 1) });
    expect(shapeBounds(ball)).toEqual({ min: v(-1, 0, 1), max: v(3, 4, 5) });
    expect(shapeBounds(box)).toEqual({ min: v(0, 0, 0), max: v(2, 1, 4) });
    for (const e of ['min', 'max'] as const) expectV3(shapeBounds(obb)[e], shapeBounds(obbAsAabb)[e], e);
    for (const shape of SHAPES) {
      const { min, max } = shapeBounds(shape);
      for (let i = 0; i < 300; i++) {
        const q = closestPointOnShape(shape, v(9 * Math.sin(i * 1.7), 9 * Math.cos(i * 0.9), 9 * Math.sin(i * 2.3 + 1)));
        for (const k of AXES) expect(q.point[k] >= min[k] - 1e-9 && q.point[k] <= max[k] + 1e-9, shape.kind).toBe(true);
      }
    }
  });
});

describe('closestPointOnShape', () => {
  // [case, shape, p, closest point, normal, signed distance]
  it.each<[string, ColliderShape, Vec3, Vec3, Vec3, number]>([
    ['aabb face', box, v(3, 0.5, 2), v(2, 0.5, 2), v(1, 0, 0), 1],
    ['aabb corner', box, v(3, 2, 5), v(2, 1, 4), v(R3, R3, R3), Math.sqrt(3)],
    ['aabb inside near top', box, v(1, 0.8, 2), v(1, 1, 2), v(0, 1, 0), -0.2],
    ['aabb inside near -x', box, v(0.1, 0.5, 2), v(0, 0.5, 2), v(-1, 0, 0), -0.1],
    ['aabb inside, tie prefers +Y', box, v(1, 0.5, 2), v(1, 1, 2), v(0, 1, 0), -0.5],
    ['cylinder side', cyl, v(3, 1, 0), v(1, 1, 0), v(1, 0, 0), 2],
    ['cylinder above cap', cyl, v(0.5, 3, 0), v(0.5, 2, 0), v(0, 1, 0), 1],
    ['cylinder rim', cyl, v(0, 3, -2), v(0, 2, -1), v(0, R2, -R2), Math.SQRT2],
    ['cylinder inside near side', cyl, v(0, 1, 0.9), v(0, 1, 1), v(0, 0, 1), -0.1],
    ['cylinder inside near bottom', cyl, v(0.2, 0.05, 0), v(0.2, 0, 0), v(0, -1, 0), -0.05],
    ['sphere outside', ball, v(1, 2, 8), v(1, 2, 5), v(0, 0, 1), 3],
    ['sphere inside', ball, v(1, 2.5, 3), v(1, 4, 3), v(0, 1, 0), -1.5],
    ['sphere centre → +Y', ball, v(1, 2, 3), v(1, 4, 3), v(0, 1, 0), -2],
    ['capsule side', pill, v(2, 2, 0), v(0.5, 2, 0), v(1, 0, 0), 1.5],
    ['capsule beyond end', pill, v(0, 5, 0), v(0, 3.5, 0), v(0, 1, 0), 1.5],
    ['capsule inside', pill, v(0.2, 2, 0), v(0.5, 2, 0), v(1, 0, 0), -0.3],
    ['vertical capsule on axis → +X', pill, v(0, 2, 0), v(0.5, 2, 0), v(1, 0, 0), -0.5],
    ['horizontal capsule on axis → horizontal perpendicular', log, v(1, 0, 0), v(1, 0, -1), v(0, 0, -1), -1],
  ])('%s', (_name, shape, p, point, normal, distance) => {
    expectProx(closestPointOnShape(shape, p), point, p, normal, distance);
  });

  it('OBB with yaw π/2 behaves like the AABB with swapped x/z extents', () => {
    for (const p of [v(4, 0, 0), v(0, 0, 2), v(0, 2, 0), v(5, 3, -4), v(2.5, 0.1, 0.2), v(2.9, 0, 0.3), v(0.2, 0.1, -0.85)]) {
      const [a, b, msg] = [closestPointOnShape(obb, p), closestPointOnShape(obbAsAabb, p), JSON.stringify(p)];
      expectV3(a.point, b.point, msg);
      expectV3(a.normal, b.normal, msg);
      expect(a.distance, msg).toBeCloseTo(b.distance, 9);
    }
  });

  it('OBB local +Z follows dirFromYaw and local +X maps to (cos, 0, −sin)', () => {
    const [front, side] = [dirFromYaw(0.7), v(Math.cos(0.7), 0, -Math.sin(0.7))];
    const at = (dir: Vec3, s: number): Vec3 => v(5 + dir.x * s, 1, -3 + dir.z * s);
    const [f, s] = [closestPointOnShape(tilted, at(front, 3.5)), closestPointOnShape(tilted, at(side, 0.5))];
    expectV3(f.point, at(front, 2));
    expectV3(f.normal, front);
    expectV3(s.normal, side);
    expect([f.distance, s.distance]).toEqual([expect.closeTo(1.5, 9), expect.closeTo(-0.5, 9)]);
  });

  it('handles degenerate shapes', () => {
    const dot1: ColliderShape = { kind: 'aabb', min: v(1, 1, 1), max: v(1, 1, 1) };
    expectProx(closestPointOnShape(dot1, v(1, 1, 1)), v(1, 1, 1), v(1, 1, 1), v(0, 1, 0), 0);
    expectProx(closestPointOnShape(dot1, v(1, 3, 1)), v(1, 1, 1), v(1, 3, 1), v(0, 1, 0), 2);
    const disc: ColliderShape = { kind: 'cylinder', base: v(0, 1, 0), radius: 2, height: 0 };
    expectProx(closestPointOnShape(disc, v(0.5, 4, 0)), v(0.5, 1, 0), v(0.5, 4, 0), v(0, 1, 0), 3);
    // On the axis of a tall cylinder the side is nearest and the radial falls back to +X.
    const tall: ColliderShape = { kind: 'cylinder', base: v(0, 0, 0), radius: 1, height: 4 };
    expectProx(closestPointOnShape(tall, v(0, 2, 0)), v(1, 2, 0), v(0, 2, 0), v(1, 0, 0), -1);
    const bead: ColliderShape = { kind: 'capsule', a: v(1, 2, 3), b: v(1, 2, 3), radius: 0.5 };
    expectProx(closestPointOnShape(bead, v(1, 2, 3)), v(1, 2.5, 3), v(1, 2, 3), v(0, 1, 0), -0.5);
    expectProx(closestPointOnShape(bead, v(1, 2, 5)), v(1, 2, 3.5), v(1, 2, 5), v(0, 0, 1), 1.5);
  });
});

describe('closestToVerticalSegment', () => {
  // [case, shape, x, z, y0, y1, point, queryPoint, normal, distance]
  it.each<[string, ColliderShape, number, number, number, number, Vec3, Vec3, Vec3, number]>([
    ['aabb beside: overlap midpoint', box, 3, 2, 0.2, 3, v(2, 0.6, 2), v(3, 0.6, 2), v(1, 0, 0), 1],
    ['aabb above', box, 1, 2, 1.5, 3, v(1, 1, 2), v(1, 1.5, 2), v(0, 1, 0), 0.5],
    ['aabb below', box, 1, 2, -3, -0.5, v(1, 0, 2), v(1, -0.5, 2), v(0, -1, 0), 0.5],
    ['aabb bottom inside → step up', box, 1, 2, 0.8, 2.6, v(1, 1, 2), v(1, 0.8, 2), v(0, 1, 0), -0.2],
    ['aabb spanning → nearest side', box, 0.1, 2, -1, 2, v(0, 0.5, 2), v(0.1, 0.5, 2), v(-1, 0, 0), -0.1],
    ['aabb top inside → push down', box, 1, 2, -2, 0.3, v(1, 0, 2), v(1, 0.3, 2), v(0, -1, 0), -0.3],
    ['cylinder beside', cyl, 3, 0, -1, 1, v(1, 0.5, 0), v(3, 0.5, 0), v(1, 0, 0), 2],
    ['cylinder bottom inside → step up', cyl, 0.5, 0, 1.7, 3.5, v(0.5, 2, 0), v(0.5, 1.7, 0), v(0, 1, 0), -0.3],
    ['cylinder spanning → side', cyl, 0, 0.9, -1, 3, v(0, 1, 1), v(0, 1, 0.9), v(0, 0, 1), -0.1],
    ['sphere beside', ball, 1, 6, 0, 5, v(1, 2, 5), v(1, 2, 6), v(0, 0, 1), 1],
    ['sphere above', ball, 1, 3, 5, 7, v(1, 4, 3), v(1, 5, 3), v(0, 1, 0), 1],
    ['sphere centre inside the segment → +X', ball, 1, 3, 0, 4, v(3, 2, 3), v(1, 2, 3), v(1, 0, 0), -2],
    ['sphere centre at the bottom end → +Y', ball, 1, 3, 2, 4, v(1, 4, 3), v(1, 2, 3), v(0, 1, 0), -2],
    ['capsule axis crossing → horizontal perpendicular', log, 2, 0, -1, 1, v(2, 0, -1), v(2, 0, 0), v(0, 0, -1), -1],
    ['capsule above a log', log, 2, 0, 1.5, 3, v(2, 1, 0), v(2, 1.5, 0), v(0, 1, 0), 0.5],
    ['capsule beside a log end', log, 6, 0, -2, 2, v(5, 0, 0), v(6, 0, 0), v(1, 0, 0), 1],
    ['collinear vertical capsule → +X', pill, 0, 0, 1.5, 2.5, v(0.5, 1.5, 0), v(0, 1.5, 0), v(1, 0, 0), -0.5],
    ['parallel vertical capsule beside', pill, 2, 0, 0, 5, v(0.5, 1, 0), v(2, 1, 0), v(1, 0, 0), 1.5],
  ])('%s', (_name, shape, x, z, y0, y1, point, queryPoint, normal, distance) => {
    expectProx(closestToVerticalSegment(shape, x, z, y0, y1), point, queryPoint, normal, distance);
    expectProx(closestToVerticalSegment(shape, x, z, y1, y0), point, queryPoint, normal, distance);
  });

  it('rotated OBB: a segment off the local +X face separates along (cos, 0, −sin)', () => {
    const side = v(Math.cos(0.7), 0, -Math.sin(0.7));
    const r = closestToVerticalSegment(tilted, 5 + side.x * 1.5, -3 + side.z * 1.5, -2, 5);
    expectProx(r, v(5 + side.x, 1, -3 + side.z), v(5 + side.x * 1.5, 1, -3 + side.z * 1.5), side, 0.5);
    const inside = closestToVerticalSegment(tilted, 5 + side.x * 0.9, -3 + side.z * 0.9, -2, 5);
    expectProx(inside, v(5 + side.x, 1, -3 + side.z), v(5 + side.x * 0.9, 1, -3 + side.z * 0.9), side, -0.1);
  });

  it('OBB with yaw π/2 matches the swapped AABB for segments', () => {
    const rand = rng(3);
    for (let i = 0; i < 200; i++) {
      const [x, z, y0] = [rand(-5, 5), rand(-3, 3), rand(-2, 1)];
      const y1 = y0 + rand(0, 2);
      const [a, b] = [closestToVerticalSegment(obb, x, z, y0, y1), closestToVerticalSegment(obbAsAabb, x, z, y0, y1)];
      expectV3(a.point, b.point, `#${i}`);
      expectV3(a.normal, b.normal, `#${i}`);
      expect(a.distance).toBeCloseTo(b.distance, 9);
    }
  });

  it('sampled segments: unit normals, point = queryPoint − normal·distance, exact distances and push-outs', () => {
    const rand = rng(7);
    for (const shape of SHAPES) {
      const { min, max } = shapeBounds(shape);
      for (let i = 0; i < 300; i++) {
        const x = rand(min.x - 2, max.x + 2);
        const z = rand(min.z - 2, max.z + 2);
        const y0 = rand(min.y - 2.5, max.y + 1);
        const y1 = i % 5 === 0 ? y0 : y0 + rand(0, 3);
        const r = closestToVerticalSegment(shape, x, z, y0, y1);
        const msg = `${shape.kind} #${i}`;
        expect(length(r.normal), msg).toBeCloseTo(1, 9);
        expectV3(r.point, sub(r.queryPoint, scale(r.normal, r.distance)), msg);
        expect([r.queryPoint.x, r.queryPoint.z], msg).toEqual([expect.closeTo(x, 9), expect.closeTo(z, 9)]);
        expect(r.queryPoint.y >= y0 - 1e-9 && r.queryPoint.y <= y1 + 1e-9, msg).toBe(true);
        if (r.distance < 0) {
          // Moving by normal · depth leaves the segment exactly touching.
          const k = -r.distance;
          const moved = closestToVerticalSegment(shape, x + r.normal.x * k, z + r.normal.z * k, y0 + r.normal.y * k, y1 + r.normal.y * k);
          expect(Math.abs(moved.distance), msg).toBeLessThan(1e-7);
        } else {
          // Separated: equals the minimum point distance along the segment (1-Lipschitz sampling bound).
          const n = 200;
          let best = Infinity;
          for (let j = 0; j <= n; j++) best = Math.min(best, closestPointOnShape(shape, v(x, y0 + ((y1 - y0) * j) / n, z)).distance);
          expect(r.distance, msg).toBeLessThanOrEqual(best + 1e-9);
          expect(r.distance, msg).toBeGreaterThanOrEqual(best - (y1 - y0) / (2 * n) - 1e-9);
        }
      }
    }
  });
});

describe('raycastShape', () => {
  // [case, shape, origin, dir, t, normal]; outside starts also miss when reversed or with maxDist < t.
  it.each<[string, ColliderShape, Vec3, Vec3, number, Vec3]>([
    ['aabb -x face', box, v(-5, 0.5, 2), v(1, 0, 0), 5, v(-1, 0, 0)],
    ['aabb top, diagonal ray', box, v(-1, 3, 1), v(R2, -R2, 0), 2 * Math.SQRT2, v(0, 1, 0)],
    ['obb yaw π/2 (as the swapped AABB)', obb, v(10, 0, 0.5), v(-1, 0, 0), 7, v(1, 0, 0)],
    ['rotated obb local +X face', tilted, v(5 + Math.cos(0.7) * 5, 1, -3 - Math.sin(0.7) * 5), v(-Math.cos(0.7), 0, Math.sin(0.7)), 4, v(Math.cos(0.7), 0, -Math.sin(0.7))],
    ['sphere', ball, v(1, 2, -5), v(0, 0, 1), 6, v(0, 0, -1)],
    ['sphere off-centre', ball, v(-3, 2, 4), v(1, 0, 0), 4 - Math.sqrt(3), v(-Math.sqrt(3) / 2, 0, 0.5)],
    ['cylinder side', cyl, v(-5, 1, 0.6), v(1, 0, 0), 4.2, v(-0.8, 0, 0.6)],
    ['cylinder top cap', cyl, v(0.2, 10, 0), v(0, -1, 0), 8, v(0, 1, 0)],
    ['cylinder bottom cap', cyl, v(0.2, -3, 0.1), v(0, 1, 0), 3, v(0, -1, 0)],
    ['capsule side', log, v(2, 3, 0.6), v(0, -1, 0), 2.2, v(0, 0.8, 0.6)],
    ['capsule cap', log, v(10, 0, 0), v(-1, 0, 0), 5, v(1, 0, 0)],
    ['vertical capsule top cap', pill, v(0, 9, 0), v(0, -1, 0), 5.5, v(0, 1, 0)],
    ['start inside aabb → t 0, push-out normal', box, v(1, 0.9, 2), v(1, 0, 0), 0, v(0, 1, 0)],
    ['start inside capsule', pill, v(0.2, 2, 0), v(0, 1, 0), 0, v(1, 0, 0)],
    ['start inside sphere', ball, v(1, 2, 4.5), v(0, 1, 0), 0, v(0, 0, 1)],
    ['start on surface, entering', box, v(1, 1, 2), v(0, -1, 0), 0, v(0, 1, 0)],
  ])('hits: %s', (_name, shape, origin, dir, t, normal) => {
    const hit = raycastShape(shape, origin, dir, 20);
    expect(hit?.t).toBeCloseTo(t, 9);
    if (hit) {
      expectV3(hit.normal, normal);
      expectV3(hit.point, v(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t));
    }
    if (t > 0) expect([raycastShape(shape, origin, scale(dir, -1), 20), raycastShape(shape, origin, dir, t - 0.01)]).toEqual([null, null]);
  });

  it.each<[string, ColliderShape, Vec3, Vec3]>([
    ['aabb passing above', box, v(-5, 1.5, 2), v(1, 0, 0)],
    ['aabb leaving from its surface', box, v(1, 1, 2), v(0, 1, 0)],
    ['aabb sliding along its top face from on it', box, v(1, 1, 2), v(1, 0, 0)],
    ['obb outside its rotated extent', obb, v(10, 0, 2), v(-1, 0, 0)],
    ['sphere leaving from its surface', ball, v(1, 4, 3), v(0, 1, 0)],
    ['cylinder passing above', cyl, v(-5, 2.5, 0), v(1, 0, 0)],
    ['capsule passing beside', log, v(2, 3, 1.2), v(0, -1, 0)],
    ['vertical ray beside a cylinder', cyl, v(1.5, 5, 0), v(0, -1, 0)],
  ])('misses: %s', (_name, shape, origin, dir) => expect(raycastShape(shape, origin, dir, 20)).toBeNull());

  it('hit points lie on the surface with the surface normal', () => {
    const rand = rng(11);
    for (const shape of SHAPES) {
      const { min, max } = shapeBounds(shape);
      let hits = 0;
      for (let i = 0; i < 200; i++) {
        const target = v(rand(min.x, max.x), rand(min.y, max.y), rand(min.z, max.z));
        const origin = v(target.x + rand(-8, 8), target.y + rand(-8, 8), target.z + rand(-8, 8));
        if (closestPointOnShape(shape, origin).distance <= 0) continue;
        const dir = scale(sub(target, origin), 1 / length(sub(target, origin)));
        const hit = raycastShape(shape, origin, dir, 50);
        if (!hit) continue;
        hits++;
        const at = closestPointOnShape(shape, hit.point);
        const msg = `${shape.kind} #${i}`;
        expect(Math.abs(at.distance), msg).toBeLessThan(1e-7);
        expect(length(hit.normal), msg).toBeCloseTo(1, 9);
        expect(dot(hit.normal, at.normal), msg).toBeGreaterThan(0.999);
        expect(dot(hit.normal, dir), msg).toBeLessThanOrEqual(1e-9);
      }
      expect(hits, shape.kind).toBeGreaterThan(20);
    }
  });

  it('returns null for non-finite rays, a zero direction or negative maxDist', () => {
    // Shapes themselves are validated once (isValidShape) before they reach the kernels.
    const [o, d] = [v(-5, 0.5, 2), v(1, 0, 0)];
    const calls: Parameters<typeof raycastShape>[] = [
      [box, v(Number.NaN, 0.5, 2), d, 10],
      [box, o, v(1, Number.NaN, 0), 10],
      [box, o, d, Number.NaN],
      [box, o, d, Number.POSITIVE_INFINITY],
      [box, o, d, -1],
      [box, o, v(0, 0, 0), 10],
      [ball, v(1, 2, -5), v(0, 0, 0), 10],
    ];
    for (const args of calls) expect(raycastShape(...args)).toBeNull();
  });
});
