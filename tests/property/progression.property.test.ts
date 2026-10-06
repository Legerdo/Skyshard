// Feature: skyshard-echoes-of-the-wild, Property 24: 성장 배율과 메인 경로 레벨
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAIN_PATH_XP_ESTIMATE, XP_TABLE } from '../../src/data/progression';
import { createGameEventBus } from '../../src/core/gameEvents';
import { PARTY_SLOTS } from '../../src/logic/party';
import { addXp, levelFromXp, statsAt, xpForLevel } from '../../src/logic/progression';
import { createNewGameState } from '../../src/logic/save/gameState';
import { PartySystem } from '../../src/party/partySystem';
import { ProgressionSystem } from '../../src/progression/progressionSystem';
import { createRuntimeState } from '../../src/save/runtimeState';
import { mainPathXpLines } from '../unit/helpers/xpBudget';

const arbBase = fc.record({
  hp: fc.integer({ min: 1, max: 20_000 }),
  atk: fc.integer({ min: 1, max: 2_000 }),
  def: fc.integer({ min: 0, max: 500 }),
});

/** XP samples: anywhere in 0–5,000 (plus out-of-range), and exactly on / just below each boundary. */
const arbXp = fc.oneof(
  fc.integer({ min: 0, max: 5_000 }),
  fc.double({ min: -100, max: 5_000, noNaN: true }),
  fc.constantFrom(...XP_TABLE),
  fc.constantFrom(...XP_TABLE).map((xp) => xp - 1),
);

const sum = (items: readonly { xp: number }[]): number => items.reduce((total, item) => total + item.xp, 0);

describe('Property 24: growth multipliers and main-path level', () => {
  it('statsAt gives round(hp × 1.08^(L−1)) and atk × 1.06^(L−1) at every level 1–10, DEF unchanged', () => {
    fc.assert(
      fc.property(arbBase, (base) => {
        for (let level = 1; level <= 10; level++) {
          const stats = statsAt(base, level);
          const atk = base.atk * 1.06 ** (level - 1);
          expect(stats.hp).toBe(Math.round(base.hp * 1.08 ** (level - 1)));
          expect(Math.abs(stats.atk - atk)).toBeLessThanOrEqual(atk * 1e-12);
          expect(stats.def).toBe(base.def);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('ProgressionSystem: any grant sequence keeps XP ≤ 3,000 and level = levelFromXp, one levelUp (final level) per raising grant, full HP after it', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -200, max: 1_800 }), { minLength: 1, maxLength: 12 }), (grants) => {
        const gs = createNewGameState(1);
        gs.party.joined = [...PARTY_SLOTS];
        const bus = createGameEventBus();
        const party = new PartySystem({ bus, state: gs, runtime: createRuntimeState(gs), bossPhase: () => null });
        const progression = new ProgressionSystem({ state: gs, bus });
        const levels: number[] = [];
        bus.on('levelUp', (p) => levels.push(p.level));
        for (const amount of grants) {
          gs.party.hp.kairen = 1; // hurt before each grant
          const before = gs.party.level;
          levels.length = 0;
          progression.grantXp(amount);
          bus.dispatch();
          expect(gs.party.xp).toBeLessThanOrEqual(3000);
          expect(gs.party.level).toBe(levelFromXp(gs.party.xp));
          expect(levels).toEqual(gs.party.level > before ? [gs.party.level] : []);
          if (gs.party.level > before) expect(gs.party.hp.kairen).toBe(party.maxHp('kairen'));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('levelFromXp is non-decreasing in XP, stays in 1–10 and agrees with xpForLevel', () => {
    fc.assert(
      fc.property(arbXp, arbXp, (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const level = levelFromXp(lo);
        expect(Number.isInteger(level) && level >= 1 && level <= 10).toBe(true);
        expect(levelFromXp(hi)).toBeGreaterThanOrEqual(level);
        if (lo >= 0) expect(xpForLevel(level)).toBeLessThanOrEqual(lo);
        if (level < 10) expect(lo).toBeLessThan(xpForLevel(level + 1));
      }),
      { numRuns: 200 },
    );
  });

  it('main-path XP recomputed from the encounter / quest data reaches ms9 at level ≥ 7 with any avoidable part skipped', () => {
    const lines = mainPathXpLines(); // encounter groups and stage grants from the data, route discoveries / Chests
    const avoidable = lines.filter((l) => l.avoidable);
    expect(avoidable.map((l) => l.label)).toEqual(expect.arrayContaining(['전투: ember_pass_pack', '전투: azure_ridge_pack']));
    const total = sum(lines);
    fc.assert(
      fc.property(fc.subarray(avoidable), (skipped) => {
        const xp = addXp(0, total - sum(skipped)); // XP only accumulates on the way (never lost)
        expect(levelFromXp(xp)).toBeGreaterThanOrEqual(7);
      }),
      { numRuns: 200 },
    );
  });

  it('main-path XP before ms9 reaches level ≥ 7 in full and with any avoidable lines skipped', () => {
    const total = sum(MAIN_PATH_XP_ESTIMATE);
    expect(levelFromXp(total)).toBeGreaterThanOrEqual(7);
    const avoidable = MAIN_PATH_XP_ESTIMATE.filter((item) => item.avoidable);
    expect(avoidable.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.subarray(avoidable), (skipped) => {
        expect(levelFromXp(total - sum(skipped))).toBeGreaterThanOrEqual(7);
      }),
      { numRuns: 200 },
    );
  });
});
