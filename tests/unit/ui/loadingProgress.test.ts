import { describe, expect, it } from 'vitest';
import {
  LOADING_SLICE_MS, LOADING_STAGES, once, overallFraction, runLoading, type LoadingReport, type LoadingWork,
} from '../../../src/ui/loadingProgress';

// Task 14.2 (design "부팅과 Loading", Req 1.10): stages terrain → vegetation → characters in ~30 ms slices with a
// repaint between slices.

describe('Loading stages', () => {
  it('has the three stages with weights adding up to 1 and Korean text', () => {
    expect(LOADING_STAGES.map((s) => s.id)).toEqual(['terrain', 'vegetation', 'characters']);
    expect(LOADING_STAGES.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(1, 9);
    for (const s of LOADING_STAGES) expect(s.label).toMatch(/[가-힣]/);
    expect(overallFraction(LOADING_STAGES, 'terrain', 0)).toBe(0);
    expect(overallFraction(LOADING_STAGES, 'characters', 1)).toBeCloseTo(1, 9);
    expect(overallFraction(LOADING_STAGES, 'vegetation', 0)).toBeCloseTo(LOADING_STAGES[0].weight, 9);
  });

  it('runs work in ~30 ms slices, yielding a frame between them, with rising progress ending at 1', async () => {
    let clock = 0;
    let frames = 0;
    const reports: LoadingReport[] = [];
    // Each unit of work takes 10 ms: three units per 30 ms slice.
    function* steps(n: number): LoadingWork {
      for (let i = 0; i < n; i++) {
        clock += 10;
        yield (i + 1) / n;
      }
    }
    const ran: string[] = [];
    await runLoading(
      [
        { stage: 'terrain', work: () => steps(9) },
        { stage: 'vegetation', work: () => once(() => ran.push('vegetation')) },
        { stage: 'characters', work: () => steps(3) },
      ],
      { now: () => clock, yieldFrame: async () => void frames++, onProgress: (r) => reports.push(r) },
    );
    expect(LOADING_SLICE_MS).toBe(30);
    expect(ran).toEqual(['vegetation']);
    // terrain: 3 slices + stage end; vegetation: stage end; characters: 1 slice + stage end.
    expect(frames).toBe(3 + 1 + 1 + 1 + 1);
    const fractions = reports.map((r) => r.fraction);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] - 1e-12);
    expect(fractions[fractions.length - 1]).toBeCloseTo(1, 9);
    expect(reports.find((r) => r.stage === 'characters')?.label).toBe(LOADING_STAGES[2].label);
  });

  it('does not start a stage before the earlier ones are done', async () => {
    const order: string[] = [];
    await runLoading(
      [
        { stage: 'terrain', work: () => (order.push('terrain'), once(() => order.push('terrain done'))) },
        { stage: 'characters', work: () => (order.push('characters'), once(() => order.push('characters done'))) },
      ],
      { now: () => 0, yieldFrame: async () => undefined, onProgress: () => undefined },
    );
    expect(order).toEqual(['terrain', 'terrain done', 'characters', 'characters done']);
  });
});
