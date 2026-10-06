import { describe, expect, it, vi } from 'vitest';
import { GameLoop, MAX_REAL_DT, MAX_STEPS_PER_FRAME, SIM_DT } from '../../../src/core/loop';
import type { GameLoopOptions, TickContext } from '../../../src/core/loop';

/** GameLoop on a manual clock, already past its realDt-0 first frame. `run` returns steps per frame. */
function makeLoop(overrides: Partial<GameLoopOptions> = {}) {
  let clock = 0;
  const ticks: TickContext[] = [];
  const renders: { alpha: number; realDt: number }[] = [];
  const loop = new GameLoop({
    step: (ctx) => void ticks.push(ctx),
    render: (alpha, realDt) => void renders.push({ alpha, realDt }),
    now: () => clock,
    ...overrides,
  });
  loop.frame(clock);
  const wait = (ms: number): number => (clock += ms);
  const advance = (ms: number): number => {
    const before = loop.tickCount;
    loop.frame(wait(ms));
    return loop.tickCount - before;
  };
  const run = (seconds: number, fps: number): number[] =>
    Array.from({ length: Math.round(seconds * fps) }, () => advance(1000 / fps));
  return { loop, ticks, renders, wait, advance, run };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('GameLoop', () => {
  it('runs 120±1 steps over 2 s at 60 fps with consistent tick contexts', () => {
    const { loop, ticks, run } = makeLoop();
    expect(Math.abs(sum(run(2, 60)) - 120)).toBeLessThanOrEqual(1);
    expect(ticks).toHaveLength(loop.tickCount);
    ticks.forEach((ctx, i) => {
      expect(ctx).toEqual({ dt: SIM_DT, simTime: expect.closeTo(i * SIM_DT, 9), tick: i, pauseMode: 'none' });
    });
    expect(loop.playTimeSec).toBeCloseTo(2, 9);
  });

  it('runs 2 steps per frame at 30 fps', () => expect(makeLoop().run(1, 30)).toEqual(new Array<number>(30).fill(2)));

  it('clamps a 1 s gap to MAX_REAL_DT, caps it at MAX_STEPS_PER_FRAME and keeps alpha < 1', () => {
    const { loop, renders, advance } = makeLoop();
    expect(advance(1000)).toBe(MAX_STEPS_PER_FRAME);
    expect(renders.at(-1)).toEqual({ alpha: loop.alpha, realDt: MAX_REAL_DT });
    expect(loop.alpha).toBeLessThan(1);
  });

  it('hitStop 0 freezes steps for 0.08 s of real time while render keeps running', () => {
    const { loop, renders, run } = makeLoop();
    loop.setTimeScale('hitStop', 0, 0.08);
    const rendered = renders.length;
    expect(run(4 / 60, 60)).toEqual([0, 0, 0, 0]); // 0.067 s in: still frozen
    expect(renders).toHaveLength(rendered + 4);
    expect(run(6 / 60, 60)).toEqual([1, 1, 1, 1, 1, 1]); // lapsed at 0.08 s: full speed again
  });

  it('applies the lowest active time scale and expires each request in real time', () => {
    const { loop, run } = makeLoop();
    loop.setTimeScale('perfectDodge', 0.3, 0.5);
    loop.setTimeScale('hitStop', 0, 0.1);
    expect(loop.timeScale).toBe(0);
    expect(sum(run(8 / 60, 60))).toBe(0); // 0.133 s: hitStop lapsed, 0.3× hasn't filled a step yet
    expect(loop.timeScale).toBe(0.3);
    expect([5, 6]).toContain(sum(run(18 / 60, 60))); // 18 frames at 0.3 ≈ 5.4 steps
    run(12 / 60, 60); // 0.633 s: perfectDodge lapsed
    expect(loop.timeScale).toBe(1);
  });

  it("'menu' runs no steps and freezes play time", () => {
    const { loop, run } = makeLoop();
    run(0.5, 60);
    const playTime = loop.playTimeSec;
    loop.pauseMode = 'menu';
    expect(sum(run(1, 60))).toBe(0);
    expect(loop.playTimeSec).toBe(playTime);
    loop.pauseMode = 'none';
    expect(sum(run(0.5, 60))).toBe(30);
  });

  it("a step that switches to 'menu' (a screen opened during EventDispatch) ends the frame's steps", () => {
    let loop: GameLoop | null = null;
    const { loop: created, advance } = makeLoop({
      step: (ctx) => {
        if (ctx.tick === 1 && loop !== null) loop.pauseMode = 'menu';
      },
    });
    loop = created;
    expect(advance((4 / 60) * 1000)).toBe(2); // 4 steps due, stopped after the second
    expect(advance(1000 / 60)).toBe(0);
    loop.pauseMode = 'none';
    // The skipped steps are dropped (at most one step of backlog remains), not replayed.
    const resumed = Array.from({ length: 30 }, () => advance(1000 / 60));
    expect(Math.abs(sum(resumed) - 30)).toBeLessThanOrEqual(1);
  });

  it.each(['cinematic', 'dialogue'] as const)("'%s' keeps stepping and counting play time", (mode) => {
    const { loop, ticks, run } = makeLoop();
    loop.pauseMode = mode;
    expect(sum(run(1, 60))).toBe(60);
    expect(ticks.every((ctx) => ctx.pauseMode === mode)).toBe(true);
    expect(loop.playTimeSec).toBeCloseTo(1, 9);
  });

  it('reports a throwing step or render to onError and keeps looping', () => {
    const [stepError, renderError] = [new Error('step'), new Error('render')];
    const onError = vi.fn();
    const step = vi.fn().mockImplementationOnce(() => { throw stepError; });
    const { run } = makeLoop({ step, render: () => { throw renderError; }, onError });
    expect(run(1 / 60, 60)).toEqual([1]);
    expect(onError).toHaveBeenCalledWith(stepError, 'step');
    expect(onError).toHaveBeenCalledWith(renderError, 'render');
    expect(run(1 / 60, 60)).toEqual([1]);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('integrates x += 6·dt to within 5% across 30, 60 and 144 fps', () => {
    const results = [30, 60, 144].map((fps) => {
      let x = 0;
      makeLoop({ step: (ctx) => { x += 6 * ctx.dt; } }).run(2, fps);
      return x;
    });
    expect(results[1]).toBeCloseTo(12, 0);
    expect(Math.max(...results) / Math.min(...results)).toBeLessThan(1.05);
  });

  it('start() is idempotent, frames read now(), stop() cancels and silences stale callbacks', () => {
    const queue: ((timeMs: number) => void)[] = [];
    const cancelFrame = vi.fn();
    const { loop, wait } = makeLoop({ requestFrame: (cb) => queue.push(cb), cancelFrame });
    loop.start();
    loop.start();
    expect([loop.running, queue.length]).toEqual([true, 1]);
    for (let i = 0; i < 10; i++) {
      wait(1000 / 60);
      queue.shift()?.(-1); // bogus rAF timestamp: frames must use now()
    }
    expect(loop.tickCount).toBe(9); // the first frame after start() has realDt 0
    loop.stop();
    expect([loop.running, cancelFrame.mock.calls.length]).toEqual([false, 1]);
    queue.shift()?.(-1);
    expect(loop.tickCount).toBe(9);
  });
});
