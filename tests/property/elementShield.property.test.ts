// Feature: skyshard-echoes-of-the-wild, Property 9: Element_Shield 배율과 표식 유지
// Validates: Requirements 25.10, 6.4
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ELEMENT_IDS, REACTION_IDS, type ReactionId } from '../../src/data/ids';
import { SAME_REACTION_COOLDOWN } from '../../src/data/reactions';
import { applyElement, reactionFor, type ElementTarget } from '../../src/logic/element';

const arbElement = fc.constantFrom(...ELEMENT_IDS);
const arbTime = fc.double({ min: 0, max: 1e4, noNaN: true });
/** Shielded target that may also hold an ordinary mark, with a recent ([reaction, seconds ago]) history. */
const arbShielded = fc.record({
  shield: fc.record({ element: arbElement, durability: fc.double({ min: 1, max: 5000, noNaN: true }) }),
  mark: fc.option(fc.record({ element: arbElement, expiresAt: arbTime }), { nil: null }),
  history: fc.array(
    fc.tuple(fc.constantFrom(...REACTION_IDS), fc.double({ min: 0, max: 3, noNaN: true })),
    { maxLength: 6 },
  ),
});

describe('Property 9: Element_Shield 배율과 표식 유지', () => {
  it('same element hits at ×0.25, another element reacts at ×3.0, and the shield element is never consumed', () => {
    fc.assert(
      fc.property(arbShielded, arbElement, arbTime, ({ shield, mark, history }, e, now) => {
        const s = shield.element;
        const lastReactionAt: Partial<Record<ReactionId, number>> = {};
        for (const [id, ago] of history) lastReactionAt[id] = now - ago;
        const t: ElementTarget = {
          mark: mark === null ? null : { element: mark.element, expiresAt: mark.expiresAt },
          shield: { element: s, durability: shield.durability, max: shield.durability },
          lastReactionAt,
        };
        const out = applyElement(t, e, now);
        expect(out.next.shield?.element).toBe(s);
        if (e === s) {
          expect(out).toMatchObject({ kind: 'shieldHit', reaction: null, shieldMul: 0.25 });
          return;
        }
        const r = reactionFor(s, e);
        expect(r).not.toBeNull();
        const last = r === null ? undefined : lastReactionAt[r];
        if (last !== undefined && now - last < SAME_REACTION_COOLDOWN) {
          expect(out).toMatchObject({ kind: 'limited', reaction: r });
        } else {
          expect(out).toMatchObject({ kind: 'shieldHit', reaction: r, shieldMul: 3.0 });
        }
      }),
      { numRuns: 200 },
    );
  });
});
