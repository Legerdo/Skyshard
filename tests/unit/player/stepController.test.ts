import { describe, expect, it } from 'vitest';
import { DEG2RAD, angleDelta, type Vec3 } from '../../../src/core/math';
import type { CharacterId } from '../../../src/data/ids';
import { createStaminaState, type StaminaState } from '../../../src/logic/stamina';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, CollisionWorld, SweepHit } from '../../../src/physics/types';
import {
  AIR_CONTROL,
  CAPSULE_RADIUS,
  DODGE_DISTANCE,
  HARD_LANDING_HEIGHT,
  JUMP_APEX_HEIGHT,
  MAX_FALL_SPEED,
  RUN_SPEED,
  SLIDE_SPEED,
  SPRINT_SPEED,
  SPRINT_STAMINA_PER_SEC,
  STEP_UP_HEIGHT,
  WALK_SPEED,
} from '../../../src/player/core/constants';
import { snapToGround } from '../../../src/player/core/moveAndSlide';
import { stepController } from '../../../src/player/core/stepController';
import {
  createControllerState,
  type ControllerEventType,
  type ControllerInput,
  type ControllerState,
  type ControllerStepResult,
  type ControllerWorld,
} from '../../../src/player/core/types';

// Fixed 60 Hz ticks against a real CollisionWorld (design "Player Controller").
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const NO_INPUT: ControllerInput = { move: { x: 0, z: 0 }, sprint: false, walk: false, jump: false, dodge: false, release: false };
const inp = (over: Partial<ControllerInput> = {}): ControllerInput => ({ ...NO_INPUT, ...over });
/** World-space move directions (yaw 0 faces +Z). */
const FORWARD = { x: 0, z: 1 };
const EAST = { x: 1, z: 0 };
const NOTHING_USED = { jump: false, dodge: false };

function box(id: number, min: Vec3, max: Vec3): Collider {
  return { kind: 'aabb', min, max, id, flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone' } };
}

const flatWorld = (): CollisionWorld => createCollisionWorld(flatHeightfield(0));

/** At rest at feet height y, already falling. */
const falling = (y: number): ControllerState => ({ ...createControllerState(v(0, y, 0), 0), mode: 'fall', grounded: false });

/** Freezes a state and its vectors, so a stepController that mutated its arguments would throw. */
function freezeState(s: ControllerState): ControllerState {
  Object.freeze(s.pos);
  Object.freeze(s.vel);
  Object.freeze(s.groundNormal);
  if (s.climbNormal !== null) Object.freeze(s.climbNormal);
  return Object.freeze(s);
}

/** Runs `ticks` ticks from `start`, feeding each (frozen) result into the next tick. */
function simulate(
  world: ControllerWorld,
  start: ControllerState,
  input: (tick: number) => ControllerInput,
  ticks: number,
  opts: { stamina?: StaminaState; character?: CharacterId } = {},
): ControllerStepResult[] {
  const out: ControllerStepResult[] = [];
  let state = freezeState({ ...start });
  let stamina: StaminaState = Object.freeze({ ...(opts.stamina ?? createStaminaState()) });
  for (let i = 0; i < ticks; i++) {
    const tickInput = input(i);
    Object.freeze(tickInput.move);
    const r = stepController(state, Object.freeze(tickInput), world, stamina, opts.character ?? 'kairen', DT);
    out.push(r);
    state = freezeState(r.state);
    stamina = Object.freeze(r.stamina);
  }
  return out;
}

const hSpeed = (s: ControllerState): number => Math.hypot(s.vel.x, s.vel.z);
const eventTypes = (r: ControllerStepResult): ControllerEventType[] => r.events.map((e) => e.type);
const firstWith = (rs: readonly ControllerStepResult[], type: ControllerEventType): number =>
  rs.findIndex((r) => r.events.some((e) => e.type === type));

describe('stepController: jump, fall and air control', () => {
  it('a ground jump peaks at 1.4 m under 25 m/s² and lands with that fall height', () => {
    const res = simulate(flatWorld(), createControllerState(v(0, 0, 0), 0), (i) => inp({ jump: i === 0 }), 60);
    expect(eventTypes(res[0])).toEqual(['jumped']);
    expect(res[0].consumed).toEqual({ jump: true, dodge: false });
    const apex = Math.max(...res.map((r) => r.state.pos.y));
    expect(apex).toBeCloseTo(JUMP_APEX_HEIGHT, 3);

    // jump while rising, fall from the apex on, then back on the ground
    const modes = res.map((r) => r.state.mode);
    const apexTick = modes.indexOf('fall');
    expect(apexTick).toBeGreaterThan(0);
    expect(modes.slice(0, apexTick).every((m) => m === 'jump')).toBe(true);
    const land = firstWith(res, 'landed');
    expect(land).toBeGreaterThan(apexTick);
    expect(res[land].events).toEqual([{ type: 'landed', fallHeight: expect.closeTo(apex, 9) }]);
    expect(res[land].state).toMatchObject({ mode: 'grounded', grounded: true });
    expect(res[land].state.pos.y).toBeCloseTo(0, 9);
  });

  it('air control has 60 % of the ground acceleration', () => {
    const world = flatWorld();
    const start = createControllerState(v(0, 0, 0), Math.PI / 2);
    const ground = stepController(start, inp({ move: EAST }), world, createStaminaState(), 'kairen', DT);
    const air = stepController(start, inp({ move: EAST, jump: true }), world, createStaminaState(), 'kairen', DT);
    expect(air.state.mode).toBe('jump');
    expect(air.state.vel.x / ground.state.vel.x).toBeCloseTo(AIR_CONTROL, 9);
  });

  it('caps the fall speed at 40 m/s', () => {
    const res = simulate(flatWorld(), falling(300), () => NO_INPUT, 150);
    const vys = res.map((r) => r.state.vel.y);
    expect(Math.min(...vys)).toBe(-MAX_FALL_SPEED);
    expect(vys.indexOf(-MAX_FALL_SPEED)).toBeLessThanOrEqual(97); // 40 / 25 = 1.6 s = 96 ticks
    expect((res[148].state.pos.y - res[149].state.pos.y) / DT).toBeCloseTo(MAX_FALL_SPEED, 9);
    expect(res.every((r) => r.state.mode === 'fall')).toBe(true);
  });
});

describe('stepController: ground speeds', () => {
  const world = flatWorld();
  const start = createControllerState(v(0, 0, 0), 0);
  const speeds = (input: ControllerInput, ticks: number, stamina?: StaminaState): number[] =>
    simulate(world, start, () => input, ticks, { stamina }).map((r) => hSpeed(r.state));

  it('runs at 6, walks at 2.5 (toggle or tilt ≤ 0.5) and sprints at 9 m/s, each reached in 0.15 s', () => {
    const cases: ReadonlyArray<readonly [ControllerInput, number]> = [
      [inp({ move: FORWARD }), RUN_SPEED],
      [inp({ move: FORWARD, walk: true }), WALK_SPEED],
      [inp({ move: { x: 0, z: 0.4 } }), WALK_SPEED],
      [inp({ move: { x: 0, z: 0.5 } }), WALK_SPEED],
      [inp({ move: FORWARD, sprint: true }), SPRINT_SPEED],
    ];
    for (const [input, target] of cases) {
      const sp = speeds(input, 20);
      expect(sp[7]).toBeLessThan(target);
      expect(sp[8]).toBeCloseTo(target, 9); // 9 ticks = 0.15 s
      expect(sp[19]).toBeCloseTo(target, 9);
    }
  });

  it('sprinting drains 18 stamina per second and falls back to running while exhausted', () => {
    const sprint = inp({ move: FORWARD, sprint: true });
    const res = simulate(world, start, () => sprint, 60, { character: 'isla' });
    expect(res[59].stamina.value).toBeCloseTo(100 - SPRINT_STAMINA_PER_SEC, 6);
    expect(speeds(sprint, 20, { value: 10, max: 100, exhausted: true, idleTimer: 0 })[19]).toBeCloseTo(RUN_SPEED, 9);
  });

  it('emits exhausted once, on the tick stamina runs out, then runs', () => {
    const moving: ControllerState = { ...start, vel: v(0, 0, RUN_SPEED) };
    const sprint = inp({ move: FORWARD, sprint: true });
    const res = simulate(world, moving, () => sprint, 3, { stamina: { value: 0.2, max: 100, exhausted: false, idleTimer: 0 } });
    expect(eventTypes(res[0])).toEqual(['exhausted']);
    expect(res[0].stamina).toMatchObject({ value: 0, exhausted: true });
    expect(res.slice(1).every((r) => r.events.length === 0)).toBe(true);
    expect(hSpeed(res[2].state)).toBeCloseTo(RUN_SPEED, 9);
  });

  it('stops within 0.12 s of releasing the stick and turns around over 0.15 s', () => {
    const sprinting = simulate(world, start, () => inp({ move: FORWARD, sprint: true }), 20)[19].state;
    expect(hSpeed(sprinting)).toBeCloseTo(SPRINT_SPEED, 9);
    const stop = simulate(world, sprinting, () => NO_INPUT, 8).map((r) => hSpeed(r.state));
    expect(stop[5]).toBeGreaterThan(0);
    expect(stop[6]).toBe(0); // 7 ticks ≈ 0.117 s

    const back = simulate(world, sprinting, () => inp({ move: { x: 0, z: -1 } }), 10);
    expect(back[3].state.yaw).toBeCloseTo((4 * Math.PI) / 9, 4); // 20° per tick, interpolated
    expect(Math.abs(angleDelta(back[7].state.yaw, Math.PI))).toBeGreaterThan(0.1);
    expect(angleDelta(back[8].state.yaw, Math.PI)).toBeCloseTo(0, 9); // 9 ticks = 0.15 s
  });
});

describe('stepController: collide-and-slide', () => {
  it('slides along a wall with the tangential part of the run speed and never enters it', () => {
    const world = flatWorld();
    world.addStatic(box(1, v(1, -1, -20), v(2, 3, 20)));
    const diagonal = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    const res = simulate(world, createControllerState(v(0, 0, 0), 0), () => inp({ move: diagonal }), 60);
    for (const r of res) {
      expect(r.state.mode).toBe('grounded');
      expect(r.state.pos.x + CAPSULE_RADIUS).toBeLessThanOrEqual(1 + 1e-9);
    }
    const [a, b] = [res[58].state, res[59].state];
    expect(b.pos.x).toBeGreaterThan(0.58);
    expect(b.pos.x - a.pos.x).toBeCloseTo(0, 6);
    expect((b.pos.z - a.pos.z) / DT).toBeCloseTo(RUN_SPEED * Math.SQRT1_2, 6);
    expect(b.pos.y).toBeCloseTo(0, 9);
    expect(b.yaw).toBeCloseTo(Math.PI / 4, 9);
  });

  it(`steps onto a ${STEP_UP_HEIGHT} m ledge without stopping and is blocked by a 0.6 m one`, () => {
    const ledge = (height: number): CollisionWorld => {
      const world = flatWorld();
      world.addStatic(box(1, v(1, -0.5, -5), v(8, height, 5)));
      return world;
    };
    const start = createControllerState(v(0, 0, 0), Math.PI / 2);
    const east = (): ControllerInput => inp({ move: EAST });

    const up = simulate(ledge(STEP_UP_HEIGHT), start, east, 60);
    let prevX = start.pos.x;
    for (const r of up) {
      expect(r.state.mode).toBe('grounded');
      expect(r.state.pos.x).toBeGreaterThan(prevX);
      prevX = r.state.pos.x;
    }
    expect(up[59].state.pos.x).toBeGreaterThan(3);
    expect(up[59].state.pos.y).toBeCloseTo(STEP_UP_HEIGHT, 3);

    for (const r of simulate(ledge(0.6), start, east, 60)) {
      expect(r.state.pos.x + CAPSULE_RADIUS).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.state.pos.y).toBeCloseTo(0, 9);
    }
  });

  it('walks on slopes up to 50°, slides down 50–65° slopes and falls off steeper ones', () => {
    const plane = (deg: number): CollisionWorld =>
      createCollisionWorld(analyticHeightfield((x) => -x * Math.tan(deg * DEG2RAD)));
    const standOn = (world: CollisionWorld): ControllerState =>
      createControllerState(snapToGround(world, v(0, 5, 0), 20).pos, 0);

    const walkable = plane(40);
    const still = simulate(walkable, standOn(walkable), () => NO_INPUT, 10);
    expect(still.every((r) => r.state.mode === 'grounded')).toBe(true);
    expect(still[9].state.pos.x).toBeCloseTo(0, 9);
    const uphill = simulate(walkable, standOn(walkable), () => inp({ move: { x: -1, z: 0 } }), 40);
    expect(uphill.every((r) => r.state.mode === 'grounded')).toBe(true);
    expect(uphill[39].state.pos.y).toBeGreaterThan(standOn(walkable).pos.y + 1);

    const steep = plane(57);
    const slide = simulate(steep, standOn(steep), () => inp({ move: { x: -1, z: 0 } }), 40);
    expect(slide.every((r) => r.state.mode === 'slide')).toBe(true);
    const end = slide[39].state;
    expect(Math.hypot(end.vel.x, end.vel.y, end.vel.z)).toBeCloseTo(SLIDE_SPEED, 6);
    expect(end.vel.x).toBeGreaterThan(0); // downhill is +x
    expect(end.pos.x).toBeGreaterThan(1);

    const cliff = plane(70);
    expect(simulate(cliff, standOn(cliff), () => NO_INPUT, 1)[0].state.mode).toBe('fall');
  });

  it('keeps the feet on or above the terrain height', () => {
    const world = createCollisionWorld(analyticHeightfield((x, z) => 0.3 * x - 0.2 * z));
    for (const mode of ['jump', 'fall'] as const) {
      for (const [x, z] of [[0, 0], [3, -2], [-5, 4]] as const) {
        const buried: ControllerState = {
          ...createControllerState(v(x, world.terrain.heightAt(x, z) - 1.5, z), 0),
          mode,
          grounded: false,
          vel: v(0, mode === 'jump' ? 2 : -2, 0),
        };
        const r = stepController(buried, NO_INPUT, world, createStaminaState(), 'kairen', DT);
        expect(r.state.pos.y).toBeGreaterThanOrEqual(world.terrain.heightAt(r.state.pos.x, r.state.pos.z));
        expect(r.state.vel.y).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('stepController: coyote time', () => {
  it('takes a ground jump for 0.1 s after walking off a ledge, and not later', () => {
    const world = flatWorld();
    world.addStatic(box(1, v(-10, -1, -10), v(2, 3, 10)));
    const east = inp({ move: EAST });
    const lead = simulate(world, createControllerState(v(0, 3, 0), Math.PI / 2), () => east, 60);
    const off = lead.findIndex((r) => r.state.mode !== 'grounded');
    expect(off).toBeGreaterThan(0);
    expect(['slide', 'fall']).toContain(lead[off].state.mode);
    /** The k-th tick after leaving the ground, with jump pressed on it only. */
    const jumpOnTick = (k: number): ControllerStepResult =>
      simulate(world, lead[off].state, (i) => (i === k - 1 ? { ...east, jump: true } : east), k, { stamina: lead[off].stamina })[k - 1];

    const inWindow = jumpOnTick(6); // 6 / 60 = 0.1 s
    expect(inWindow.consumed.jump).toBe(true);
    expect(eventTypes(inWindow)).toEqual(['jumped']);
    expect(inWindow.state.mode).toBe('jump');

    const late = jumpOnTick(7);
    expect(late.consumed.jump).toBe(false);
    expect(late.events).toEqual([]);
    expect(late.state.mode).toBe('fall');
  });

  it('gives no coyote time to the fall after a jump apex', () => {
    const res = simulate(flatWorld(), createControllerState(v(0, 0, 0), 0), (i) => inp({ jump: i === 0 || i === 22 }), 23);
    expect(res[21].state.mode).toBe('fall');
    expect(res[22].consumed.jump).toBe(false);
    expect(res[22].state.mode).toBe('fall');
  });
});

describe('stepController: landing', () => {
  it('locks input for 0.4 s after a fall of 12 m or more and leaves the buffered jump unused', () => {
    const world = flatWorld();
    const height = HARD_LANDING_HEIGHT + 1;
    // Jump held from tick 56 on (feet ≈ 1.7 m up): too close to the ground to deploy the glider.
    const drop = simulate(world, falling(height), (i) => inp({ jump: i >= 56 }), 120);
    const L = firstWith(drop, 'landed');
    expect(L).toBeGreaterThan(0);
    expect(drop.slice(0, L + 1).every((r) => !r.consumed.jump)).toBe(true);
    expect(drop[L].events).toEqual([{ type: 'landed', fallHeight: expect.closeTo(height, 6) }]);
    expect(drop[L].state.mode).toBe('landing');

    const lock = simulate(world, drop[L].state, () => inp({ move: EAST, jump: true, dodge: true }), 25, { stamina: drop[L].stamina });
    expect(lock.slice(0, 23).every((r) => r.state.mode === 'landing')).toBe(true);
    expect(lock[23].state.mode).toBe('grounded'); // input ignored for 24 ticks = 0.4 s
    for (const r of lock.slice(0, 24)) {
      expect(r.consumed).toEqual(NOTHING_USED);
      expect(r.state.pos.x).toBe(0);
    }
    expect(lock[24].consumed.jump).toBe(true);
  });

  it('lands from a shorter fall straight into grounded and fires a buffered jump on the same tick', () => {
    // Jump held from tick 30 on (feet ≈ 1.7 m up): too close to the ground to deploy the glider.
    const res = simulate(flatWorld(), falling(5), (i) => inp({ jump: i >= 30 }), 60);
    const L = firstWith(res, 'landed');
    expect(L).toBeGreaterThan(0);
    expect(res.slice(0, L).every((r) => !r.consumed.jump)).toBe(true);
    expect(eventTypes(res[L])).toEqual(['landed', 'jumped']);
    expect(res[L].consumed.jump).toBe(true);
    expect(res[L].state.mode).toBe('jump');
  });
});

describe('stepController: dodge', () => {
  const world = flatWorld();
  const start = createControllerState(v(0, 0, 0), 0);

  it('moves 4 m toward the input in 0.35 s with 0.25 s of i-frames for 20 stamina', () => {
    const res = simulate(world, start, (i) => inp({ move: EAST, dodge: i === 0 }), 22);
    expect(res[0].consumed).toEqual({ jump: false, dodge: true });
    expect(res[0].stamina.value).toBe(80);
    expect(res[0].state.yaw).toBeCloseTo(Math.PI / 2, 12); // faces the dodge direction
    expect(res.slice(0, 20).every((r) => r.state.mode === 'dodge')).toBe(true);
    expect(res[20].state.mode).toBe('grounded'); // 21 ticks = 0.35 s
    expect(res[20].state.pos.x).toBeCloseTo(DODGE_DISTANCE, 6);
    expect(res.map((r) => r.state.iFrames > 0)).toEqual([...Array<boolean>(15).fill(true), ...Array<boolean>(7).fill(false)]);
    expect(hSpeed(res[20].state)).toBeCloseTo(RUN_SPEED, 9); // held input keeps running
  });

  it('goes backward without input and stops at the end, and needs 20 stamina', () => {
    const back = simulate(world, start, (i) => inp({ dodge: i === 0 }), 21);
    expect(back[20].state.pos.z).toBeCloseTo(-DODGE_DISTANCE, 6);
    expect(back[20].state.pos.x).toBeCloseTo(0, 9);
    expect(back[20].state.yaw).toBe(0);
    expect(hSpeed(back[20].state)).toBe(0);

    const tired = stepController(start, inp({ dodge: true }), world, { value: 15, max: 100, exhausted: false, idleTimer: 0 }, 'kairen', DT);
    expect(tired.consumed).toEqual(NOTHING_USED);
    expect(tired.state.mode).toBe('grounded');
  });
});

describe('stepController: other modes', () => {
  it('drops a climb with no climbable surface in reach into a fall and runs hurt / locked without input', () => {
    const world = flatWorld();
    const climbing: ControllerState = { ...createControllerState(v(0, 5, 0), 0), mode: 'climb', grounded: false, climbNormal: v(0, 0, -1) };
    const r = stepController(climbing, NO_INPUT, world, createStaminaState(), 'kairen', DT);
    expect(r.state).toMatchObject({ mode: 'fall', climbNormal: null, grounded: false });

    const locked: ControllerState = { ...createControllerState(v(0, 0, 0), 0), mode: 'locked' };
    for (const x of simulate(world, locked, () => inp({ move: EAST, jump: true, dodge: true, sprint: true }), 10)) {
      expect(x.state.mode).toBe('locked');
      expect(x.consumed).toEqual(NOTHING_USED);
      expect(x.state.pos.x).toBe(0);
    }

    const hurt = simulate(world, { ...locked, mode: 'hurt', grounded: false, pos: v(0, 1, 0) }, () => NO_INPUT, 30);
    expect(hurt.every((x) => x.state.mode === 'hurt')).toBe(true);
    expect(firstWith(hurt, 'landed')).toBeGreaterThan(0);
    expect(hurt[29].state.grounded).toBe(true);
    expect(hurt[29].state.pos.y).toBeCloseTo(0, 9);
  });
});

describe('stepController: invalid input', () => {
  const world = flatWorld();
  const start = createControllerState(v(0, 0, 0), 0);
  const stamina = createStaminaState();

  it('discards a tick whose collision query turns non-finite: state and stamina kept, no events, nothing consumed', () => {
    const nan = Number.NaN;
    const nanHit: SweepHit = {
      t: nan,
      distance: nan,
      position: v(nan, nan, nan),
      point: v(nan, nan, nan),
      normal: v(0, 1, 0),
      colliderId: null,
      dynamic: false,
    };
    const broken: ControllerWorld = {
      terrain: world.terrain,
      sweepCapsule: () => nanHit,
      overlapCapsule: (p, r, h, f) => world.overlapCapsule(p, r, h, f),
      raycast: (o, d, m, f) => world.raycast(o, d, m, f),
      groundProbe: (p, m, r) => world.groundProbe(p, m, r),
      closestSurface: (p, r, f) => world.closestSurface(p, r, f),
    };
    for (const input of [inp({ move: EAST, jump: true }), inp({ move: EAST, dodge: true }), inp({ move: EAST, sprint: true })]) {
      const r = stepController(start, input, broken, stamina, 'kairen', DT);
      expect(r).toEqual({ state: start, stamina, events: [], consumed: NOTHING_USED });
      expect(r.state).not.toBe(start);
    }
  });

  it('ignores a non-finite or non-positive dt and a non-finite state, and treats non-finite move axes as 0', () => {
    for (const dt of [Number.NaN, 0, -DT, Number.POSITIVE_INFINITY]) {
      expect(stepController(start, inp({ jump: true }), world, stamina, 'kairen', dt)).toEqual({
        state: start,
        stamina,
        events: [],
        consumed: NOTHING_USED,
      });
    }
    const bad = stepController({ ...start, vel: v(Number.NaN, 0, 0) }, inp({ jump: true }), world, stamina, 'kairen', DT);
    expect(bad.events).toEqual([]);
    expect(bad.consumed).toEqual(NOTHING_USED);
    expect(Number.isNaN(bad.state.vel.x)).toBe(true);

    const nanAxis = stepController(start, inp({ move: { x: Number.NaN, z: 1 } }), world, stamina, 'kairen', DT);
    expect(nanAxis.state.vel.x).toBeCloseTo(0, 12);
    expect(nanAxis.state.vel.z).toBeGreaterThan(0);
  });
});
