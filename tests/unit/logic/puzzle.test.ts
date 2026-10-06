import { describe, expect, it } from 'vitest';
import type { ElementId } from '../../../src/data/ids';
import { PART_SIZE, type PuzzleDef, type PuzzlePartDevice } from '../../../src/data/puzzles';
import {
  hintDue, initialPuzzleRuntime, platesHeld, puzzleOpen, puzzleProgress, sequenceTimeLeft, stepPuzzle,
  type PuzzleRuntime, type PuzzleRulesDef, type PuzzleSignal,
} from '../../../src/logic/puzzle';

// Puzzle_Mechanism rules (design "Puzzle_Mechanism 규칙"; Req 13.3–13.7, 2.6).

const part = (id: string, device: PuzzlePartDevice) => ({ id, device, name: id, pos: { x: 0, z: 0 }, ...PART_SIZE[device] });
const def = (kind: PuzzleDef['kind'], parts: [string, PuzzlePartDevice][], extra: Partial<PuzzleRulesDef> = {}): PuzzleRulesDef => ({
  kind, parts: parts.map(([id, device]) => part(id, device)), ...extra,
});
const el = (p: string, element: ElementId | null, accepted = true): PuzzleSignal => ({ kind: 'element', part: p, element, accepted });
const TICK: PuzzleSignal = { kind: 'tick' };

/** Runs signals from the initial runtime, returning each outcome and the final runtime. */
function run(d: PuzzleRulesDef, steps: [PuzzleSignal, number][], from: PuzzleRuntime = initialPuzzleRuntime()) {
  let rt = from;
  const outcomes: string[] = [];
  for (const [sig, now] of steps) {
    const r = stepPuzzle(d, rt, sig, now);
    rt = r.rt;
    outcomes.push(r.cause === undefined ? r.outcome : `${r.outcome}:${r.cause}`);
  }
  return { rt, outcomes };
}

const SEQ = def('sequence', [['a', 'windWheel'], ['b', 'windWheel'], ['c', 'windWheel'], ['decoy', 'windWheel']], {
  order: ['gale', 'tide', 'ember'],
  timeLimitSec: 15,
});

describe('stepPuzzle kinds', () => {
  it('single: the one part taking its Element solves it at once', () => {
    const d = def('single', [['wheel', 'windWheel']]);
    const { rt, outcomes } = run(d, [[el('other', 'gale'), 0], [el('wheel', 'gale'), 1]]);
    expect(outcomes).toEqual(['none', 'solved']);
    expect(rt).toEqual({ step: 1, active: ['wheel'], startedAt: null, failures: 0, solved: true });
  });

  it('allOf: every part once, in any order; a lit part lit again changes nothing', () => {
    const d = def('allOf', [['a', 'brazier'], ['b', 'brazier'], ['c', 'brazier']]);
    const { rt, outcomes } = run(d, [[el('c', 'ember'), 0], [el('c', 'ember'), 1], [el('a', 'ember'), 2], [el('b', 'ember'), 30]]);
    expect(outcomes).toEqual(['progress', 'none', 'progress', 'solved']);
    expect([rt.solved, rt.active, puzzleProgress(d, rt)]).toEqual([true, ['c', 'a', 'b'], 3]);
  });

  it('allOf counts arrival triggers as parts ("reached")', () => {
    const d = def('allOf', [['wall', 'heatCrystal'], ['ledge', 'arrival']]);
    expect(run(d, [[el('wall', 'tide'), 0], [{ kind: 'reached', part: 'ledge' }, 7]]).outcomes).toEqual(['progress', 'solved']);
  });

  it('sequence: part i must take order[i]; the timer starts at the first right input', () => {
    const { rt, outcomes } = run(SEQ, [[el('a', 'gale'), 2], [el('a', 'gale'), 3], [el('b', 'tide'), 5], [el('c', 'ember'), 9]]);
    expect(outcomes).toEqual(['progress', 'none', 'progress', 'solved']);
    expect([rt.solved, rt.step, rt.startedAt]).toEqual([true, 3, 2]);
  });

  it('weight with plates only: open while every plate is held, solved the moment they all are', () => {
    const d = def('weight', [['p1', 'pressurePlate'], ['p2', 'pressurePlate']]);
    let r = stepPuzzle(d, initialPuzzleRuntime(), { kind: 'pressed', part: 'p1' }, 0);
    expect([r.outcome, platesHeld(d, r.rt), puzzleOpen(d, r.rt)]).toEqual(['progress', false, false]);
    r = stepPuzzle(d, r.rt, { kind: 'released', part: 'p1' }, 1);
    expect([r.outcome, r.rt.active]).toEqual(['none', []]);
    const { rt, outcomes } = run(d, [[{ kind: 'pressed', part: 'p1' }, 2], [{ kind: 'pressed', part: 'p2' }, 3], [{ kind: 'released', part: 'p1' }, 4]]);
    expect(outcomes).toEqual(['progress', 'solved', 'none']);
    expect([rt.solved, puzzleOpen(d, rt)]).toEqual([true, true]); // stays open once solved
  });

  it('weight with another part: the target opens only while the plate is held, and the other part solves it for good', () => {
    const d = def('weight', [['plate', 'pressurePlate'], ['boulder', 'crackedBoulder']]);
    const held = run(d, [[{ kind: 'pressed', part: 'plate' }, 0]]);
    expect([held.outcomes, puzzleOpen(d, held.rt), held.rt.solved]).toEqual([['progress'], true, false]);
    const released = run(d, [[{ kind: 'released', part: 'plate' }, 1]], held.rt);
    expect(puzzleOpen(d, released.rt)).toBe(false);
    const done = run(d, [[{ kind: 'pressed', part: 'plate' }, 2], [el('boulder', null), 3], [{ kind: 'released', part: 'plate' }, 4]]);
    expect(done.outcomes).toEqual(['progress', 'solved', 'none']);
    expect([done.rt.solved, puzzleOpen(d, done.rt)]).toEqual([true, true]);
  });
});

describe('stepPuzzle failures', () => {
  it('a sequence out of turn or with the wrong Element fails and is back at its initial steps at once (within 2 s)', () => {
    const outOfTurn = run(SEQ, [[el('a', 'gale'), 0], [el('c', 'ember'), 1]]);
    expect(outOfTurn.outcomes).toEqual(['progress', 'fail:order']);
    expect(outOfTurn.rt).toEqual({ ...initialPuzzleRuntime(), failures: 1 });
    const wrongElement = run(SEQ, [[el('a', 'gale'), 0], [el('b', 'ember'), 1]]);
    expect(wrongElement.outcomes).toEqual(['progress', 'fail:order']);
    const decoy = run(SEQ, [[el('decoy', 'gale'), 0]]);
    expect([decoy.outcomes, decoy.rt.step]).toEqual([['fail:order'], 0]);
  });

  it('a sequence past its time limit fails on the tick, or on a late input, and resets', () => {
    const started = run(SEQ, [[el('a', 'gale'), 10], [el('b', 'tide'), 14]]).rt;
    expect(sequenceTimeLeft(SEQ, started, 20)).toBe(5);
    expect(run(SEQ, [[TICK, 25]], started).outcomes).toEqual(['none']); // exactly 15 s is still inside
    const timeout = run(SEQ, [[TICK, 25.01]], started);
    expect(timeout.outcomes).toEqual(['fail:timeout']);
    expect(timeout.rt).toEqual({ ...initialPuzzleRuntime(), failures: 1 });
    expect(run(SEQ, [[el('c', 'ember'), 26]], started).outcomes).toEqual(['fail:timeout']);
    // No timer runs before the first right input.
    expect(run(SEQ, [[TICK, 1000]]).outcomes).toEqual(['none']);
  });

  it('the time limit is never below steps × 5 s', () => {
    const short = { ...SEQ, timeLimitSec: 4 };
    const started = run(short, [[el('a', 'gale'), 0]]).rt;
    expect(run(short, [[TICK, 15]], started).outcomes).toEqual(['none']);
    expect(run(short, [[TICK, 15.5]], started).outcomes).toEqual(['fail:timeout']);
  });

  it('an Element a part does not take counts as a failure without undoing progress; the 3rd failure brings the hint', () => {
    const d = def('allOf', [['a', 'brazier'], ['b', 'brazier']]);
    const { rt, outcomes } = run(d, [[el('a', 'ember'), 0], [el('b', 'tide', false), 1], [el('b', 'gale', false), 2]]);
    expect(outcomes).toEqual(['progress', 'fail:rejected', 'fail:rejected']);
    expect([rt.active, rt.failures, hintDue(rt)]).toEqual([['a'], 2, false]);
    // A sequence failure is the 3rd: mixed causes add up.
    const seq = run(SEQ, [[el('a', 'tide', false), 0], [el('b', 'tide'), 1], [el('a', 'gale'), 2]]);
    expect(seq.outcomes).toEqual(['fail:rejected', 'fail:order', 'progress']);
    expect(seq.rt.failures).toBe(2);
    const third = run(d, [[el('b', 'terra', false), 3]], rt);
    expect([third.rt.failures, hintDue(third.rt)]).toEqual([3, true]);
    expect(hintDue({ ...third.rt, solved: true })).toBe(false);
  });

  it('can be retried after any number of failures and solved', () => {
    let steps: [PuzzleSignal, number][] = [];
    for (let i = 0; i < 5; i++) steps.push([el('a', 'gale'), i * 20], [el('c', 'ember'), i * 20 + 1]);
    steps = [...steps, [el('a', 'gale'), 200], [el('b', 'tide'), 201], [el('c', 'ember'), 202]];
    const { rt, outcomes } = run(SEQ, steps);
    expect(outcomes.filter((o) => o === 'fail:order')).toHaveLength(5);
    expect(outcomes.at(-1)).toBe('solved');
    expect([rt.solved, rt.failures]).toEqual([true, 5]);
  });

  it('a solved puzzle takes no more input', () => {
    const d = def('weight', [['p', 'pressurePlate'], ['x', 'arrival']]);
    const solved = run(d, [[{ kind: 'reached', part: 'x' }, 0]]).rt;
    expect(solved.solved).toBe(true);
    for (const sig of [el('p', 'terra', false), { kind: 'released', part: 'p' } as const, { kind: 'pressed', part: 'p' } as const, TICK]) {
      const r = stepPuzzle(d, solved, sig, 50);
      expect([r.outcome, r.rt]).toEqual(['none', solved]);
    }
  });

  it('never changes its inputs', () => {
    const rt = Object.freeze({ ...initialPuzzleRuntime(), active: Object.freeze(['a']) as readonly string[], step: 1, startedAt: 0 });
    expect(() => stepPuzzle(SEQ, rt, el('c', 'ember'), 1)).not.toThrow();
    expect(() => stepPuzzle(SEQ, rt, el('b', 'tide'), 1)).not.toThrow();
    expect(rt).toEqual({ step: 1, active: ['a'], startedAt: 0, failures: 0, solved: false });
  });
});
