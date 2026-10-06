import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { ELEMENT_IDS, type ElementId } from '../../../src/data/ids';
import { PHASE_THRESHOLDS, STARSHELL_ROTATE_SECONDS, bossPhaseFor, nextStarshellElement, phaseFloorHp } from '../../../src/logic/boss';
import { stepStarshell, type BossPhase, type StarshellClock } from '../../../src/logic/boss';

describe('bossPhaseFor', () => {
  it('enters Phase 2 at or below 0.65 and the Final Phase at or below 0.30', () => {
    expect(PHASE_THRESHOLDS).toEqual({ p2: 0.65, p3: 0.3 });
    expect([1, 0.651, 0.65, 0.31, 0.3, 0.29, 0].map((r) => bossPhaseFor(r, 1))).toEqual([1, 1, 2, 2, 3, 3, 3]);
  });

  it('never decreases after a heal; NaN keeps the current phase', () => {
    let phase: BossPhase = 1;
    const seen = [0.9, 0.64, 0.95, 0.31, 0.29, 1, 0.5].map((r) => (phase = bossPhaseFor(r, phase)));
    expect(seen).toEqual([1, 2, 2, 2, 3, 3, 3]);
    expect([bossPhaseFor(0.651, 2), bossPhaseFor(1, 3), bossPhaseFor(0.5, 3)]).toEqual([2, 3, 3]);
    expect([bossPhaseFor(NaN, 1), bossPhaseFor(NaN, 2), bossPhaseFor(NaN, 3)]).toEqual([1, 2, 3]);
    expect([bossPhaseFor(1.5, 1), bossPhaseFor(Infinity, 1), bossPhaseFor(-0.1, 1), bossPhaseFor(-Infinity, 2)]).toEqual([1, 1, 3, 3]);
  });
});

describe('phaseFloorHp', () => {
  it('clamps at 65 % / 30 % of max HP in Phases 1 / 2 and at 0 in the Final Phase', () => {
    expect(([1, 2, 3] as const).map((p) => phaseFloorHp(24000, p))).toEqual([15600, 7200, 0]);
    expect([phaseFloorHp(1001, 1), phaseFloorHp(1001, 2)]).toEqual([650, 300]);
  });

  it('a floored HP already reports the next phase, for any whole max HP', () => {
    const bad: number[] = [];
    for (let maxHp = 4; maxHp <= 30000; maxHp++) {
      const [p1, p2] = [phaseFloorHp(maxHp, 1), phaseFloorHp(maxHp, 2)];
      if (bossPhaseFor(p1 / maxHp, 1) !== 2 || bossPhaseFor(p2 / maxHp, 2) !== 3 || !(p1 > p2 && p2 > 0)) bad.push(maxHp);
    }
    expect(bad).toEqual([]);
  });
});

describe('Starshell', () => {
  it('nextStarshellElement picks uniformly among the other three elements with one draw', () => {
    const rng = createRng(2024);
    for (const current of ELEMENT_IDS) {
      const counts = new Map<ElementId, number>();
      for (let i = 0; i < 1200; i++) {
        const e = nextStarshellElement(current, rng);
        counts.set(e, (counts.get(e) ?? 0) + 1);
      }
      expect(counts.has(current), current).toBe(false);
      expect(counts.size).toBe(3);
      for (const n of counts.values()) expect(Math.abs(n - 400)).toBeLessThan(70); // 1200 / 3 each
    }
    const ref = createRng(rng.state());
    ref.next();
    nextStarshellElement('ember', rng);
    expect(rng.state()).toBe(ref.state());
  });

  it('rotates when now reaches nextRotateAt, once per skipped period, and never in between', () => {
    expect(STARSHELL_ROTATE_SECONDS).toBe(12);
    const rng = createRng(9);
    const start: StarshellClock = { element: 'tide', nextRotateAt: 12 };
    const s0 = rng.state();
    expect(stepStarshell(start, 11.99, rng)).toBe(start);
    expect(rng.state()).toBe(s0);
    const first = stepStarshell(start, 12, rng);
    expect(first.nextRotateAt).toBe(24);
    expect(first.element).not.toBe('tide');
    expect(start).toEqual({ element: 'tide', nextRotateAt: 12 });
    expect(stepStarshell(first, 23.99, rng)).toBe(first);

    const ref = createRng(rng.state());
    let expected = first.element;
    for (let i = 0; i < 3; i++) expected = nextStarshellElement(expected, ref); // 24, 36 and 48 passed
    expect(stepStarshell(first, 50, rng)).toEqual({ element: expected, nextRotateAt: 60 });
    expect(rng.state()).toBe(ref.state());
  });

  it('ignores non-finite times', () => {
    const rng = createRng(1);
    const clock: StarshellClock = { element: 'gale', nextRotateAt: 12 };
    const lost: StarshellClock = { element: 'gale', nextRotateAt: -Infinity };
    expect(stepStarshell(clock, Infinity, rng)).toBe(clock);
    expect(stepStarshell(clock, NaN, rng)).toBe(clock);
    expect(stepStarshell(lost, 5, rng)).toBe(lost);
    expect(rng.state()).toBe(createRng(1).state());
  });
});
