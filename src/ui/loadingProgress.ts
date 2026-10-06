/*
 * Loading progress (design "부팅과 Loading", task 14.2; Req 1.10): the boot work runs as stages (`terrain`,
 * `vegetation`, `characters`), each a generator that does one unit of work per `next()` and may yield its own
 * progress (0–1). `runLoading` runs units until a ~30 ms slice is spent, reports the overall progress, and yields a
 * frame (requestAnimationFrame in the page) so the bar and its text repaint before the next slice. A stage that is a
 * single call is one unit. The clock and the frame yield are injected, so the slicing is unit-tested without a DOM.
 */

export type LoadingStageId = 'terrain' | 'vegetation' | 'characters';

export interface LoadingStageDef {
  readonly id: LoadingStageId;
  /** Text under the bar while the stage runs. */
  readonly label: string;
  /** Share of the whole bar (the weights add up to 1). */
  readonly weight: number;
}

export const LOADING_STAGES: readonly LoadingStageDef[] = [
  { id: 'terrain', label: '지형을 만드는 중…', weight: 0.45 },
  { id: 'vegetation', label: '풀과 나무를 심는 중…', weight: 0.25 },
  { id: 'characters', label: '동료들을 부르는 중…', weight: 0.3 },
];

/** Work between two repaints (ms). */
export const LOADING_SLICE_MS = 30;

/** One unit of work per `next()`; a yielded number is the stage's own progress (0–1). */
export type LoadingWork = Iterator<number | void, void, void>;

export interface LoadingTask {
  readonly stage: LoadingStageId;
  /** Starts the stage's work (called when the stage begins, not before). */
  readonly work: () => LoadingWork;
}

export interface LoadingReport {
  readonly stage: LoadingStageId;
  readonly label: string;
  /** Overall progress 0–1. */
  readonly fraction: number;
}

export interface LoadingRunOptions {
  /** Milliseconds (performance.now in the page). */
  now(): number;
  /** Resolves after the next paint. */
  yieldFrame(): Promise<void>;
  onProgress(report: LoadingReport): void;
  sliceMs?: number;
  stages?: readonly LoadingStageDef[];
}

/** A single call as a one-unit stage. */
export function* once(fn: () => void): LoadingWork {
  fn();
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Overall progress with `stage` at `local` (0–1) and every earlier stage done. */
export function overallFraction(stages: readonly LoadingStageDef[], stage: LoadingStageId, local: number): number {
  let done = 0;
  for (const s of stages) {
    if (s.id === stage) return clamp01(done + s.weight * clamp01(local));
    done += s.weight;
  }
  return clamp01(done);
}

/**
 * Runs `tasks` in order in slices of `sliceMs`, reporting progress after each slice and at each stage's end, and
 * yielding a frame between slices. Resolves once every stage is done (the last report is 1).
 */
export async function runLoading(tasks: readonly LoadingTask[], options: LoadingRunOptions): Promise<void> {
  const stages = options.stages ?? LOADING_STAGES;
  const slice = options.sliceMs ?? LOADING_SLICE_MS;
  const label = (id: LoadingStageId): string => stages.find((s) => s.id === id)?.label ?? '';
  let sliceStart = options.now();
  for (const task of tasks) {
    let local = 0;
    options.onProgress({ stage: task.stage, label: label(task.stage), fraction: overallFraction(stages, task.stage, 0) });
    const work = task.work();
    for (;;) {
      const step = work.next();
      if (step.done === true) break;
      if (typeof step.value === 'number') local = clamp01(step.value);
      if (options.now() - sliceStart >= slice) {
        options.onProgress({ stage: task.stage, label: label(task.stage), fraction: overallFraction(stages, task.stage, local) });
        await options.yieldFrame();
        sliceStart = options.now();
      }
    }
    options.onProgress({ stage: task.stage, label: label(task.stage), fraction: overallFraction(stages, task.stage, 1) });
    await options.yieldFrame();
    sliceStart = options.now();
  }
}
