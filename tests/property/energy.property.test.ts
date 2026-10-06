// Feature: skyshard-echoes-of-the-wild, Property 11: Energy 획득과 Burst 규칙
// **Validates: Requirements 24.6, 24.7**
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addEnergy, canBurst, energyGain, spendBurst, type EnergyEventKind } from '../../src/logic/energy';

const EXPECTED_GAIN: Readonly<Record<EnergyEventKind, number>> = {
  normalHit: 1,
  chargedHit: 3,
  skillCastHit: 6,
  reaction: 5,
  perfectDodge: 10,
};
const KINDS = Object.keys(EXPECTED_GAIN) as EnergyEventKind[];

type Step = { type: 'gain'; kind: EnergyEventKind } | { type: 'burst' };

/** Energy events interleaved with Burst attempts (design: arbEnergyEvents). */
const arbEnergyEvents: fc.Arbitrary<Step[]> = fc.array(
  fc.oneof(
    { arbitrary: fc.constantFrom(...KINDS).map((kind): Step => ({ type: 'gain', kind })), weight: 4 },
    { arbitrary: fc.constant<Step>({ type: 'burst' }), weight: 1 },
  ),
  { maxLength: 100 },
);
/** Burst costs 60 / 70 from the character kits, plus any other positive cost. */
const arbBurstCost = fc.oneof(fc.constantFrom(60, 70), fc.integer({ min: 1, max: 100 }));

describe('Property 11: Energy gain and Burst rules', () => {
  it('Energy is the gain since the last Burst capped at max; Burst fires only at max and resets to 0', () => {
    fc.assert(
      fc.property(arbEnergyEvents, arbBurstCost, (steps, max) => {
        let energy = 0;
        let sinceBurst = 0; // plain sum of the gains since the last Burst
        for (const step of steps) {
          if (step.type === 'gain') {
            const gain = energyGain(step.kind);
            expect(gain).toBe(EXPECTED_GAIN[step.kind]);
            energy = addEnergy(energy, max, gain);
            sinceBurst += gain;
            expect(energy).toBe(Math.min(max, sinceBurst));
          } else {
            // Burst attempt: ready exactly when the gain since the last Burst reached the cost.
            const ready = canBurst(energy, max);
            expect(ready).toBe(sinceBurst >= max);
            if (ready) {
              expect(energy).toBe(max);
              energy = spendBurst();
              sinceBurst = 0;
              expect(energy).toBe(0);
            } else {
              expect(energy).toBeLessThan(max);
            }
          }
          expect(energy).toBeGreaterThanOrEqual(0);
          expect(energy).toBeLessThanOrEqual(max);
        }
      }),
      { numRuns: 200 },
    );
  });
});
