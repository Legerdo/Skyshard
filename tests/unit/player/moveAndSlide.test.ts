import { describe, expect, it } from 'vitest';
import { DEG2RAD, type Vec3 } from '../../../src/core/math';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, ColliderFlags, ColliderShape, CollisionWorld } from '../../../src/physics/types';
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  DODGE_DISTANCE,
  DODGE_DURATION,
  DODGE_SPEED,
  GRAVITY,
  JUMP_APEX_HEIGHT,
  JUMP_SPEED,
  STEP_UP_HEIGHT,
} from '../../../src/player/core/constants';
import {
  clampAboveTerrain,
  classifySlope,
  clipVelocity,
  moveAndSlide,
  snapToGround,
  type SlideOptions,
  type SlideResult,
} from '../../../src/player/core/moveAndSlide';
import { createControllerState, type ControllerWorld } from '../../../src/player/core/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function col(id: number, shape: ColliderShape, f: Partial<ColliderFlags> = {}): Collider {
  return { ...shape, id, flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone', ...f } } as Collider;
}

function box(id: number, min: Vec3, max: Vec3): Collider {
  return col(id, { kind: 'aabb', min, max });
}

/** Deepest penetration of the player capsule at `pos` (0 when clear or only touching). */
function maxDepth(world: CollisionWorld, pos: Vec3): number {
  return world.overlapCapsule(pos, CAPSULE_RADIUS, CAPSULE_HEIGHT).reduce((m, c) => Math.max(m, c.depth), 0);
}

interface Tick {
  res: SlideResult;
  pos: Vec3;
}

/** Fixed ticks of moveAndSlide (+ snapToGround when grounded), checking validity and non-penetration. */
function run(world: CollisionWorld, start: Vec3, delta: Vec3, ticks: number, opts: SlideOptions = { grounded: true }): Tick[] {
  const out: Tick[] = [];
  let pos = start;
  for (let i = 0; i < ticks; i++) {
    const res = moveAndSlide(world, pos, delta, opts);
    expect(res.valid).toBe(true);
    pos = opts.grounded === true ? snapToGround(world, res.pos).pos : res.pos;
    expect(maxDepth(world, pos)).toBeLessThan(1e-3);
    out.push({ res, pos });
  }
  return out;
}

const last = (ticks: Tick[]): Tick => ticks[ticks.length - 1]!;

describe('constants', () => {
  it('jump speed reaches the 1.4 m apex under 25 m/s² and the dodge covers 4 m in 0.35 s', () => {
    expect(JUMP_SPEED).toBeCloseTo(8.3666, 3);
    expect((JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY)).toBeCloseTo(JUMP_APEX_HEIGHT, 10);
    expect(DODGE_SPEED * DODGE_DURATION).toBeCloseTo(DODGE_DISTANCE, 10);
  });
});

describe('createControllerState', () => {
  it('starts grounded at rest, copies pos and wraps yaw', () => {
    const pos = v(1, 2, 3);
    const s = createControllerState(pos, 3 * Math.PI);
    pos.x = 99;
    expect(s.pos).toEqual(v(1, 2, 3));
    expect(s.yaw).toBeCloseTo(Math.PI, 12);
    expect(s).toMatchObject({ vel: v(0, 0, 0), mode: 'grounded', modeTime: 0, grounded: true, wading: false, climbNormal: null, fallStartY: 2, iFrames: 0, coyoteTime: 0 });
    expect(s.groundNormal).toEqual(v(0, 1, 0));
    expect(createControllerState(v(0, 0, 0), Number.NaN).yaw).toBe(0);
  });
});

describe('clipVelocity', () => {
  it('keeps motion along a floor–wall crease', () => {
    const out = clipVelocity(v(1, -1, 0.5), [v(-1, 0, 0), v(0, 1, 0)]);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(0.5, 12);
  });

  it('slides along the crease when sequential clipping re-enters an earlier plane', () => {
    const s = Math.hypot(1, 0.5);
    const overhang = v(-1 / s, -0.5 / s, 0);
    const out = clipVelocity(v(1, -1, 0.5), [v(0, 1, 0), overhang]);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(0.5, 12);
  });

  it('stops in an acute corner instead of bouncing back, and ignores planes it moves away from', () => {
    expect(clipVelocity(v(1, 0, 0), [v(-0.8, 0, 0.6), v(-0.8, 0, -0.6)])).toEqual(v(0, 0, 0));
    expect(clipVelocity(v(-1, 2, 3), [v(-1, 0, 0)])).toEqual(v(-1, 2, 3));
    expect(clipVelocity(v(1, 2, 3), [])).toEqual(v(1, 2, 3));
  });
});

describe('moveAndSlide: walls', () => {
  it('a diagonal move into a wall keeps the tangential component and never penetrates', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(box(1, v(1, -1, -20), v(2, 3, 20)));
    const ticks = run(world, v(0, 0, 0), v(0.1, 0, 0.1), 20);
    for (const t of ticks) expect(t.pos.x + CAPSULE_RADIUS).toBeLessThanOrEqual(1 + 1e-9);
    const end = last(ticks);
    expect(end.pos.x).toBeGreaterThan(0.58);
    expect(end.pos.z).toBeGreaterThan(1.98);
    expect(end.pos.z).toBeLessThanOrEqual(2 + 1e-9);
    expect(end.pos.y).toBeCloseTo(0, 6);
    expect(end.res.blocked).toBe(true);
    expect(end.res.normals.length).toBeGreaterThan(0);
  });

  it('slides along a rotated (obb) wall', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(col(1, { kind: 'obb', center: v(2, 1, 0), half: v(0.5, 2, 20), yaw: 30 * DEG2RAD }));
    const ticks = run(world, v(0, 0, 0), v(0.1, 0, 0), 30);
    const end = last(ticks);
    // The face tangent is (sin 30°, 0, cos 30°): pushing +X slides toward +Z.
    expect(end.pos.z).toBeGreaterThan(0.5);
    expect(end.res.blocked).toBe(true);
  });

  it('stops cleanly in a corner of two walls', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(box(1, v(1, -1, -5), v(2, 3, 2)));
    world.addStatic(box(2, v(-5, -1, 1), v(2, 3, 2)));
    const ticks = run(world, v(0, 0, 0), v(0.1, 0, 0.1), 20);
    const end = last(ticks);
    expect(end.pos.x).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(end.pos.z).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(end.pos.x).toBeGreaterThan(0.58);
    expect(end.pos.z).toBeGreaterThan(0.58);
    expect(end.res.blocked).toBe(true);
    for (let i = ticks.length - 5; i < ticks.length; i++) {
      const a = ticks[i - 1]!.pos;
      const b = ticks[i]!.pos;
      expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeLessThan(1e-6);
    }
  });
});

describe('moveAndSlide: step-up', () => {
  const stepWorld = (height: number): CollisionWorld => {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(box(1, v(1, -0.5, -5), v(6, height, 5)));
    return world;
  };

  it(`climbs a ${STEP_UP_HEIGHT} m step`, () => {
    const ticks = run(stepWorld(STEP_UP_HEIGHT), v(0, 0, 0), v(0.1, 0, 0), 40);
    expect(ticks.some((t) => t.res.steppedUp)).toBe(true);
    const end = last(ticks);
    expect(end.pos.x).toBeGreaterThan(3);
    expect(end.pos.y).toBeCloseTo(STEP_UP_HEIGHT, 3);
  });

  it('is blocked by a 0.5 m step', () => {
    const ticks = run(stepWorld(0.5), v(0, 0, 0), v(0.1, 0, 0), 40);
    expect(ticks.some((t) => t.res.steppedUp)).toBe(false);
    for (const t of ticks) {
      expect(t.pos.x + CAPSULE_RADIUS).toBeLessThanOrEqual(1 + 1e-9);
      expect(t.pos.y).toBeLessThan(0.01);
    }
    expect(last(ticks).res.blocked).toBe(true);
  });

  it('rejects a step whose top is steep (70° terrain rise)', () => {
    const tan70 = Math.tan(70 * DEG2RAD);
    const world = createCollisionWorld(analyticHeightfield((x) => (x > 1 ? (x - 1) * tan70 : 0)));
    const ticks = run(world, v(0, 0, 0), v(0.1, 0, 0), 30);
    expect(ticks.some((t) => t.res.steppedUp)).toBe(false);
    const end = last(ticks);
    expect(end.pos.x).toBeLessThan(1);
    expect(end.pos.y).toBeLessThan(0.05);
    expect(end.res.blocked).toBe(true);
  });

  it('does not step while airborne (grounded: false)', () => {
    const world = stepWorld(0.3);
    const res = moveAndSlide(world, v(0.55, 0, 0), v(0.2, 0, 0), { grounded: false });
    expect(res.steppedUp).toBe(false);
    expect(res.pos.x).toBeLessThan(0.75);
  });
});

describe('snapToGround', () => {
  it('keeps contact walking down a 30° slope', () => {
    const tan30 = Math.tan(30 * DEG2RAD);
    const world = createCollisionWorld(analyticHeightfield((x) => -x * tan30));
    let pos = snapToGround(world, v(0, 0.5, 0), 1).pos;
    for (let i = 0; i < 40; i++) {
      const res = moveAndSlide(world, pos, v(0.15, 0, 0), { grounded: true });
      const snap = snapToGround(world, res.pos);
      expect(snap.snapped).toBe(true);
      expect(snap.hit!.walkable).toBe(true);
      pos = snap.pos;
      expect(Math.abs(world.groundProbe(pos, 0.3)!.distance)).toBeLessThan(1e-4);
    }
    expect(pos.x).toBeCloseTo(6, 6);
    // A sphere resting on a 30° plane hovers r (1 / cos 30° − 1) above the ground under its bottom.
    expect(pos.y).toBeCloseTo(-6 * tan30 + CAPSULE_RADIUS * (1 / Math.cos(30 * DEG2RAD) - 1), 2);
  });

  it('leaves the position alone with no ground in range', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    const snap = snapToGround(world, v(0, 0.5, 0), 0.3);
    expect(snap).toEqual({ pos: v(0, 0.5, 0), hit: null, snapped: false });
  });
});

describe('classifySlope', () => {
  const n = (deg: number): Vec3 => v(Math.sin(deg * DEG2RAD), Math.cos(deg * DEG2RAD), 0);

  it('splits at 50° (walk | slide) and 65° (slide | climb candidate or wall)', () => {
    expect(classifySlope(n(0), false)).toBe('walk');
    expect(classifySlope(n(49.99), true)).toBe('walk');
    expect(classifySlope(n(50), true)).toBe('walk');
    expect(classifySlope(n(50.01), true)).toBe('slide');
    expect(classifySlope(n(64.99), true)).toBe('slide');
    expect(classifySlope(n(65), true)).toBe('climbCandidate');
    expect(classifySlope(n(65), false)).toBe('wall');
    expect(classifySlope(n(90), true)).toBe('climbCandidate');
    expect(classifySlope(n(90), false)).toBe('wall');
  });

  it('treats zero or non-finite normals as walls', () => {
    expect(classifySlope(v(0, 0, 0), true)).toBe('wall');
    expect(classifySlope(v(Number.NaN, 1, 0), true)).toBe('wall');
  });
});

describe('clampAboveTerrain', () => {
  const world = createCollisionWorld(analyticHeightfield((x) => 0.5 * x + 1));

  it('raises feet below the terrain and leaves feet above it alone', () => {
    expect(clampAboveTerrain(world, v(2, 0, 0))).toEqual({ pos: v(2, 2, 0), clamped: true });
    expect(clampAboveTerrain(world, v(2, 5, 0))).toEqual({ pos: v(2, 5, 0), clamped: false });
    expect(clampAboveTerrain(world, v(2, 2, 0))).toEqual({ pos: v(2, 2, 0), clamped: false });
  });

  it('ignores non-finite positions and terrain heights', () => {
    const bad = clampAboveTerrain(world, v(Number.NaN, 0, 0));
    expect(bad.clamped).toBe(false);
    expect(Number.isNaN(bad.pos.x)).toBe(true);
    const nanTerrain: Pick<ControllerWorld, 'terrain'> = { terrain: { heightAt: () => Number.NaN } };
    expect(clampAboveTerrain(nanTerrain, v(0, -5, 0))).toEqual({ pos: v(0, -5, 0), clamped: false });
  });
});

describe('moveAndSlide: invalid input', () => {
  const world = createCollisionWorld(flatHeightfield(0));

  it('returns the input position unchanged, flagged invalid, for non-finite pos or delta', () => {
    const nanPos = moveAndSlide(world, v(Number.NaN, 0, 0), v(1, 0, 0));
    expect(nanPos.valid).toBe(false);
    expect(Number.isNaN(nanPos.pos.x)).toBe(true);
    for (const delta of [v(Number.POSITIVE_INFINITY, 0, 0), v(0, Number.NaN, 0)]) {
      const res = moveAndSlide(world, v(1, 0, 2), delta, { grounded: true });
      expect(res).toMatchObject({ pos: v(1, 0, 2), valid: false, blocked: false, steppedUp: false, normals: [], hits: [] });
    }
    expect(snapToGround(world, v(0, Number.NaN, 0)).snapped).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const pos = Object.freeze(v(0, 0, 0));
    const delta = Object.freeze(v(0.1, -0.2, 0.05));
    const res = moveAndSlide(world, pos, delta, { grounded: true });
    expect(res.valid).toBe(true);
    expect(res.pos).not.toBe(pos);
    expect(res.pos.x).toBeCloseTo(0.1, 6);
    expect(res.pos.z).toBeCloseTo(0.05, 6);
    expect(res.pos.y).toBeGreaterThanOrEqual(0);
  });
});
