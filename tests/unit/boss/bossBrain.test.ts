import { describe, expect, it } from 'vitest';
import { BossBrain, inRange } from '../../../src/boss/bossBrain';
import { createRng } from '../../../src/core/rng';
import { CAELITH, CAELITH_ACTIONS } from '../../../src/data/boss';

// BossBrain scheduling rules (task 10.3, Req 6.2, 6.3, 6.7, 6.9).

describe('BossBrain', () => {
  it('distance filters: slashCombo within 6 m, starShards beyond 8 m, dash beyond 10 m', () => {
    expect(inRange('slashCombo', 6)).toBe(true);
    expect(inRange('slashCombo', 6.01)).toBe(false);
    expect(inRange('starShards', 8)).toBe(false);
    expect(inRange('starShards', 8.01)).toBe(true);
    expect(inRange('dash', 10)).toBe(false);
    expect(inRange('dash', 10.5)).toBe(true);
    expect(inRange('groundSlam', 30)).toBe(true);
  });

  it('never repeats the previous attack and skips attacks on cooldown', () => {
    const brain = new BossBrain(createRng(7));
    brain.reset(2, 0, false);
    let now = 0;
    let prev: string | null = null;
    for (let i = 0; i < 200; i++) {
      const d = brain.decide({ phase: 2, distance: 5 + (i % 20), now, crystalsAlive: 4 });
      if (d !== null) {
        if (!d.forced) expect(d.attack).not.toBe(prev);
        prev = d.attack;
      }
      now += 2;
    }
  });

  it('with no candidate the brain returns null and counts nothing', () => {
    const brain = new BossBrain(createRng(1));
    brain.reset(1, 0);
    // Between 6 and 8 m in Phase 1 only groundSlam fits; after it was the previous attack nothing is left.
    brain.started('groundSlam', 0);
    expect(brain.candidates({ phase: 1, distance: 7, now: 100, crystalsAlive: 0 })).toEqual([]);
    const before = brain.decisionCount;
    expect(brain.decide({ phase: 1, distance: 7, now: 100, crystalsAlive: 0 })).toBeNull();
    expect(brain.decisionCount).toBe(before);
  });

  it('Phase 1: every third decision is the slashCombo → groundSlam combo (at the next one in range)', () => {
    const brain = new BossBrain(createRng(3));
    brain.reset(1, 0);
    const picks = Array.from({ length: 9 }, (_, i) => brain.decide({ phase: 1, distance: 3, now: i * 5, crystalsAlive: 0 }));
    expect(picks.map((p) => p?.combo)).toEqual([false, false, true, false, false, true, false, false, true]);
    // Out of range at its turn: taken at the next decision within 6 m.
    const b2 = new BossBrain(createRng(4));
    b2.reset(1, 0);
    b2.decide({ phase: 1, distance: 3, now: 0, crystalsAlive: 0 });
    b2.decide({ phase: 1, distance: 3, now: 5, crystalsAlive: 0 });
    expect(b2.decide({ phase: 1, distance: 12, now: 10, crystalsAlive: 0 })?.combo).toBe(false);
    expect(b2.decide({ phase: 1, distance: 3, now: 15, crystalsAlive: 0 })?.combo).toBe(true);
  });

  it('Phase 2 opens with summonCrystals and re-summons below 2 crystals after its cooldown', () => {
    const brain = new BossBrain(createRng(5));
    brain.reset(2, 0);
    expect(brain.decide({ phase: 2, distance: 5, now: 0, crystalsAlive: 0 })).toMatchObject({ attack: 'summonCrystals', forced: true });
    expect(brain.forced({ phase: 2, distance: 5, now: 10, crystalsAlive: 1 })).toBeNull(); // cooldown 30 s
    expect(brain.forced({ phase: 2, distance: 5, now: 31, crystalsAlive: 1 })?.attack).toBe('summonCrystals');
    expect(brain.forced({ phase: 2, distance: 5, now: 31, crystalsAlive: 3 })).toBeNull();
  });

  it('Final Phase: Astral Sweep every 18 s', () => {
    const brain = new BossBrain(createRng(6));
    brain.reset(3, 100, false);
    expect(brain.forced({ phase: 3, distance: 5, now: 117.9, crystalsAlive: 4 })).toBeNull();
    expect(brain.decide({ phase: 3, distance: 5, now: 118, crystalsAlive: 4 })?.attack).toBe('astralSweep');
    expect(brain.forced({ phase: 3, distance: 5, now: 135, crystalsAlive: 4 })).toBeNull();
    expect(brain.forced({ phase: 3, distance: 5, now: 136, crystalsAlive: 4 })?.attack).toBe('astralSweep');
    expect(CAELITH_ACTIONS.astralSweep.cooldown).toBe(18);
  });

  it('waits are the Phase interval ± 0.3 s', () => {
    const brain = new BossBrain(createRng(9));
    for (const [phase, base] of [[1, 2.2], [2, 1.9], [3, 1.54]] as const) {
      for (let i = 0; i < 100; i++) {
        const w = brain.wait(phase);
        expect(w).toBeGreaterThanOrEqual(base - CAELITH.intervalJitter - 1e-9);
        expect(w).toBeLessThanOrEqual(base + CAELITH.intervalJitter + 1e-9);
      }
    }
  });
});
