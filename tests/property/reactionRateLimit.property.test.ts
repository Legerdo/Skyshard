// Feature: skyshard-echoes-of-the-wild, Property 7: Reaction 발생 빈도 제한
// Validates: Requirements 25.8
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ELEMENT_IDS, type ReactionId } from '../../src/data/ids';
import { SAME_REACTION_COOLDOWN } from '../../src/data/reactions';
import { applyElement, damageShield, emptyTarget, type ElementTarget } from '../../src/logic/element';

const arbElement = fc.constantFrom(...ELEMENT_IDS);
/** Time between steps: same-instant repeats, the 0.5 s / 1 s boundaries, or anything up to 1.5 s. */
const arbGap = fc.oneof(fc.constantFrom(0, 0.5, 1), fc.double({ min: 0, max: 1.5, noNaN: true }));
/** Mostly element applications, occasionally breaking the shield (a no-op without one). */
const arbStep = fc.record({
  gap: arbGap,
  op: fc.oneof({ arbitrary: arbElement, weight: 5 }, { arbitrary: fc.constant('break' as const), weight: 1 }),
});
/** arbElementSeq: a target with or without an Element_Shield and a time-ascending application sequence. */
const arbElementSeq = fc.record({
  shield: fc.option(arbElement, { nil: null }),
  steps: fc.array(arbStep, { minLength: 1, maxLength: 60 }),
});

describe('Property 7: Reaction 발생 빈도 제한', () => {
  it('each reaction id occurs at most once per 1 s window on a target; limited applications change nothing', () => {
    fc.assert(
      fc.property(arbElementSeq, ({ shield, steps }) => {
        let t: ElementTarget = {
          ...emptyTarget(),
          shield: shield === null ? null : { element: shield, durability: 100, max: 100 },
        };
        // Last occurrence of each reaction (mark or shield), tracked from the outcomes alone.
        const seen: Partial<Record<ReactionId, number>> = {};
        let now = 0;
        for (const { gap, op } of steps) {
          now += gap;
          if (op === 'break') {
            t = damageShield(t, Infinity).next;
            continue;
          }
          const out = applyElement(t, op, now);
          const reaction = 'reaction' in out ? out.reaction : null;
          const prev = reaction === null ? undefined : seen[reaction];
          if (out.kind === 'limited') {
            // Only a genuine repeat within 1 s is limited, and it keeps mark, shield and history.
            expect(prev !== undefined && now - prev < SAME_REACTION_COOLDOWN, `${reaction} @${now}`).toBe(true);
            expect(out.next).toEqual(t);
          } else if (reaction !== null) {
            // Consecutive occurrences at least 1 s apart ⇔ at most one per half-open 1 s window.
            expect(prev === undefined || now - prev >= SAME_REACTION_COOLDOWN, `${reaction} @${now}`).toBe(true);
            seen[reaction] = now;
          }
          t = out.next;
        }
      }),
      { numRuns: 200 },
    );
  });
});
