// Feature: skyshard-echoes-of-the-wild, Property 12: Stamina 경계와 Exhausted 히스테리시스
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../../src/data/ids';
import {
  STAMINA_RULES,
  canStart,
  newStamina,
  staminaMax,
  stepStamina,
  type StaminaActivity,
  type StaminaState,
} from '../../src/logic/stamina';

const ACTIVITIES: StaminaActivity[] = ['none', 'sprint', 'dodge', 'climbMove', 'climbIdle', 'climbLeap', 'glide', 'swim'];
const BLOCKED: readonly StaminaActivity[] = ['sprint', 'dodge', 'climbMove', 'climbIdle', 'climbLeap', 'glide'];

/** arbStaminaTimeline: segments that repeat one activity / character for `steps` ticks of `dt`. */
const arbStaminaTimeline = fc.array(
  fc.record({
    // Extra weight on 'none' so idle stretches long enough to regen past 30% are common.
    activity: fc.oneof(
      { arbitrary: fc.constant<StaminaActivity>('none'), weight: 3 },
      { arbitrary: fc.constantFrom(...ACTIVITIES), weight: 7 },
    ),
    character: fc.constantFrom(...CHARACTER_IDS),
    // Mostly real frame steps: fc.double alone clusters near 0 and would rarely leave time to regen.
    dt: fc.oneof(
      { arbitrary: fc.constantFrom(1 / 144, 1 / 60, 1 / 30, 0.1, 0.25), weight: 3 },
      { arbitrary: fc.double({ min: 0, max: 0.25, noNaN: true }), weight: 1 },
    ),
    steps: fc.integer({ min: 1, max: 240 }),
  }),
  { minLength: 1, maxLength: 20 },
);

/** First invariant broken by the tick prev → next, or null. */
function violation(prev: StaminaState, next: StaminaState): string | null {
  const clearAt = STAMINA_RULES.exhaustClearRatio * next.max;
  if (next.max !== prev.max) return `max changed to ${next.max}`;
  if (!(next.value >= 0 && next.value <= next.max)) return `value ${next.value} outside [0, ${next.max}]`;
  if (next.value === 0 && !next.exhausted) return 'value 0 but not exhausted';
  if (!prev.exhausted && next.exhausted && next.value !== 0) return `became exhausted at ${next.value}`;
  if (next.exhausted && next.value >= clearAt) return `still exhausted at ${next.value} ≥ ${clearAt}`;
  if (prev.exhausted && !next.exhausted && next.value < clearAt) return `cleared at ${next.value} < ${clearAt}`;
  const allowed = next.exhausted ? BLOCKED.filter((a) => canStart(next, a)) : [];
  return allowed.length > 0 ? `canStart allowed ${allowed.join(', ')} while exhausted` : null;
}

describe('Property 12: stamina bounds and exhausted hysteresis', () => {
  /** **Validates: Requirements 17.2, 17.3, 17.4** */
  it('keeps value in [0, max]; exhausted turns on at 0, blocks starts, and clears only at ≥ 30% of max', () => {
    let exhaustedRuns = 0;
    let recoveredRuns = 0;
    fc.assert(
      fc.property(
        // Completed Echo_Tablet sets → max = 100 + 15 × sets (Req 10.9); beyond the 3 real sets too.
        fc.integer({ min: 0, max: 12 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        arbStaminaTimeline,
        (sets, startRatio, timeline) => {
          const max = staminaMax(sets);
          let s: StaminaState = { ...newStamina(max), value: max * startRatio };
          let found: string | null = null;
          let wasExhausted = false;
          let recovered = false;
          for (const { activity, character, dt, steps } of timeline) {
            for (let i = 0; i < steps && found === null; i++) {
              const next = stepStamina(s, activity, character, dt);
              found = violation(s, next);
              wasExhausted ||= next.exhausted;
              recovered ||= s.exhausted && !next.exhausted;
              s = next;
            }
          }
          expect(found).toBeNull();
          if (wasExhausted) exhaustedRuns++;
          if (recovered) recoveredRuns++;
        },
      ),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: the timelines must actually exhaust and recover.
    expect(exhaustedRuns).toBeGreaterThan(50);
    expect(recoveredRuns).toBeGreaterThan(20);
  });
});
