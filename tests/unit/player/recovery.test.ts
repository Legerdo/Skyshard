import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, ColliderFlags } from '../../../src/physics/types';
import { createControllerState, type ControllerState } from '../../../src/player/core/types';
import { PlayerController } from '../../../src/player/playerController';
import {
  RECOVERY_FADE_IN,
  RECOVERY_FADE_OUT,
  RecoverySystem,
  SAFE_POSITION_CAPACITY,
  SafePositionBuffer,
  isSafePositionCandidate,
  type RecoveryBody,
  type RecoveryReason,
  type RecoveryTickResult,
  type SafePosition,
} from '../../../src/player/recovery';

// RecoverySystem (task 2.9): Safe_Position records, triggers, fade timing and target choice at 60 Hz.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const FALLBACK: SafePosition = { pos: v(-50, 0, 7), yaw: 1.2 };

/** Flat ground at y 0 with a pond 0.5 m deep over x ∈ [100, 110]. */
const pondTerrain = () => ({
  ...flatHeightfield(0),
  waterDepthAt: (x: number): number => (x >= 100 && x <= 110 ? 0.5 : 0),
});
const makeWorld = () => createCollisionWorld(pondTerrain());

function box(id: number, min: Vec3, max: Vec3, flags: Partial<ColliderFlags> = {}): Collider {
  return { kind: 'aabb', min, max, id, flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone', ...flags } };
}

/** Standing at rest (grounded) with the feet at (x, y, z). */
const standing = (x: number, z = 0, y = 0): ControllerState => createControllerState(v(x, y, z), 0);
/** In the `fall` mode with the feet at (x, y, 0). */
const falling = (x: number, y: number): ControllerState => ({ ...createControllerState(v(x, y, 0), 0), mode: 'fall', grounded: false });

const newRecovery = (world = makeWorld()) => new RecoverySystem({ world, fallback: () => FALLBACK });

interface LogEntry extends RecoveryTickResult {
  active: boolean;
  alpha: number;
}

/**
 * Ticks `recovery` like main.ts: body(i) is the player's state after tick i's movement until a teleport,
 * after which the player stands at the teleport target.
 */
function simulate(
  recovery: RecoverySystem,
  body: (tick: number) => RecoveryBody,
  ticks: number,
  inCombat = false,
): LogEntry[] {
  const log: LogEntry[] = [];
  let moved: RecoveryBody | null = null;
  for (let i = 0; i < ticks; i++) {
    const result = recovery.tick({ body: moved ?? body(i), dt: DT, inCombat });
    if (result.teleport !== null) moved = createControllerState(result.teleport.pos, result.teleport.yaw);
    log.push({ ...result, active: recovery.active, alpha: recovery.fadeAlpha });
  }
  return log;
}

/** A recovery holding one Safe_Position per x in `xs` (each stood on for 1 s), newest last. */
function recordedAt(xs: readonly number[], world = makeWorld()): RecoverySystem {
  const recovery = newRecovery(world);
  for (const x of xs) simulate(recovery, () => standing(x), 60);
  expect(recovery.safePositions.map((p) => p.pos.x)).toEqual([...xs].reverse());
  return recovery;
}

/** The first teleport while `body` is ticked (at most 3 s). */
function firstTeleport(recovery: RecoverySystem, body: RecoveryBody) {
  return simulate(recovery, () => body, 180).find((e) => e.teleport !== null)?.teleport ?? null;
}

describe('SafePositionBuffer', () => {
  it('keeps the newest 8 entries, newest first, and can refresh the newest in place', () => {
    const buffer = new SafePositionBuffer();
    expect(buffer.latest()).toBeNull();
    for (let i = 0; i < 10; i++) buffer.push({ pos: v(i, 0, 0), yaw: i });
    expect(SAFE_POSITION_CAPACITY).toBe(8);
    expect(buffer.size).toBe(8);
    expect(buffer.newestFirst().map((p) => p.pos.x)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    buffer.replaceLatest({ pos: v(42, 0, 0), yaw: 0 });
    expect(buffer.newestFirst().map((p) => p.pos.x)).toEqual([42, 8, 7, 6, 5, 4, 3, 2]);
    const latest = buffer.latest();
    if (latest !== null) latest.pos.x = -1; // copies: the stored entry is not affected
    expect(buffer.latest()?.pos.x).toBe(42);
  });
});

describe('Safe_Position recording (Req 20.4)', () => {
  it('records at most once per second while the character keeps standing on safe ground', () => {
    const recovery = newRecovery();
    simulate(recovery, (i) => standing(i / 10), 181); // 6 m/s along +X
    expect(recovery.safePositions.map((p) => p.pos.x)).toEqual([18, 12, 6, 0]);
  });

  it('refreshes the newest entry instead of stacking copies while the character stands still', () => {
    const recovery = newRecovery();
    simulate(recovery, () => standing(5), 600);
    expect(recovery.safePositions).toEqual([{ pos: v(5, 0, 0), yaw: 0 }]);
  });

  it('records nothing in combat or in the air, then the first safe tick after it', () => {
    const recovery = newRecovery();
    simulate(recovery, (i) => standing(i / 10), 150, true);
    simulate(recovery, () => falling(20, 3), 60);
    expect(recovery.safePositions).toEqual([]);
    simulate(recovery, () => standing(30), 1);
    expect(recovery.safePositions.map((p) => p.pos.x)).toEqual([30]);
  });

  it('accepts walkable terrain and static walkable tops only: no water, hazard, moving platform or edge buffer', () => {
    const world = makeWorld();
    world.addStatic(box(1, v(-2, 0, 18), v(2, 1, 22))); // stone block, top y 1
    world.addStatic(box(2, v(-2, 0, 28), v(2, 1, 32), { hazard: 'lava' }));
    world.upsertDynamic(box(3, v(-2, 0, 38), v(2, 1, 42))); // moving platform
    world.addStatic(box(4, v(-2, 0, 48), v(2, 1, 52), { walkableTop: false }));
    world.addStatic(box(5, v(103, 0.6, -2), v(107, 1, 2), { material: 'wood' })); // bridge over the pond
    const ok = (body: RecoveryBody, inCombat = false, unsafeAt?: (feet: Readonly<Vec3>) => boolean) =>
      isSafePositionCandidate(world, body, inCombat, unsafeAt);

    expect(ok(standing(0))).toBe(true);
    expect(ok(standing(0, 20, 1))).toBe(true); // static collider top
    expect(ok(standing(105, 0, 1))).toBe(true); // bridge: feet above the water surface
    expect(ok(standing(469))).toBe(true);

    expect(ok(standing(0), true)).toBe(false); // In_Combat
    expect(ok(falling(0, 3))).toBe(false); // airborne
    expect(ok({ ...standing(0), wading: true })).toBe(false);
    expect(ok(standing(101))).toBe(false); // in the pond
    expect(ok(standing(0, 30, 1))).toBe(false); // hazard
    expect(ok(standing(0, 40, 1))).toBe(false); // dynamic collider
    expect(ok(standing(0, 50, 1))).toBe(false); // not a walkable top
    expect(ok(standing(480))).toBe(false); // 470–490 m buffer ring
    expect(ok(standing(0, 0, 0.5))).toBe(false); // no ground within snap distance
    expect(ok(standing(0, 0, -0.5))).toBe(false); // feet sunk into the ground
    const probed: Vec3[] = [];
    const volumeHook = (feet: Readonly<Vec3>): boolean => {
      probed.push({ ...feet });
      return true;
    };
    expect(ok(standing(3, 4), false, volumeHook)).toBe(false);
    expect(probed).toEqual([v(3, 0, 4)]);
  });
});

describe('recovery triggers (Req 20.5, 20.6, 20.8)', () => {
  it.each<[RecoveryReason, RecoveryBody]>([
    ['belowTerrain', standing(40, 0, -2)], // exactly 2 m under the terrain
    ['outOfBounds', standing(491)],
    ['stuck', falling(40, 3)],
    ['manual', standing(40)], // the Pause "끼임 해제" command
  ])('%s: back to the newest Safe_Position', (reason, body) => {
    const recovery = recordedAt([0, 10, 20]);
    if (reason === 'manual') expect(recovery.requestUnstuck()).toBe(true);
    const log = simulate(recovery, () => body, 240);
    expect(log.filter((e) => e.started !== null).map((e) => e.started)).toEqual([reason]);
    expect(log.filter((e) => e.teleport !== null).map((e) => e.teleport)).toEqual([
      { reason, pos: v(20, 0, 0), yaw: 0, source: 'safePosition' },
    ]);
  });

  it('leaves feet less than 2 m under the terrain and positions up to 490 m alone', () => {
    const recovery = recordedAt([0]);
    for (const body of [standing(40, 0, -1.99), standing(490), standing(0, -489.9, 30)]) {
      expect(simulate(recovery, () => body, 30).every((e) => e.started === null)).toBe(true);
    }
  });

  it('calls a fall stuck after 2 s within 0.1 m of where it began, not a real or interrupted fall', () => {
    const stalled = simulate(recordedAt([0]), () => falling(40, 3), 180);
    expect(stalled.findIndex((e) => e.started !== null)).toBe(120); // anchor tick + 2 s
    expect(stalled.find((e) => e.started !== null)?.started).toBe('stuck');

    const creeping = simulate(recordedAt([0]), (i) => falling(40, 3 - i * 0.0006), 180); // 0.036 m/s
    expect(creeping.find((e) => e.started !== null)?.started).toBe('stuck');

    const real = simulate(recordedAt([0]), (i) => falling(40, 400 - i * 0.2), 300);
    expect(real.every((e) => e.started === null)).toBe(true);

    const interrupted = simulate(recordedAt([0]), (i) => (i === 90 ? standing(40, 0, 3) : falling(40, 3)), 240);
    expect(interrupted.findIndex((e) => e.started !== null)).toBe(91 + 120); // the window restarts after the ground tick
  });
});

describe('recovery sequence', () => {
  it('fades out for 0.35 s, moves the character, fades back in and ends within 1 s with input locked', () => {
    const log = simulate(recordedAt([0, 10]), () => standing(40, 0, -3), 120);
    const start = log.findIndex((e) => e.started !== null);
    const moved = log.findIndex((e) => e.teleport !== null);
    const done = log.findIndex((e, i) => i > start && !e.active);
    expect(start).toBe(0);
    expect((moved - start) * DT).toBeCloseTo(RECOVERY_FADE_OUT, 9);
    expect((done - start) * DT).toBeCloseTo(RECOVERY_FADE_OUT + RECOVERY_FADE_IN, 9);
    expect((done - start) * DT).toBeLessThanOrEqual(1);
    expect(log.slice(start, done).every((e) => e.active)).toBe(true);

    const alphas = log.map((e) => e.alpha);
    expect(alphas[start]).toBe(0);
    expect(alphas[moved]).toBeCloseTo(1, 9);
    expect(alphas[done]).toBe(0);
    for (let i = start + 1; i <= moved; i++) expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1] ?? 0);
    for (let i = moved + 1; i <= done; i++) expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1] ?? 1);
    expect(log.filter((e) => e.started !== null)).toHaveLength(1); // the restored spot is safe
  });

  it('refuses a second request while one is waiting or running, and accepts one afterwards', () => {
    const recovery = recordedAt([0]);
    expect(recovery.restorePlayer('manual')).toBe(true);
    expect(recovery.requestUnstuck()).toBe(false);
    simulate(recovery, () => standing(5), 10);
    expect(recovery.phase).toBe('fadeOut');
    expect(recovery.requestUnstuck()).toBe(false);
    simulate(recovery, () => standing(5), 40);
    expect(recovery.phase).toBe('idle');
    expect(recovery.requestUnstuck()).toBe(true);
  });

  it('skips Safe_Positions a collider now occupies for older ones, then uses the fallback', () => {
    const below = standing(40, 0, -3);
    const occupy = (id: number, x: number): Collider => box(id, v(x - 1, 0, -1), v(x + 1, 3, 1));

    let world = makeWorld();
    let recovery = recordedAt([0, 10, 20], world);
    world.upsertDynamic(occupy(1, 20)); // a movable crystal pushed onto the newest spot
    expect(firstTeleport(recovery, below)).toMatchObject({ pos: v(10, 0, 0), source: 'safePosition' });

    world = makeWorld();
    recovery = recordedAt([0, 10, 20], world);
    world.upsertDynamic(occupy(1, 20));
    world.addStatic(occupy(2, 10)); // a barrier built after the record
    expect(firstTeleport(recovery, below)).toMatchObject({ pos: v(0, 0, 0), source: 'safePosition' });

    world.addStatic(occupy(3, 0));
    expect(firstTeleport(recovery, below)).toEqual({ reason: 'belowTerrain', ...FALLBACK, source: 'fallback' });
  });

  it('does not count the ground a Safe_Position was recorded on as an obstacle', () => {
    const world = makeWorld();
    world.addStatic(box(1, v(-2, 0, -2), v(2, 1, 2))); // platform top at y 1
    const recovery = newRecovery(world);
    simulate(recovery, () => standing(0, 0, 1), 1);
    expect(firstTeleport(recovery, standing(40, 0, -3))).toMatchObject({ pos: v(0, 1, 0), source: 'safePosition' });
  });

  it('drives PlayerController like main.ts: the character waits during the fade and both states move', () => {
    const world = makeWorld();
    const player = new PlayerController({ world, pos: v(0, 0, 0), yaw: 0 });
    const recovery = newRecovery(world);
    const input = new InputState();
    const holdW: RawInput = { kind: 'down', code: 'KeyW', time: 0 };
    const step = (events: RawInput[] = []): void => {
      input.beginTick(events, DT);
      if (!recovery.active) player.tick(input, 0, DT);
      const { teleport } = recovery.tick({ body: player.state, dt: DT });
      if (teleport !== null) player.teleport(teleport.pos, teleport.yaw);
    };

    step([holdW]);
    for (let i = 0; i < 150; i++) step(); // 2.5 s running toward +Z
    const safe = recovery.safePositions;
    expect(safe).toHaveLength(3);
    const newest = safe[0]?.pos;
    expect(newest?.z).toBeGreaterThan(8);

    expect(recovery.requestUnstuck()).toBe(true);
    step(); // the recovery begins after this tick's move
    const waiting = { ...player.state.pos };
    for (let i = 0; i < 20; i++) {
      step();
      expect(player.state.pos).toEqual(waiting); // W is still held, but input is locked
    }
    step(); // 0.35 s: moved
    expect(player.state.pos).toEqual(newest);
    expect(player.previous.pos).toEqual(newest);
    expect(player.pose(0.5).pos).toEqual(newest);
    expect(player.state.mode).toBe('grounded');

    for (let i = 0; i < 21; i++) step(); // fade-in
    expect(recovery.active).toBe(false);
    step();
    expect(player.state.pos.z).toBeGreaterThan(newest?.z ?? Infinity); // control is back
  });
});

describe('restorePlayer with a target (Starlit_Stair fall, Req 5.6)', () => {
  it('fades to the given spot instead of a Safe_Position and records the reason', () => {
    const recovery = recordedAt([3]);
    const platform: SafePosition = { pos: v(20, 90, -57), yaw: -1.5 };
    expect(recovery.restorePlayer('stairFall', platform)).toBe(true);
    const log = simulate(recovery, () => falling(20, 70), 60);
    expect(log[0]?.started).toBe('stairFall');
    const teleports = log.filter((e) => e.teleport !== null);
    expect(teleports).toHaveLength(1);
    expect(teleports[0]?.teleport).toEqual({ reason: 'stairFall', pos: platform.pos, yaw: platform.yaw, source: 'target' });
    expect(log.findIndex((e) => e.teleport !== null)).toBe(Math.round(RECOVERY_FADE_OUT / DT)); // tick 0 starts the fade
    expect(recovery.active).toBe(false);
  });

  it('ignores a non-finite target and falls back to the Safe_Positions', () => {
    const recovery = recordedAt([3]);
    expect(recovery.restorePlayer('stairFall', { pos: v(Number.NaN, 0, 0), yaw: 0 })).toBe(true);
    expect(firstTeleport(recovery, falling(3, 50))?.source).toBe('safePosition');
  });
});

describe('setCheckpointOverride (Challenge_Area checkpoints, Req 12.8)', () => {
  const CHECKPOINT = v(60, 0, 5);

  it.each<[RecoveryReason, RecoveryBody]>([
    ['hazard', standing(40)],
    ['belowTerrain', standing(40, 0, -3)],
    ['outOfBounds', standing(495)],
    ['stuck', falling(40, 3)],
    ['manual', standing(40)],
  ])('%s: to the registered checkpoint ahead of the Safe_Positions', (reason, body) => {
    const recovery = recordedAt([0, 10, 20]);
    recovery.setCheckpointOverride('hollowroot', CHECKPOINT, 0.5);
    expect(recovery.checkpointOverride).toEqual({ areaId: 'hollowroot', spot: { pos: CHECKPOINT, yaw: 0.5 } });
    if (reason === 'hazard' || reason === 'manual') expect(recovery.restorePlayer(reason)).toBe(true);
    const log = simulate(recovery, () => body, 240);
    const teleports = log.filter((e) => e.teleport !== null).map((e) => e.teleport);
    expect(teleports).toEqual([{ reason, pos: CHECKPOINT, yaw: 0.5, source: 'checkpoint' }]);
    // The fall judgement's fade is the same 0.7 s, inside 1 s.
    const start = log.findIndex((e) => e.started !== null);
    const end = log.findIndex((e, i) => i > start && !e.active);
    expect(start).toBeGreaterThanOrEqual(0);
    expect((end - start) * DT).toBeLessThanOrEqual(1);
  });

  it('keeps an explicit target (a lift ride) and returns to the Safe_Positions once cleared', () => {
    const recovery = recordedAt([0, 10]);
    recovery.setCheckpointOverride('hollowroot', CHECKPOINT);
    const liftTop: SafePosition = { pos: v(-5, 8, 2), yaw: 1 };
    expect(recovery.restorePlayer('lift', liftTop)).toBe(true);
    expect(firstTeleport(recovery, standing(3))).toMatchObject({ pos: liftTop.pos, source: 'target' });

    recovery.setCheckpointOverride(null);
    expect(recovery.checkpointOverride).toBeNull();
    expect(firstTeleport(recovery, standing(40, 0, -3))).toMatchObject({ pos: v(10, 0, 0), source: 'safePosition' });
    recovery.setCheckpointOverride('hollowroot', v(Number.NaN, 0, 0)); // a non-finite spot clears it too
    expect(recovery.checkpointOverride).toBeNull();
  });

  it('uses the Safe_Positions while a collider occupies the checkpoint', () => {
    const world = makeWorld();
    const recovery = recordedAt([0, 10], world);
    recovery.setCheckpointOverride('hollowroot', CHECKPOINT);
    world.upsertDynamic(box(7, v(59, 0, 4), v(61, 3, 6))); // a door closed over the rune
    expect(firstTeleport(recovery, standing(40, 0, -3))).toMatchObject({ pos: v(10, 0, 0), source: 'safePosition' });
  });
});
