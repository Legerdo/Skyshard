// Feature: skyshard-echoes-of-the-wild, Property 30: Chest 보상 결정성과 등급
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REGION_IDS, type ItemId } from '../../src/data/ids';
import { ITEMS } from '../../src/data/items';
import { rollChest, type ChestTier, type Reward } from '../../src/logic/loot';

const EQUIPMENT: ItemId[] = ITEMS.filter((item) => item.effect !== undefined).map((item) => item.id);
const TIERS: readonly ChestTier[] = ['common', 'fine', 'glowing'];

const arbChestId = fc.oneof(
  fc.tuple(fc.constantFrom(...REGION_IDS), fc.nat(99)).map(([region, n]) => `chest_${region}_${n}`),
  fc.string({ unit: 'binary', maxLength: 24 }),
);

/** Glim amounts and item counts by id, so checks do not depend on reward order. */
function summarize(rewards: readonly Reward[]): { glim: number[]; items: Map<ItemId, number[]> } {
  const glim: number[] = [];
  const items = new Map<ItemId, number[]>();
  for (const r of rewards) {
    if (r.kind === 'glim') glim.push(r.amount);
    else items.set(r.id, [...(items.get(r.id) ?? []), r.count]);
  }
  return { glim, items };
}

/** Exactly one integer in [lo, hi]. */
const oneIn = (xs: readonly number[] | undefined, lo: number, hi: number): boolean =>
  xs !== undefined && xs.length === 1 && Number.isInteger(xs[0]) && xs[0] >= lo && xs[0] <= hi;

describe('Property 30: chest reward determinism and tiers', () => {
  it('same input → same rewards; common = Glim + herb, fine = Glim + Starmote, glowing = unowned item or Starmote 5 + Glim 200', () => {
    const seen = { herb: 0, noHerb: 0, equipment: 0, fallback: 0 };
    fc.assert(
      fc.property(
        fc.constantFrom(...TIERS),
        arbChestId,
        fc.uniqueArray(fc.constantFrom(...EQUIPMENT)),
        fc.option(fc.constantFrom(...EQUIPMENT), { nil: undefined }),
        (tier, chestId, ownedList, glowingItem) => {
          const owned = new Set(ownedList);
          const rewards = rollChest(tier, chestId, owned, glowingItem);
          expect(rollChest(tier, chestId, new Set(ownedList), glowingItem)).toEqual(rewards);
          const { glim, items } = summarize(rewards);

          if (tier === 'common') {
            expect(oneIn(glim, 30, 60)).toBe(true);
            expect([...items.keys()].filter((id) => id !== 'con_herbDumpling')).toEqual([]);
            const herb = items.get('con_herbDumpling');
            expect(herb === undefined || oneIn(herb, 1, 1)).toBe(true);
            seen[herb === undefined ? 'noHerb' : 'herb']++;
          } else if (tier === 'fine') {
            expect(oneIn(glim, 60, 120)).toBe(true);
            expect([...items.keys()]).toEqual(['mat_starmote']);
            expect(oneIn(items.get('mat_starmote'), 2, 3)).toBe(true);
          } else if (glowingItem !== undefined && !owned.has(glowingItem)) {
            expect(rewards).toEqual([{ kind: 'item', id: glowingItem, count: 1 }]);
            seen.equipment++;
          } else {
            expect(glim).toEqual([200]);
            expect([...items]).toEqual([['mat_starmote', [5]]]);
            seen.fallback++;
          }
          // Common and fine rewards depend on the chest id only.
          if (tier !== 'glowing') expect(rollChest(tier, chestId, new Set(EQUIPMENT))).toEqual(rewards);
        },
      ),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: every branch must actually occur.
    expect(Math.min(seen.herb, seen.noHerb, seen.equipment, seen.fallback)).toBeGreaterThan(5);
  });
});
