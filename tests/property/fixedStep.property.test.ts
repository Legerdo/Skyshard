// Feature: skyshard-echoes-of-the-wild, Property 13: 고정 스텝의 프레임률 독립성
//
// **Validates: Requirements 1.9**
//
// Pipeline (real code except the parts marked *): a timeline* of timestamped RawInput events, i.e. what
// BrowserInput.drain() yields → a queue* that takes the events up to each render frame's time →
// GameLoop.frame (accumulator, SIM_DT steps, 5-step cap, 0.25 s clamp) → per tick InputState.beginTick
// (the first tick after a frame drains the queue, later ticks of that frame get [], as its contract says)
// → ControllerInput* (stand-in for task 2.8's adapter, camera yaw 0) → stepController on flat ground →
// InputState.consumeBuffered for the presses the tick used. The reference is the same pipeline with
// 60 Hz frames, one tick each.
//
// Sampling offset. An input at real time t is queued by the first frame at or after t and read by the
// next tick, the one covering the previous frame's time. With 60 Hz frames that is the tick covering t;
// with frames of at most 1/30 s it is that tick or one of the two before it. Such frames run at most
// 2 steps, so the cap and the clamp never engage: the ticks are identical and only the tick that reads
// each input moves, by up to 2 ticks.
//
// Timelines. Inputs ("beats") are at least 1 s apart and every response settles well inside that (jump
// air time ≈ 0.67 s, dodge 0.35 s, press buffer 0.15 s, speed and turn changes ≤ 0.15 s), so each beat
// meets a settled controller and plays the reference's response shifted in time. Closer beats could let
// the offset flip a discrete window (a press expiring in the buffer mid-air, the dodge's exit speed),
// which is a difference in when the input was read, not in the simulation.
//
// 5 % budget. Distances then differ only through beat shifts: at most 2 ticks of travel per speed-up,
// and each speed-up is followed by ≥ 1 s at the new speed, ≥ 56 ticks of travel after the 9-tick ramp,
// so the worst case is about 2/56 ≈ 3.6 %. Jumps on flat ground are tick-exact, so heights match.
// The stamina pool never runs dry: exhaustion and the dodge cost are stamina rules (Property 12) whose
// cut-off tick would depend on how long the player sprinted.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { GameLoop, SIM_DT } from '../../src/core/loop';
import { distanceXZ } from '../../src/core/math';
import { DEFAULT_BINDINGS, type InputCode } from '../../src/input/bindings';
import { InputState, type RawInput } from '../../src/input/inputState';
import { createStaminaState } from '../../src/logic/stamina';
import { createCollisionWorld } from '../../src/physics/collisionWorld';
import { flatHeightfield } from '../../src/physics/heightfield';
import { stepController } from '../../src/player/core/stepController';
import { createControllerState, type ControllerInput } from '../../src/player/core/types';

const RUNS = 200;
/** Req 1.9 tolerance, relative to the reference, plus 1 mm so a zero reference compares equal. */
const TOLERANCE = 0.05;
const FLOOR = 1e-3;

const MIN_FRAME = 1 / 144;
const MAX_FRAME = 1 / 30;
/** Seconds between beats; taps (walk toggle, jump, dodge) are released within TAP_MAX. */
const GAP_MIN = 1;
const GAP_MAX = 1.6;
/** Shorter than a 144 fps frame, so a press and its release can land in the same tick. */
const TAP_MIN = 0.004;
const TAP_MAX = 0.3;
/** Run time after the last beat, for its response to finish. */
const SETTLE = 1.2;
/** Far more than a timeline can spend (≤ 9 s of sprint at 18/s plus 20 per dodge). */
const STAMINA_POOL = 1000;

type BeatKind = 'move' | 'strafe' | 'sprint' | 'walk' | 'jump' | 'dodge';

/** move, strafe and sprint toggle a held key; walk, jump and dodge tap theirs. */
const CODES: Readonly<Record<BeatKind, InputCode>> = {
  move: DEFAULT_BINDINGS.moveForward,
  strafe: DEFAULT_BINDINGS.moveRight,
  sprint: DEFAULT_BINDINGS.sprint,
  walk: DEFAULT_BINDINGS.walkToggle,
  jump: DEFAULT_BINDINGS.jump,
  dodge: DEFAULT_BINDINGS.dodge,
};
const HOLDS: ReadonlySet<BeatKind> = new Set<BeatKind>(['move', 'strafe', 'sprint']);

interface Beat {
  kind: BeatKind;
  /** Seconds after the previous beat. */
  gap: number;
  /** Tap length (s); unused by holds. */
  tap: number;
}

/** Forward is pressed at `lead`, then come `beats`, then every held key is released after `stopGap`. */
interface Script {
  lead: number;
  beats: Beat[];
  stopGap: number;
}

interface Timeline {
  /** In time order. */
  events: { at: number; input: RawInput }[];
  end: number;
  jumpPresses: number;
}

function buildTimeline({ lead, beats, stopGap }: Script): Timeline {
  const events: Timeline['events'] = [];
  const held = new Set<InputCode>();
  const push = (at: number, kind: 'down' | 'up', code: InputCode): void => {
    events.push({ at, input: { kind, code, time: at * 1000 } });
  };
  let t = lead;
  push(t, 'down', CODES.move);
  held.add(CODES.move);
  let jumpPresses = 0;
  for (const beat of beats) {
    t += beat.gap;
    const code = CODES[beat.kind];
    if (HOLDS.has(beat.kind)) {
      if (held.delete(code)) push(t, 'up', code);
      else {
        held.add(code);
        push(t, 'down', code);
      }
    } else {
      push(t, 'down', code);
      push(t + beat.tap, 'up', code); // TAP_MAX < GAP_MIN keeps the list in time order
      if (beat.kind === 'jump') jumpPresses++;
    }
  }
  t += stopGap;
  for (const code of held) push(t, 'up', code);
  return { events, end: t + SETTLE, jumpPresses };
}

const arbGap = fc.double({ min: GAP_MIN, max: GAP_MAX, noNaN: true });
const arbBeat = (kind: fc.Arbitrary<BeatKind>): fc.Arbitrary<Beat> =>
  fc.record({ kind, gap: arbGap, tap: fc.double({ min: TAP_MIN, max: TAP_MAX, noNaN: true }) });

/** Common input timeline: forward, then 1–4 beats with at least one jump, then release. */
const arbScript: fc.Arbitrary<Script> = fc
  .record({
    lead: fc.double({ min: 0, max: 0.5, noNaN: true }),
    beats: fc.array(arbBeat(fc.constantFrom<BeatKind>('move', 'strafe', 'sprint', 'walk', 'jump', 'dodge')), {
      maxLength: 3,
    }),
    jump: arbBeat(fc.constant<BeatKind>('jump')),
    jumpSlot: fc.nat(3),
    stopGap: arbGap,
  })
  .map(({ lead, beats, jump, jumpSlot, stopGap }) => {
    const all = [...beats];
    all.splice(Math.min(jumpSlot, all.length), 0, jump);
    return { lead, beats: all, stopGap };
  });

const arbFrameTime = fc.double({ min: MIN_FRAME, max: MAX_FRAME, noNaN: true });

/** arbFrameTimes: frame-time patterns within [1/144, 1/30] s, replayed in a cycle until the timeline ends. */
const arbFrameTimes: fc.Arbitrary<number[]> = fc.oneof(
  // Steady rates, both ends of the range included.
  fc.constantFrom(MIN_FRAME, 1 / 120, 1 / 100, 1 / 90, 1 / 75, 1 / 50, 1 / 40, MAX_FRAME).map((ft) => [ft]),
  // Jitter.
  fc.array(arbFrameTime, { minLength: 1, maxLength: 240 }),
  // Stutter: short frames broken by long ones, which give the largest sampling offsets.
  fc.array(fc.oneof(fc.constantFrom(MIN_FRAME, MAX_FRAME), arbFrameTime), { minLength: 2, maxLength: 240 }),
);

interface Outcome {
  /** Horizontal path length (m). */
  distance: number;
  /** Apex above take-off of each jump, in order (m). */
  jumps: number[];
}

/**
 * Stand-in for the task 2.8 adapter with the camera fixed at yaw 0: moveVector y (forward) → +Z and
 * x → +X. Which way the camera's right points does not change any distance.
 */
function controllerInput(input: InputState): ControllerInput {
  const move = input.moveVector();
  return {
    move: { x: move.x, z: move.y },
    sprint: input.down('sprint'),
    walk: input.walkToggled,
    jump: input.isBuffered('jump'),
    dodge: input.isBuffered('dodge'),
    release: input.pressed('release'),
  };
}

/** Plays `timeline` through the loop with render frames of `frameTimes` (cycled) until its end. */
function simulate(timeline: Timeline, frameTimes: readonly number[]): Outcome {
  const world = createCollisionWorld(flatHeightfield(0));
  const input = new InputState();
  const queue: RawInput[] = [];
  let state = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  let stamina = createStaminaState(STAMINA_POOL);
  const outcome: Outcome = { distance: 0, jumps: [] };
  let jump: { takeoff: number; apex: number } | null = null;
  const errors: unknown[] = [];

  const loop = new GameLoop({
    step: ({ dt }) => {
      input.beginTick(queue.splice(0), dt);
      const r = stepController(state, controllerInput(input), world, stamina, 'kairen', dt);
      if (r.consumed.jump) input.consumeBuffered('jump');
      if (r.consumed.dodge) input.consumeBuffered('dodge');
      outcome.distance += distanceXZ(state.pos, r.state.pos);
      for (const e of r.events) {
        if (e.type === 'landed' && jump !== null) {
          outcome.jumps.push(jump.apex - jump.takeoff);
          jump = null;
        }
        if (e.type === 'jumped') jump = { takeoff: state.pos.y, apex: r.state.pos.y };
      }
      if (jump !== null) jump.apex = Math.max(jump.apex, r.state.pos.y);
      state = r.state;
      stamina = r.stamina;
    },
    render: () => undefined,
    onError: (error) => void errors.push(error), // the loop isolates step errors; surface them here
  });

  const { events } = timeline;
  let next = 0;
  const queueUntil = (time: number): void => {
    while (next < events.length && events[next].at <= time) queue.push(events[next++].input);
  };
  let now = 0;
  queueUntil(now);
  loop.frame(0); // starts the loop clock: realDt 0, no step
  for (let i = 0; now < timeline.end; i++) {
    now += frameTimes[i % frameTimes.length];
    queueUntil(now);
    loop.frame(now * 1000);
  }
  if (errors.length > 0) throw errors[0];
  return outcome;
}

const tolerance = (reference: number): number => TOLERANCE * Math.abs(reference) + FLOOR;

describe('Property 13: fixed-step frame-rate independence', () => {
  it('replays one input timeline at 30–144 fps within 5 % of the 60 Hz distance and jump heights', () => {
    let shiftedRuns = 0;
    fc.assert(
      fc.property(arbScript, arbFrameTimes, (script, frameTimes) => {
        const timeline = buildTimeline(script);
        const reference = simulate(timeline, [SIM_DT]);
        const actual = simulate(timeline, frameTimes);
        // The reference moves and turns every jump press into exactly one jump.
        expect(reference.distance).toBeGreaterThan(1);
        expect(reference.jumps).toHaveLength(timeline.jumpPresses);

        expect(Math.abs(actual.distance - reference.distance)).toBeLessThanOrEqual(tolerance(reference.distance));
        expect(actual.jumps).toHaveLength(reference.jumps.length);
        actual.jumps.forEach((height, i) => {
          expect(Math.abs(height - reference.jumps[i])).toBeLessThanOrEqual(tolerance(reference.jumps[i]));
        });
        if (Math.abs(actual.distance - reference.distance) > 1e-6) shiftedRuns++;
      }),
      { numRuns: RUNS },
    );
    // Guard against a vacuous pass: the schedules must often read inputs on other ticks than the
    // reference (a bit over half the runs; steady high rates often read the same ticks).
    expect(shiftedRuns).toBeGreaterThan(RUNS / 4);
  }, 30_000);
});
