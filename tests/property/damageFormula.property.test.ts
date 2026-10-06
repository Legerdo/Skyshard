// Feature: skyshard-echoes-of-the-wild, Property 10: 피해 공식의 하한·단조성·치명타 배율
// Validates: Requirements 24.10
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeDamage, type DamageInput, type DamageKind } from '../../src/logic/damage';

/** Fixed seed per check so a failure reruns the same shrunk counterexample. */
const runs = (seed: number) => ({ numRuns: 200, seed });

/** Kinds rolled against the attacker's critChance. */
const CRIT_KINDS: readonly DamageKind[] = ['normal', 'charged', 'skill', 'burst', 'reaction'];
/** Enemy→player, damage-over-time and hazard hits always pass critChance 0 (Req 28.10). */
const NO_CRIT_KINDS: readonly DamageKind[] = ['dot', 'enemy', 'hazard'];

const arbAtk = fc.double({ min: 0, max: 5000, noNaN: true });
const arbMul = fc.double({ min: 0, max: 10, noNaN: true });
const arbDef = fc.double({ min: 0, max: 2000, noNaN: true });
const arbPct = fc.double({ min: 0, max: 2, noNaN: true });
/** A pre-drawn roll in [0, 1). */
const arbUnit = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });

/** Valid DamageInputs of the given kinds; no-crit kinds get critChance 0, the others any chance in [0, 1]. */
const arbDamageInputOf = (kinds: readonly DamageKind[]): fc.Arbitrary<DamageInput> =>
  fc
    .record({
      baseAtk: arbAtk,
      level: fc.integer({ min: 1, max: 10 }),
      equipAtkPct: arbPct,
      dmgMul: arbMul,
      abilityUpgradePct: arbPct,
      equipDmgPct: arbPct,
      def: arbDef,
      critChance: fc.double({ min: 0, max: 1, noNaN: true }),
      rng01: arbUnit,
      kind: fc.constantFrom(...kinds),
      frontGuard: fc.boolean(),
      shield: fc.constantFrom('same', 'reaction', 'other', null),
      vulnerable: fc.boolean(),
      reactionDamagePct: arbPct,
    })
    .map((i): DamageInput => (NO_CRIT_KINDS.includes(i.kind) ? { ...i, critChance: 0 } : i));

/** A valid DamageInput of any kind (design: arbDamageInput). */
const arbDamageInput = arbDamageInputOf([...CRIT_KINDS, ...NO_CRIT_KINDS]);

/** Two values of `arb` as [low, high]. */
const ordered = (arb: fc.Arbitrary<number>): fc.Arbitrary<[number, number]> =>
  fc.tuple(arb, arb).map(([a, b]): [number, number] => (a <= b ? [a, b] : [b, a]));

const amount = (i: DamageInput): number => computeDamage(i).amount;

describe('Property 10: 피해 공식의 하한·단조성·치명타 배율', () => {
  it('amount is an integer ≥ 1', () => {
    fc.assert(
      fc.property(arbDamageInput, (i) => {
        const a = amount(i);
        expect(Number.isInteger(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(1);
      }),
      runs(1001),
    );
  });

  it('is non-decreasing in baseAtk', () => {
    fc.assert(
      fc.property(arbDamageInput, ordered(arbAtk), (i, [lo, hi]) => {
        expect(amount({ ...i, baseAtk: lo })).toBeLessThanOrEqual(amount({ ...i, baseAtk: hi }));
      }),
      runs(1002),
    );
  });

  it('is non-decreasing in dmgMul', () => {
    fc.assert(
      fc.property(arbDamageInput, ordered(arbMul), (i, [lo, hi]) => {
        expect(amount({ ...i, dmgMul: lo })).toBeLessThanOrEqual(amount({ ...i, dmgMul: hi }));
      }),
      runs(1003),
    );
  });

  it('is non-increasing in def', () => {
    fc.assert(
      fc.property(arbDamageInput, ordered(arbDef), (i, [lo, hi]) => {
        expect(amount({ ...i, def: lo })).toBeGreaterThanOrEqual(amount({ ...i, def: hi }));
      }),
      runs(1004),
    );
  });

  it('a crit is within 1 of 1.5× the non-crit amount when only rng01 and critChance differ', () => {
    fc.assert(
      fc.property(arbDamageInputOf(CRIT_KINDS), arbUnit, arbUnit, (i, x, y) => {
        fc.pre(x !== y);
        const [lo, hi] = x < y ? [x, y] : [y, x];
        // rng01 < critChance crits; rng01 ≥ critChance does not.
        const crit = computeDamage({ ...i, rng01: lo, critChance: hi });
        const normal = computeDamage({ ...i, rng01: hi, critChance: lo });
        expect([crit.crit, normal.crit]).toEqual([true, false]);
        expect(Math.abs(crit.amount - 1.5 * normal.amount)).toBeLessThanOrEqual(1);
      }),
      runs(1005),
    );
  });
});
