// Feature: skyshard-echoes-of-the-wild, Property 6: 같은 Element 재적용 시 표식 갱신
// Validates: Requirements 25.2, 25.3
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ELEMENT_IDS, REACTION_IDS, type ReactionId } from '../../src/data/ids';
import { MARK_DURATION } from '../../src/data/reactions';
import { applyElement, type ElementTarget } from '../../src/logic/element';

const arbElement = fc.constantFrom(...ELEMENT_IDS);
const arbTime = fc.double({ min: 0, max: 1e4, noNaN: true });
/** Mark age 0 ≤ d < 8 s on a 1 ms grid, so markedAt + d never rounds onto the expiry time. */
const arbElapsed = fc.integer({ min: 0, max: MARK_DURATION * 1000 - 1 }).map((ms) => ms / 1000);
/** Arbitrary reaction history; refreshing and marking must leave it alone. */
const arbLastReactionAt = fc
  .array(fc.tuple(fc.constantFrom(...REACTION_IDS), arbTime), { maxLength: 6 })
  .map((entries) => {
    const history: Partial<Record<ReactionId, number>> = {};
    for (const [id, at] of entries) history[id] = at;
    return history;
  });

describe('Property 6: 같은 Element 재적용 시 표식 갱신', () => {
  it('re-applying e to a shield-free target with an unexpired e mark refreshes it to now + 8', () => {
    fc.assert(
      fc.property(arbElement, arbTime, arbElapsed, arbLastReactionAt, (e, markedAt, d, lastReactionAt) => {
        const t: ElementTarget = {
          mark: { element: e, expiresAt: markedAt + MARK_DURATION },
          shield: null,
          lastReactionAt,
        };
        const now = markedAt + d;
        const out = applyElement(t, e, now);
        expect(out.kind).toBe('refreshed');
        expect(out.next.mark).toEqual({ element: e, expiresAt: now + MARK_DURATION });
        expect(out.next.lastReactionAt).toEqual(lastReactionAt);
      }),
      { numRuns: 200 },
    );
  });

  it('applying e to a target with no mark or an expired mark creates a fresh 8 s e mark', () => {
    const arbExpired = fc.option(
      fc.record({ element: arbElement, ago: fc.double({ min: 0, max: 100, noNaN: true }) }),
      { nil: null },
    );
    fc.assert(
      fc.property(arbElement, arbTime, arbExpired, arbLastReactionAt, (e, now, expired, lastReactionAt) => {
        // An expired mark of any element (expiresAt ≤ now) must neither react nor refresh.
        const mark = expired === null ? null : { element: expired.element, expiresAt: now - expired.ago };
        const out = applyElement({ mark, shield: null, lastReactionAt }, e, now);
        expect(out.kind).toBe('marked');
        expect(out.next.mark).toEqual({ element: e, expiresAt: now + MARK_DURATION });
        expect(out.next.lastReactionAt).toEqual(lastReactionAt);
      }),
      { numRuns: 200 },
    );
  });
});
