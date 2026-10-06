// Feature: skyshard-echoes-of-the-wild, Property 3: 보정 결과의 범위와 멱등성
/*
 * Validates: Requirements 36.12. For any input, sanitizeGameState(raw).state passes validateGameState, keeps item
 * counts in 0–cap (consumables 10), Glim ≥ 0, level 1–10, Skyshards 0–3 and no undefined ids; sanitizing that result
 * again gives the same state and no repairs.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ITEM_BY_ID } from '../../src/data/items';
import type { ItemId } from '../../src/data/ids';
import { sanitizeGameState } from '../../src/logic/save/sanitize';
import { validateGameState } from '../../src/logic/save/validate';
import { arbDamagedState } from './generators/gameState';

const arbRaw = fc.oneof(fc.anything(), fc.jsonValue(), arbDamagedState);

describe('Property 3: sanitize range and idempotence', () => {
  it('any input becomes a valid state within the ranges, and a second pass changes nothing', () => {
    fc.assert(
      fc.property(arbRaw, (raw) => {
        const first = sanitizeGameState(raw);
        const s = first.state;
        expect(validateGameState(s)).toEqual([]);
        for (const [id, n] of Object.entries(s.inventory.items)) {
          const def = ITEM_BY_ID.get(id as ItemId);
          expect(def).toBeDefined();
          expect(n).toBeGreaterThanOrEqual(0);
          if (def?.kind === 'consumable') expect(n).toBeLessThanOrEqual(10);
        }
        expect(s.inventory.glim).toBeGreaterThanOrEqual(0);
        expect(s.party.level).toBeGreaterThanOrEqual(1);
        expect(s.party.level).toBeLessThanOrEqual(10);
        expect([0, 1, 2, 3]).toContain(s.skyshards);
        const second = sanitizeGameState(s);
        expect(second.repairs).toEqual([]);
        expect(second.state).toEqual(s);
      }),
      { numRuns: 200 },
    );
  });
});
