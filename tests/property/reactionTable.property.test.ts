// Feature: skyshard-echoes-of-the-wild, Property 5: Reaction 표의 완전성과 대칭성
// Validates: Requirements 25.5
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ELEMENT_IDS, REACTION_IDS, type ElementId, type ReactionId } from '../../src/data/ids';
import { MARK_DURATION, SAME_REACTION_COOLDOWN } from '../../src/data/reactions';
import { applyElement, reactionFor, type ElementTarget } from '../../src/logic/element';

// Table B (requirements.md), restated independently of src/data/reactions.
const TABLE_B: ReadonlyArray<readonly [ElementId, ElementId, ReactionId]> = [
  ['ember', 'tide', 'steamBurst'],
  ['ember', 'terra', 'lavaRift'],
  ['tide', 'terra', 'mudBind'],
  ['gale', 'ember', 'flameSpread'],
  ['gale', 'tide', 'mistSpread'],
  ['gale', 'terra', 'sandGust'],
];
const tableB = (a: ElementId, b: ElementId): ReactionId | undefined =>
  TABLE_B.find(([x, y]) => (x === a && y === b) || (x === b && y === a))?.[2];

const arbElement = fc.constantFrom(...ELEMENT_IDS);
const arbDistinctPair = fc.tuple(arbElement, arbElement).filter(([a, b]) => a !== b);
/** [reaction, seconds ago] entries for the target's reaction history. */
const arbHistory = fc.array(
  fc.tuple(fc.constantFrom(...REACTION_IDS), fc.double({ min: 0, max: 30, noNaN: true })),
  { maxLength: 8 },
);

describe('Property 5: Reaction 표의 완전성과 대칭성', () => {
  it('reactionFor(a, b) and reactionFor(b, a) both equal the table B reaction of distinct elements', () => {
    fc.assert(
      fc.property(arbDistinctPair, ([a, b]) => {
        const expected = tableB(a, b);
        expect(expected).toBeDefined();
        expect(reactionFor(a, b)).toBe(expected);
        expect(reactionFor(b, a)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('applying b to a shield-free target with an active, unlimited a mark reacts and consumes the mark', () => {
    fc.assert(
      fc.property(
        arbDistinctPair,
        fc.double({ min: 0, max: 1e4, noNaN: true }),
        fc.double({ min: 1e-3, max: MARK_DURATION, noNaN: true }),
        arbHistory,
        ([a, b], now, remaining, history) => {
          const r = tableB(a, b);
          const lastReactionAt: Partial<Record<ReactionId, number>> = {};
          for (const [id, ago] of history) {
            // Other reactions may be arbitrarily recent; r itself stays clear of its rate limit.
            lastReactionAt[id] = now - (id === r ? SAME_REACTION_COOLDOWN + 1e-3 + ago : ago);
          }
          const t: ElementTarget = {
            mark: { element: a, expiresAt: now + remaining },
            shield: null,
            lastReactionAt,
          };
          const out = applyElement(t, b, now);
          expect(out).toMatchObject({ kind: 'reaction', reaction: r, consumed: a });
          expect(out.next.mark).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});
