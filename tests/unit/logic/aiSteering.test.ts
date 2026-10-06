import { describe, expect, it } from 'vitest';
import {
  CIRCLE_SPEED_FRACTION, ENEMY_SPACING, FRESH_PROGRESS, PROBE_MAX_DROP, PROBE_MAX_SLOPE_DEG, PROBE_MAX_WATER,
  STUCK_MIN_PROGRESS, STUCK_SECONDS, WAIT_RING, advanceProgress, chooseProbe, circleSide, probeBlocked, progressStalled,
  ringSteer, rotateYaw, separateBodies, separationSteer, spacingFor, type ProbeChoice, type ProbeSample,
  type SpacingBody,
} from '../../../src/logic/aiSteering';

// Enemy movement rules (design "공격 토큰과 분리", "지형 탐지와 이동"; Req 28.6–28.8): waiting ring, separation,
// probe decision and the progress window, as pure functions.
const body = (x: number, z: number, radius = 0.5, y = 0, height = 1.3): SpacingBody => ({ x, y, z, radius, height });
const flatDistance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

describe('waiting ring (Req 28.6)', () => {
  it('alternates the side with the ordinal parity', () => {
    expect([0, 1, 2, 3, 10, 11].map(circleSide)).toEqual([1, -1, 1, -1, 1, -1]);
  });

  it('moves along the ring at half speed on its middle, counter-clockwise (positive yaw) for side +1', () => {
    const centre = { x: 0, z: 0 };
    const plus = ringSteer({ x: 0, z: 5 }, centre, 1);
    const minus = ringSteer({ x: 0, z: 5 }, centre, -1);
    expect(plus.x).toBeCloseTo(CIRCLE_SPEED_FRACTION, 12); // bearing atan2(x, z) grows
    expect(plus.z).toBeCloseTo(0, 12);
    expect(minus.x).toBeCloseTo(-CIRCLE_SPEED_FRACTION, 12);
  });

  it('pulls out from inside the ring and in from beyond it, at most full speed', () => {
    const centre = { x: 0, z: 0 };
    const inside = ringSteer({ x: 0, z: 2 }, centre, 1); // radial is +Z here
    const outside = ringSteer({ x: 0, z: 9 }, centre, 1);
    expect(inside.z).toBeGreaterThan(0.8);
    expect(outside.z).toBeLessThan(-0.8);
    for (const v of [inside, outside]) expect(Math.hypot(v.x, v.z)).toBeCloseTo(1, 12);
    expect(ringSteer({ x: 0, z: WAIT_RING[0] }, centre, 1).z).toBeGreaterThan(0);
    expect(ringSteer({ x: 0, z: WAIT_RING[1] }, centre, 1).z).toBeLessThan(0);
    const onCentre = ringSteer(centre, centre, 1);
    expect(onCentre.z).toBeGreaterThan(0); // heads out along +Z
  });
});

describe('separation (Req 28.7)', () => {
  it('spacing is 1.2 m, or the radius sum when that is larger', () => {
    expect([spacingFor(0.5, 0.5), spacingFor(0.5, 1), spacingFor(1, 1.1)]).toEqual([ENEMY_SPACING, 1.5, 2.1]);
  });

  it('steers away from close neighbours, more strongly the closer they are, and ignores far or other-floor ones', () => {
    const self = body(0, 0);
    const near = separationSteer(self, [self, body(0.6, 0)]);
    const nearer = separationSteer(self, [body(0.3, 0)]);
    expect(near.x).toBeLessThan(0);
    expect(near.z).toBeCloseTo(0, 12);
    expect(nearer.x).toBeLessThan(near.x);
    expect(separationSteer(self, [body(2.3, 0)])).toEqual({ x: 0, z: 0 }); // beyond 1.2 + 1 m
    expect(separationSteer(self, [body(0.5, 0, 0.5, 3)])).toEqual({ x: 0, z: 0 }); // on a ledge above
    const crowd = separationSteer(self, [body(0.2, 0), body(0.2, 0.1), body(0.1, 0.2)]);
    expect(Math.hypot(crowd.x, crowd.z)).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('the spacing pass pushes a close pair apart half each to exactly their spacing', () => {
    const [a, b] = separateBodies([body(0, 10), body(0.5, 10)]);
    expect(flatDistance(a!, b!)).toBeCloseTo(1.2, 9);
    expect([a!.x, b!.x]).toEqual([expect.closeTo(-0.35, 9), expect.closeTo(0.85, 9)]);
    const [c, d] = separateBodies([body(0, 0, 1), body(0, 1.5, 1)]); // radius sum 2 m
    expect(flatDistance(c!, d!)).toBeCloseTo(2, 9);
    const [e, f] = separateBodies([body(3, 3), body(3, 3)]); // coincident: split along X
    expect([e!.x, f!.x, e!.z, f!.z]).toEqual([expect.closeTo(2.4, 12), expect.closeTo(3.6, 12), 3, 3]);
  });

  it('settles a packed row so every pair keeps its spacing, and leaves spaced or other-floor pairs alone', () => {
    const row = [body(0, 0), body(0.4, 0), body(0.8, 0), body(0.9, 0.3)];
    const out = separateBodies(row);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) expect(flatDistance(out[i]!, out[j]!)).toBeGreaterThanOrEqual(1.2 - 1e-9);
    }
    const spaced = [body(0, 0), body(1.2, 0), body(0, 0.2, 0.5, 5)];
    expect(separateBodies(spaced)).toEqual(spaced.map((s) => ({ x: s.x, z: s.z })));
  });
});

describe('terrain probes (Req 28.8)', () => {
  const open: ProbeSample = { drop: 0, slopeDeg: 0, waterDepth: 0, inside: true, obstacle: false };

  it.each([
    ['a drop over 2.5 m', { drop: PROBE_MAX_DROP + 0.01 }, true],
    ['a 2.5 m drop', { drop: PROBE_MAX_DROP }, false],
    ['higher ground', { drop: -3 }, false],
    ['a slope over 50°', { slopeDeg: PROBE_MAX_SLOPE_DEG + 0.1 }, true],
    ['a 50° slope', { slopeDeg: PROBE_MAX_SLOPE_DEG }, false],
    ['water over 1 m', { waterDepth: PROBE_MAX_WATER + 0.01 }, true],
    ['1 m of water', { waterDepth: PROBE_MAX_WATER }, false],
    ['outside the boundary', { inside: false }, true],
    ['a waist-height obstacle', { obstacle: true }, true],
    ['nothing', {}, false],
  ] as const)('%s blocks: %s', (_label, change, blocked) => {
    expect(probeBlocked({ ...open, ...change })).toBe(blocked);
  });

  const choose = (blocked: readonly ProbeChoice[], previous: ProbeChoice = 0, fallback: 1 | -1 = 1) => {
    const asked: ProbeChoice[] = [];
    const choice = chooseProbe((c) => {
      asked.push(c);
      return blocked.includes(c);
    }, previous, fallback);
    return { choice, asked };
  };

  it('goes straight when open, without sampling the sides', () => {
    expect(choose([])).toEqual({ choice: 0, asked: [0] });
    expect(choose([1, -1])).toEqual({ choice: 0, asked: [0] });
  });

  it('takes the open side when straight is blocked; both open → the previous side, else the fallback', () => {
    expect(choose([0, 1]).choice).toBe(-1);
    expect(choose([0, -1]).choice).toBe(1);
    expect(choose([0], 0, 1).choice).toBe(1);
    expect(choose([0], 0, -1).choice).toBe(-1);
    expect(choose([0], -1, 1)).toEqual({ choice: -1, asked: [0, -1] });
    expect(choose([0], 1, -1).choice).toBe(1);
  });

  it('is null (turn only) when all three are blocked', () => {
    expect(choose([0, 1, -1])).toEqual({ choice: null, asked: [0, 1, -1] });
  });

  it('rotates probe directions in the yaw sense (+Z toward +X)', () => {
    const v = rotateYaw({ x: 0, z: 1 }, Math.PI / 2);
    expect(v.x).toBeCloseTo(1, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });
});

describe('progress window (Req 28.8)', () => {
  const DT = 1 / 60;
  const run = (perTick: number, ticks: number) => {
    let w = FRESH_PROGRESS;
    let stalledAt: number | null = null;
    for (let i = 1; i <= ticks && stalledAt === null; i++) {
      w = advanceProgress(w, perTick, DT);
      if (progressStalled(w)) stalledAt = i;
    }
    return stalledAt;
  };

  it('stalls after 2 s that close less than 0.5 m, and never while 0.5 m is closed every 2 s', () => {
    expect(run(0, 200)).toBe(Math.round(STUCK_SECONDS / DT));
    expect(run((STUCK_MIN_PROGRESS * 0.9) / 120, 200)).toBe(120);
    expect(run(STUCK_MIN_PROGRESS / 110, 600)).toBeNull();
    expect(run(-0.01, 200)).toBe(120); // backing away is no progress
  });
});
