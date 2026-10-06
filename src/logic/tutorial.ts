/*
 * Tutorial_Hint queue and timer (design "Tutorial_System", Req 34.3–34.5). Pure: the simulation adapter
 * (src/tutorial/tutorialSystem.ts) feeds triggers, the tick's `done` judgement and the suppression flag, and records
 * the returned completion in GameState.tutorials in the same tick.
 *
 * - A triggered hint that is not completed waits in `pending`; triggers of completed, waiting or current hints do
 *   nothing, so a completed hint is never queued again (Req 34.5).
 * - When nothing is current and the short gap after the last hint has passed, the waiting hint earliest in display
 *   order becomes current: one hint at a time (Req 34.3). A hint triggered later that comes earlier in display order
 *   takes over once the current one has been readable for 1.5 s; the displaced hint waits and later shows for the rest
 *   of its 8 s (so the card always converges on the earliest triggered hint).
 * - The current hint closes when its `doneWhen` is met or after 8 s on screen, and is reported as completed in that
 *   tick (Req 34.4). The next hint follows after HINT_GAP_SECONDS.
 * - While suppressed (cinematic, menu, dialogue) nothing shows and the 8 s timer and the gap stand still; triggers
 *   met meanwhile wait. A `done` reported while suppressed (an event such as the map screen opening) still closes it.
 */

import type { TutorialHintDef } from '../data/tutorials';
import { TUTORIAL_HINTS } from '../data/tutorials';
import type { DeepReadonly, GameState } from './save/gameState';

/** How long a hint stays on screen without its action (s, Req 34.4). */
export const HINT_SHOW_SECONDS = 8;
/** Pause between one hint closing and the next showing (s), so a change of card is noticed. */
export const HINT_GAP_SECONDS = 0.5;
/** A waiting hint earlier in display order takes over only after the current one has shown this long (s). */
export const HINT_MIN_SHOW_SECONDS = 1.5;
/** Lines of the hint card (Req 34.3). */
export const HINT_MAX_LINES = 2;
/** A text up to this long stays on one line. */
export const HINT_LINE_CHARS = 20;

const TIME_EPSILON = 1e-9;

export interface TutorialQueue {
  /** Triggered hints waiting to show, in trigger order (the display order decides which shows first). */
  readonly pending: readonly string[];
  /** The hint on the card (hidden while suppressed), or null. */
  readonly current: string | null;
  /** Unsuppressed seconds `current` has been on screen. */
  readonly shownFor: number;
  /** Unsuppressed seconds left before the next hint may show. */
  readonly gap: number;
  /** Seconds already shown of waiting hints an earlier one took over from; they come back with the rest. */
  readonly shownBefore: Readonly<Record<string, number>>;
}

export function emptyTutorialQueue(): TutorialQueue {
  return { pending: [], current: null, shownFor: 0, gap: 0, shownBefore: {} };
}

/** Queues `id` unless it is completed, already waiting or current (Req 34.5). */
export function enqueueHint(q: TutorialQueue, id: string, completed: readonly string[]): TutorialQueue {
  if (q.current === id || q.pending.includes(id) || completed.includes(id)) return q;
  return { ...q, pending: [...q.pending, id] };
}

/** Whether `id` is completed, waiting or current: its trigger no longer matters. */
export function hintSettled(q: TutorialQueue, id: string, completed: readonly string[]): boolean {
  return q.current === id || q.pending.includes(id) || completed.includes(id);
}

export interface TutorialStepInput {
  /** Tick length (s). */
  readonly dt: number;
  /** A cinematic, menu or dialogue is up: nothing shows and the timers stand still. */
  readonly suppressed: boolean;
  /** The current hint's `doneWhen` was met this tick. */
  readonly done: boolean;
  /** GameState.tutorials. */
  readonly completed: readonly string[];
  /** Hint ids in display priority order. */
  readonly order: readonly string[];
}

export interface TutorialStepResult {
  readonly queue: TutorialQueue;
  /** The hint closed this tick (record it in GameState.tutorials now), or null. */
  readonly completed: string | null;
  /** The hint that became current this tick ('hint:shown'), or null. */
  readonly shown: string | null;
}

/**
 * One tick of the queue: closes the current hint on `done` or its 8 s; else lets a waiting hint earlier in display
 * order take over once the current one has been readable for HINT_MIN_SHOW_SECONDS (the current one waits with its
 * shown time kept); with nothing current, shows the waiting hint earliest in display order.
 */
export function stepTutorial(q: TutorialQueue, input: TutorialStepInput): TutorialStepResult {
  const { dt, suppressed, done, completed, order } = input;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const idle = { completed: null, shown: null } as const;
  if (q.current !== null) {
    const shownFor = suppressed ? q.shownFor : q.shownFor + step;
    if (done || shownFor >= HINT_SHOW_SECONDS - TIME_EPSILON) {
      return { queue: { ...q, current: null, shownFor: 0, gap: HINT_GAP_SECONDS }, completed: q.current, shown: null };
    }
    if (!suppressed && shownFor >= HINT_MIN_SHOW_SECONDS - TIME_EPSILON) {
      const pending = q.pending.filter((id) => !completed.includes(id));
      const next = firstInOrder([q.current, ...pending], order);
      if (next !== null && next !== q.current) {
        const shownBefore: Record<string, number> = { ...q.shownBefore, [q.current]: shownFor };
        const resume = shownBefore[next] ?? 0;
        delete shownBefore[next];
        return {
          queue: { pending: [...pending.filter((id) => id !== next), q.current], current: next, shownFor: resume, gap: 0, shownBefore },
          completed: null,
          shown: next,
        };
      }
    }
    return { queue: shownFor === q.shownFor ? q : { ...q, shownFor }, ...idle };
  }
  if (suppressed) return { queue: q, ...idle };
  const gap = Math.max(0, q.gap - step);
  const pending = q.pending.filter((id) => !completed.includes(id));
  const next = firstInOrder(pending, order);
  if (gap > TIME_EPSILON || next === null) {
    const queue = gap === q.gap && pending.length === q.pending.length ? q : { ...q, pending, gap };
    return { queue, ...idle };
  }
  const shownBefore: Record<string, number> = { ...q.shownBefore };
  const resume = shownBefore[next] ?? 0;
  delete shownBefore[next];
  return {
    queue: { pending: pending.filter((id) => id !== next), current: next, shownFor: resume, gap: 0, shownBefore },
    completed: null,
    shown: next,
  };
}

/** The id of `ids` that comes first in `order` (ids missing from `order` go last, in their own order). */
function firstInOrder(ids: readonly string[], order: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const id of ids) {
    const i = order.indexOf(id);
    const rank = i < 0 ? order.length : i;
    if (rank < bestRank) {
      best = id;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * The card's lines (at most HINT_MAX_LINES): one line up to HINT_LINE_CHARS characters, else two lines broken at
 * the space closest to the middle (a text without spaces is cut in the middle).
 */
export function hintLines(text: string): string[] {
  const t = text.trim();
  if (t.length <= HINT_LINE_CHARS) return [t];
  let best = -1;
  let bestLongest = Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== ' ') continue;
    const longest = Math.max(i, t.length - i - 1);
    if (longest < bestLongest) {
      best = i;
      bestLongest = longest;
    }
  }
  if (best < 0) {
    const half = Math.ceil(t.length / 2);
    return [t.slice(0, half), t.slice(half)];
  }
  return [t.slice(0, best), t.slice(best + 1)];
}

/**
 * Completed hints for Settings "조작 안내 보기" (Req 34.5), in display order. The save's canonical form sorts
 * GameState.tutorials, so the order of completion does not survive a save; the display order follows the first play
 * (the first-10-minute hints come in the order they are met). Unknown ids are skipped.
 */
export function completedHints(
  gs: DeepReadonly<Pick<GameState, 'tutorials'>>,
  defs: readonly TutorialHintDef[] = TUTORIAL_HINTS,
): TutorialHintDef[] {
  const done = new Set(gs.tutorials);
  return defs.filter((d) => done.has(d.id));
}
