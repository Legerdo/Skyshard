// Feature: skyshard-echoes-of-the-wild, Property 19: Starshell Element 회전
// Validates: Requirements 6.4
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { ELEMENT_IDS, type ElementId } from '../../src/data/ids';
import { STARSHELL_ROTATE_SECONDS, nextStarshellElement, stepStarshell, type StarshellClock } from '../../src/logic/boss';

const P = STARSHELL_ROTATE_SECONDS;
/** Tick lengths in exact quarter seconds: frame-like steps, whole periods (landing on boundaries) and long hitches. */
const arbDt = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 8 }).map((q) => q / 4), weight: 5 },
  { arbitrary: fc.constantFrom(P, 2 * P), weight: 1 },
  { arbitrary: fc.integer({ min: 0, max: 240 }).map((q) => q / 4), weight: 2 },
);

describe('Property 19: Starshell Element 회전', () => {
  it('every rotation picks another element, and the clock rotates exactly once per elapsed 12 s period', () => {
    let rotations = 0;
    let skips = 0; // steps that passed two or more period boundaries
    fc.assert(
      fc.property(
        fc.integer(),
        fc.constantFrom(...ELEMENT_IDS),
        fc.integer({ min: 0, max: 1000 }),
        fc.array(arbDt, { maxLength: 60, size: 'max' }),
        (seed, first, t0, dts) => {
          const rng = createRng(seed);
          const ref = createRng(seed); // replays the expected draws
          let clock: StarshellClock = { element: first, nextRotateAt: t0 + P };
          let expected: ElementId = first;
          let now = t0;
          let periods = 0;
          for (const dt of dts) {
            now += dt;
            const due = Math.floor((now - t0) / P) - periods; // boundaries reached during this step
            for (let i = 0; i < due; i++) {
              const e = nextStarshellElement(expected, ref);
              expect(ELEMENT_IDS).toContain(e);
              expect(e).not.toBe(expected);
              expected = e;
            }
            periods += due;
            clock = stepStarshell(clock, now, rng);
            expect(clock).toEqual({ element: expected, nextRotateAt: t0 + P * (periods + 1) });
            expect(rng.state()).toBe(ref.state()); // one draw per rotation, none in between
            rotations += due;
            if (due >= 2) skips++;
          }
        },
      ),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: sequences must rotate often and skip whole periods.
    expect(rotations).toBeGreaterThan(500);
    expect(skips).toBeGreaterThan(20);
  });
});
