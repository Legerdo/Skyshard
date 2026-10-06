// Feature: skyshard-echoes-of-the-wild, Property 18: 보스 Phase 단조성
// Validates: Requirements 6.1
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bossPhaseFor, type BossPhase } from '../../src/logic/boss';

/** arbHpRatios: HP ratio sequences with heals, the exact thresholds and their neighbours, out-of-range values and NaN. */
const arbHpRatios = fc.array(
  fc.oneof(
    { arbitrary: fc.double({ min: 0, max: 1, noNaN: true }), weight: 6 },
    {
      arbitrary: fc.constantFrom(0.65, 0.65 + Number.EPSILON / 2, 0.651, 0.649, 0.3, 0.3 + Number.EPSILON / 4, 0.29, 0, 1),
      weight: 3,
    },
    { arbitrary: fc.double(), weight: 1 }, // any double, including NaN, ±Infinity and huge values
  ),
  { maxLength: 40, size: 'max' },
);

describe('Property 18: 보스 Phase 단조성', () => {
  it('chained from Phase 1, the phase never decreases and follows the 0.65 / 0.30 thresholds', () => {
    let heals = 0; // ratios above 0.65 seen after the phase had risen
    let finals = 0;
    fc.assert(
      fc.property(arbHpRatios, (ratios) => {
        let phase: BossPhase = 1;
        let allAbove = true; // every ratio so far > 0.65
        for (const r of ratios) {
          const next = bossPhaseFor(r, phase);
          allAbove &&= r > 0.65;
          expect(next).toBeGreaterThanOrEqual(phase);
          if (r <= 0.3) expect(next).toBe(3);
          else if (r <= 0.65) expect(next).toBe(Math.max(phase, 2));
          else expect(next).toBe(phase); // heals and NaN keep the phase
          if (allAbove) expect(next).toBe(1);
          if (r > 0.65 && phase > 1) heals++;
          if (next === 3 && phase < 3) finals++;
          phase = next;
        }
      }),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: runs must heal after a phase change and reach the Final Phase.
    expect(heals).toBeGreaterThan(100);
    expect(finals).toBeGreaterThan(50);
  });
});
