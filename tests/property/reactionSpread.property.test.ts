// Feature: skyshard-echoes-of-the-wild, Property 8: 확산 반경과 연쇄 상한
// **Validates: Requirements 25.6, 25.7**
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { distance } from '../../src/core/math';
import { ELEMENT_IDS, REACTION_IDS, type ElementId, type ReactionId } from '../../src/data/ids';
import { REACTION_DEFS } from '../../src/data/reactions';
import {
  MAX_CHAIN_DEPTH, SPREAD_RADIUS, activeMark, previewReaction, reactionFor, resolveSpread,
  type ReactionEvent, type SpreadTarget,
} from '../../src/logic/element';

const NOW = 100;
const arbElement = fc.constantFrom(...ELEMENT_IDS);
/** Integer coordinates make exact 5 m distances (3-4-5) common; doubles cover the rest. */
const arbCoord = (max: number) => fc.oneof(fc.integer({ min: 0, max }), fc.double({ min: 0, max, noNaN: true }));
const arbEnemy = fc.record({
  pos: fc.record({ x: arbCoord(20), y: arbCoord(4), z: arbCoord(20) }),
  // Gale-heavy so that chains form; `left` ≤ 0 is an expired mark.
  mark: fc.option(
    fc.record({
      element: fc.oneof(fc.constant<ElementId>('gale'), arbElement),
      left: fc.double({ min: -1, max: 8, noNaN: true }),
    }),
    { nil: null },
  ),
  shield: fc.oneof({ arbitrary: fc.constant(null), weight: 4 }, { arbitrary: arbElement, weight: 1 }),
  alive: fc.oneof({ arbitrary: fc.constant(true), weight: 4 }, { arbitrary: fc.constant(false), weight: 1 }),
  // A recent reaction (seconds ago) so that some applications hit the 1 s rate limit.
  recent: fc.option(fc.tuple(fc.constantFrom(...REACTION_IDS), fc.double({ min: 0, max: 2, noNaN: true })), {
    nil: null,
  }),
});
/** 1–20 enemies (ids e0, e1, …) in a 20 m × 20 m box, 0–4 m high. */
const arbLayout = fc.array(arbEnemy, { minLength: 1, maxLength: 20 }).map((list) =>
  list.map(({ pos, mark, shield, alive, recent }, i): SpreadTarget => {
    const lastReactionAt: Partial<Record<ReactionId, number>> = {};
    if (recent !== null) lastReactionAt[recent[0]] = NOW - recent[1];
    return {
      id: `e${i}`,
      pos,
      alive,
      element: {
        mark: mark === null ? null : { element: mark.element, expiresAt: NOW + mark.left },
        shield: shield === null ? null : { element: shield, durability: 100, max: 100 },
        lastReactionAt,
      },
    };
  }),
);
/**
 * A Gale-marked line of 2–10 enemies about 0–5.5 m apart (with sideways jitter so some links branch or break),
 * triggered at e0 by a non-Gale element: long chains that reach and exceed the depth cap. Scattered layouts
 * alone rarely go past depth 2.
 */
const arbChain = fc
  .record({
    steps: fc.array(
      fc.record({
        dx: fc.oneof(fc.constant(5), fc.double({ min: 0, max: 5.5, noNaN: true })),
        side: fc.double({ min: -2, max: 2, noNaN: true }),
        mark: fc.oneof({ arbitrary: fc.constant<ElementId>('gale'), weight: 4 }, { arbitrary: arbElement, weight: 1 }),
        shield: fc.oneof({ arbitrary: fc.constant(null), weight: 6 }, { arbitrary: arbElement, weight: 1 }),
        alive: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, { arbitrary: fc.constant(false), weight: 1 }),
      }),
      { minLength: 1, maxLength: 9 },
    ),
    el: fc.constantFrom<ElementId>('ember', 'tide', 'terra'),
  })
  .map(({ steps, el }) => {
    let x = 0;
    const rest = steps.map(({ dx, side, mark, shield, alive }, i): SpreadTarget => {
      x += dx;
      return {
        id: `e${i + 1}`,
        pos: { x, y: 0, z: side },
        alive,
        element: {
          mark: { element: mark, expiresAt: NOW + 8 },
          shield: shield === null ? null : { element: shield, durability: 100, max: 100 },
          lastReactionAt: {},
        },
      };
    });
    const first: SpreadTarget = {
      id: 'e0',
      pos: { x: 0, y: 0, z: 0 },
      alive: true,
      element: { mark: { element: 'gale', expiresAt: NOW + 8 }, shield: null, lastReactionAt: {} },
    };
    return { targets: [first, ...rest], pick: 0, el };
  });
const arbCase = fc.oneof(fc.record({ targets: arbLayout, pick: fc.nat(), el: arbElement }), arbChain);

describe('Property 8: 확산 반경과 연쇄 상한', () => {
  it('spread lands only within 5 m, chains need a differing mark, chainCount matches and depth ≤ 4', () => {
    fc.assert(
      fc.property(arbCase, ({ targets, pick, el }) => {
        const trigger = targets[pick % targets.length];
        const { reactions, applied, chainCount } = resolveSpread(targets, trigger.id, el, NOW);
        const byId = new Map(targets.map((t) => [t.id, t]));
        const chain = reactions.filter((r) => r.chainDepth >= 2);

        // n reported for the HUD equals the reactions that occurred; depth stays within 1..4.
        expect(chainCount).toBe(reactions.length);
        for (const r of reactions) {
          expect(Number.isInteger(r.chainDepth) && r.chainDepth >= 1 && r.chainDepth <= MAX_CHAIN_DEPTH).toBe(true);
          expect(r.position).toEqual(byId.get(r.targetId)?.pos);
        }
        // No loops: each target reacts at most once, and only the trigger reacts at depth 1.
        expect(new Set(reactions.map((r) => r.targetId)).size).toBe(reactions.length);
        const direct = reactions.filter((r) => r.chainDepth === 1);
        const expectedDirect = trigger.alive ? previewReaction(trigger.element, el, NOW) : null;
        expect(direct.map((r) => r.targetId)).toEqual(expectedDirect === null ? [] : [trigger.id]);
        expect(direct.map((r) => r.reaction)).toEqual(expectedDirect === null ? [] : [expectedDirect]);

        const spreadEl = expectedDirect === null ? null : REACTION_DEFS[expectedDirect].spreads;
        if (spreadEl === null) {
          expect(applied).toEqual([]);
          expect(chain).toEqual([]);
          return;
        }
        // Spreading reactions below the cap; a spread from a depth-4 reaction propagates no further.
        const sources = reactions.filter(
          (r) => REACTION_DEFS[r.reaction].spreads !== null && r.chainDepth < MAX_CHAIN_DEPTH,
        );
        const near = (s: ReactionEvent, id: string): boolean =>
          s.targetId !== id && distance(s.position, byId.get(id)?.pos ?? s.position) <= SPREAD_RADIUS;

        // Applications carry the spread element, and each alive other enemy receives it exactly once per
        // spreading reaction within 5 m of it; dead or farther enemies receive nothing.
        for (const a of applied) expect(a.element).toBe(spreadEl);
        for (const t of targets) {
          const received = applied.filter((a) => a.targetId === t.id).length;
          const expected = t.alive ? sources.filter((s) => near(s, t.id)).length : 0;
          expect(received, t.id).toBe(expected);
        }

        // A chain reaction needs a held element (shield first) other than the spread element, and occurs on the
        // first receipt, one level below the shallowest spreading reaction in range.
        for (const r of chain) {
          const before = byId.get(r.targetId)!.element;
          const held = before.shield?.element ?? activeMark(before, NOW)?.element;
          expect(held !== undefined && held !== spreadEl, r.targetId).toBe(true);
          expect(r.reaction).toBe(held === undefined ? null : reactionFor(held, spreadEl));
          const depths = sources.filter((s) => near(s, r.targetId)).map((s) => s.chainDepth);
          expect(r.chainDepth).toBe(Math.min(...depths) + 1);
        }
        // Conversely, every reached non-trigger receiver whose held element reacts (and is not rate limited)
        // produces exactly one reaction, so the count reflects every reaction that actually happened.
        const reacted = new Set(chain.map((r) => r.targetId));
        const reached = new Set(applied.map((a) => a.targetId));
        for (const t of targets) {
          if (t.id === trigger.id || !reached.has(t.id)) continue;
          expect(reacted.has(t.id), t.id).toBe(previewReaction(t.element, spreadEl, NOW) !== null);
        }
      }),
      { numRuns: 200 },
    );
  });
});
