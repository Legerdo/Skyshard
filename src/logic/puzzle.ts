/*
 * Puzzle_Mechanism rules (design "Puzzle_Mechanism 규칙"; Req 13.3–13.7, 2.6): the pure `stepPuzzle` judges one
 * PuzzleSignal against a PuzzleDef and returns the next runtime and the outcome. It never changes its inputs.
 *
 * - 'progress': a right input that does not finish the puzzle (the part glows / spins / opens and the progress
 *   sound plays in the same tick, Req 13.3).
 * - 'solved': the finishing input; from then on every signal is 'none' (the puzzle takes no more input).
 * - 'fail': a sequence part out of turn or with the wrong Element ('order'), a sequence past its time limit on a
 *   tick or a late input ('timeout') — both reset the steps at once, within the 2 s of Req 13.5 — or an Element a
 *   part does not take ('rejected', nothing to reset). Every failure counts; from the 3rd the hint shows (Req 13.7).
 *   Failing never locks the puzzle, so it can be tried again until solved (Req 2.6).
 *
 * Signals naming a part the puzzle does not have are 'none'. Pure: no three.js, DOM or Math.random.
 */

import type { ElementId } from '../data/ids';
import { PUZZLE_RULES, minTimeLimit, type PuzzleDef } from '../data/puzzles';

/** design `PuzzleSignal`: element `null` is a Charged_Attack break. */
export type PuzzleSignal =
  | { readonly kind: 'element'; readonly part: string; readonly element: ElementId | null; readonly accepted: boolean }
  | { readonly kind: 'pressed' | 'released' | 'reached'; readonly part: string }
  | { readonly kind: 'tick' };

/** design `PuzzleRuntime`. `active` lists part ids in activation order; `startedAt` is the sequence start. */
export interface PuzzleRuntime {
  readonly step: number;
  readonly active: readonly string[];
  readonly startedAt: number | null;
  readonly failures: number;
  readonly solved: boolean;
}

export type PuzzleOutcome = 'none' | 'progress' | 'fail' | 'solved';
export type PuzzleFailCause = 'order' | 'timeout' | 'rejected';

export interface PuzzleStepResult {
  readonly rt: PuzzleRuntime;
  readonly outcome: PuzzleOutcome;
  /** Set with outcome 'fail'. */
  readonly cause?: PuzzleFailCause;
}

/** What the rules read from a definition. */
export type PuzzleRulesDef = Pick<PuzzleDef, 'kind' | 'parts' | 'order' | 'timeLimitSec'>;

/** A puzzle nobody touched yet. */
export function initialPuzzleRuntime(): PuzzleRuntime {
  return { step: 0, active: [], startedAt: null, failures: 0, solved: false };
}

/** A solved puzzle as a load places it: every part active, every step done. */
export function solvedPuzzleRuntime(def: PuzzleRulesDef): PuzzleRuntime {
  return { step: puzzleTotal(def), active: def.parts.map((p) => p.id), startedAt: null, failures: 0, solved: true };
}

/** Steps to solve: 1 (single), the order length (sequence), else the part count. */
export function puzzleTotal(def: PuzzleRulesDef): number {
  switch (def.kind) {
    case 'single':
      return 1;
    case 'sequence':
      return def.order?.length ?? 0;
    case 'allOf':
    case 'weight':
      return def.parts.length;
  }
}

/** Steps done ('puzzle:progress' `step`). */
export function puzzleProgress(def: PuzzleRulesDef, rt: PuzzleRuntime): number {
  if (rt.solved) return puzzleTotal(def);
  return def.kind === 'sequence' ? rt.step : rt.active.length;
}

/** The sequence time limit: the definition's, never below steps × 5 s (Req 13.6). */
export function sequenceTimeLimit(def: PuzzleRulesDef): number {
  const floor = minTimeLimit(def.order?.length ?? 0);
  const given = def.timeLimitSec;
  return given !== undefined && Number.isFinite(given) && given > floor ? given : floor;
}

/** Seconds left of a running sequence (0 when over), or null when none is running. */
export function sequenceTimeLeft(def: PuzzleRulesDef, rt: PuzzleRuntime, now: number): number | null {
  if (def.kind !== 'sequence' || rt.solved || rt.startedAt === null) return null;
  return Math.max(0, sequenceTimeLimit(def) - (now - rt.startedAt));
}

/**
 * The step a repeating order display lights at `time` (s): step 0, 1, … each for `stepSeconds`, then `pauseSeconds` with
 * none (null), over and over (the Starfall Observatory's ceiling constellations showing pz_observatory_1's order).
 */
export function constellationStepAt(time: number, steps: number, timing: { readonly stepSeconds: number; readonly pauseSeconds: number }): number | null {
  if (!(steps > 0) || !Number.isFinite(time) || !(timing.stepSeconds > 0)) return null;
  const period = steps * timing.stepSeconds + Math.max(0, timing.pauseSeconds);
  const t = ((time % period) + period) % period;
  const step = Math.floor(t / timing.stepSeconds);
  return step < steps ? step : null;
}

/** The one-line hint is due: the 3rd failure or later on an unsolved puzzle (Req 13.7). */
export function hintDue(rt: PuzzleRuntime): boolean {
  return !rt.solved && rt.failures >= PUZZLE_RULES.hintAfterFailures;
}

/** weight: every plate is held down now. */
export function platesHeld(def: PuzzleRulesDef, rt: PuzzleRuntime): boolean {
  const plates = def.parts.filter((p) => p.device === 'pressurePlate');
  return plates.length > 0 && plates.every((p) => rt.active.includes(p.id));
}

/** The puzzle's `opens` target is open: solved, or a weight puzzle with every plate held. */
export function puzzleOpen(def: PuzzleRulesDef, rt: PuzzleRuntime): boolean {
  return rt.solved || (def.kind === 'weight' && platesHeld(def, rt));
}

const none = (rt: PuzzleRuntime): PuzzleStepResult => ({ rt, outcome: 'none' });

function solved(rt: PuzzleRuntime, def: PuzzleRulesDef, active: readonly string[]): PuzzleStepResult {
  return { rt: { ...rt, step: puzzleTotal(def), active, solved: true }, outcome: 'solved' };
}

/** A failure: counted; 'order' and 'timeout' also put the steps back to the start. */
function fail(rt: PuzzleRuntime, cause: PuzzleFailCause): PuzzleStepResult {
  const failures = rt.failures + 1;
  const next = cause === 'rejected' ? { ...rt, failures } : { ...initialPuzzleRuntime(), failures };
  return { rt: next, outcome: 'fail', cause };
}

/** allOf / single / weight: `part` becomes active (it stays so, except weight plates). */
function activate(def: PuzzleRulesDef, rt: PuzzleRuntime, part: string): PuzzleStepResult {
  if (def.kind === 'single') return solved(rt, def, [...rt.active, part]);
  if (rt.active.includes(part)) return none(rt);
  const active = [...rt.active, part];
  const next = { ...rt, active, step: active.length };
  if (def.kind === 'allOf') {
    return def.parts.every((p) => active.includes(p.id)) ? solved(rt, def, active) : { rt: next, outcome: 'progress' };
  }
  // weight: solved when every plate is held with no other parts, or when every other part is active.
  const others = def.parts.filter((p) => p.device !== 'pressurePlate');
  const done = others.length === 0 ? platesHeld(def, next) : others.every((p) => active.includes(p.id));
  return done ? solved(rt, def, active) : { rt: next, outcome: 'progress' };
}

/** sequence: part `part` took `element` (accepted). */
function sequenceStep(def: PuzzleRulesDef, rt: PuzzleRuntime, part: string, element: ElementId | null, now: number): PuzzleStepResult {
  if (rt.active.includes(part)) return none(rt); // a part already lit ignores more input
  const order = def.order ?? [];
  const i = rt.step;
  if (def.parts[i]?.id !== part || order[i] !== element) return fail(rt, 'order');
  const next: PuzzleRuntime = { ...rt, step: i + 1, active: [...rt.active, part], startedAt: rt.startedAt ?? now };
  return next.step >= order.length ? solved(next, def, next.active) : { rt: next, outcome: 'progress' };
}

function timedOut(def: PuzzleRulesDef, rt: PuzzleRuntime, now: number): boolean {
  return def.kind === 'sequence' && rt.startedAt !== null && now - rt.startedAt > sequenceTimeLimit(def);
}

/** design `stepPuzzle`: judges one signal at sim time `now` (s). */
export function stepPuzzle(def: PuzzleRulesDef, rt: PuzzleRuntime, sig: PuzzleSignal, now: number): PuzzleStepResult {
  if (rt.solved) return none(rt);
  if (sig.kind === 'tick') return timedOut(def, rt, now) ? fail(rt, 'timeout') : none(rt);
  const part = def.parts.find((p) => p.id === sig.part);
  if (part === undefined) return none(rt);
  if (timedOut(def, rt, now)) return fail(rt, 'timeout'); // a late input: the attempt already ran out
  switch (sig.kind) {
    case 'element':
      if (!sig.accepted) return fail(rt, 'rejected');
      if (def.kind === 'sequence') return sequenceStep(def, rt, part.id, sig.element, now);
      return activate(def, rt, part.id);
    case 'pressed':
    case 'reached':
      return def.kind === 'sequence' ? none(rt) : activate(def, rt, part.id);
    case 'released': {
      // Only a weight plate lets go; allOf keeps its activation.
      if (def.kind !== 'weight' || part.device !== 'pressurePlate' || !rt.active.includes(part.id)) return none(rt);
      const active = rt.active.filter((id) => id !== part.id);
      return none({ ...rt, active, step: active.length });
    }
  }
}
