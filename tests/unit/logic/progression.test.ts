import { describe, expect, it } from 'vitest';
import { MAIN_STAGE_IDS } from '../../../src/data/ids';
import {
  LEVEL_ATK_GROWTH,
  LEVEL_HP_GROWTH,
  MAIN_PATH_XP_ESTIMATE,
  MAX_LEVEL,
  XP_SOURCES,
  XP_TABLE,
} from '../../../src/data/progression';
import { canUpgrade, levelFromXp, statsAt, upgradeCost, xpForLevel } from '../../../src/logic/progression';

const total = (items: readonly { xp: number }[]): number => items.reduce((sum, item) => sum + item.xp, 0);

describe('XP table and levels', () => {
  it('uses the design table: cumulative XP for levels 1–10, maximum 3,000', () => {
    expect(XP_TABLE).toEqual([0, 120, 300, 520, 800, 1130, 1500, 1950, 2450, 3000]);
    expect([MAX_LEVEL, LEVEL_HP_GROWTH, LEVEL_ATK_GROWTH]).toEqual([10, 1.08, 1.06]);
    expect(XP_TABLE.map((_, i) => xpForLevel(i + 1))).toEqual(XP_TABLE);
    expect([xpForLevel(0), xpForLevel(11), xpForLevel(Number.NaN)]).toEqual([0, 3000, 0]);
  });

  it('levelFromXp switches exactly at each boundary', () => {
    const cases = [
      [0, 1], [119, 1], [120, 2], [299, 2], [300, 3], [519, 3], [520, 4], [799, 4], [800, 5], [1129, 5],
      [1130, 6], [1499, 6], [1500, 7], [1949, 7], [1950, 8], [2449, 8], [2450, 9], [2999, 9], [3000, 10], [9999, 10],
    ];
    expect(cases.map(([xp]) => levelFromXp(xp))).toEqual(cases.map(([, level]) => level));
    expect([levelFromXp(-10), levelFromXp(Number.NaN), levelFromXp(Infinity)]).toEqual([1, 1, 10]);
  });

  it('lists the design XP sources', () => {
    expect(XP_SOURCES.elite).toEqual({
      oldMossback: 120,
      emberjaw: 120,
      galeclaw: 120,
      rootboundWarden: 150,
      cinderAlpha: 180,
      sentinelPrime: 220,
    });
    expect(MAIN_STAGE_IDS.map((id) => XP_SOURCES.stage[id] ?? 0)).toEqual([40, 60, 100, 60, 120, 80, 140, 60, 0, 0]);
    expect(XP_SOURCES.sideQuest).toBe(80);
    expect(XP_SOURCES.chest).toEqual({ common: 10, fine: 25, glowing: 50 });
    expect(XP_SOURCES.discovery).toMatchObject({ landmark: 20, vista: 30, hidden: 40, waystone: 15, tablet: 10 });
  });
});

describe('statsAt', () => {
  const base = { hp: 1000, atk: 100, def: 40 };

  it('keeps the base at level 1; level 8 ≈ ×1.71 HP / ×1.50 ATK, level 10 ≈ ×2.00 / ×1.69; DEF unchanged', () => {
    expect(statsAt(base, 1)).toEqual(base);
    const l8 = statsAt(base, 8);
    expect(l8.hp).toBe(1714); // round(1000 × 1.08^7)
    expect(l8.hp / base.hp).toBeCloseTo(1.71, 2);
    expect(l8.atk / base.atk).toBeCloseTo(1.5, 2);
    expect(l8.def).toBe(40);
    const l10 = statsAt(base, 10);
    expect(l10.hp / base.hp).toBeCloseTo(2.0, 2);
    expect(l10.atk / base.atk).toBeCloseTo(1.69, 2);
  });

  it('compounds from the base value and clamps the level to 1–10', () => {
    const l5 = statsAt({ hp: 333, atk: 47, def: 12 }, 5);
    expect(l5).toMatchObject({ hp: 453, def: 12 }); // round(333 × 1.08^4 = 453.04)
    expect(l5.atk).toBeCloseTo(47 * 1.06 ** 4, 9); // unrounded
    expect(statsAt(base, 0)).toEqual(base);
    expect(statsAt(base, 15)).toEqual(statsAt(base, 10));
  });
});

describe('Echo Altar upgrades', () => {
  it('costs Starmote 3 / 6 / 10 and Glim 100 / 250 / 500 for tiers 1–3', () => {
    expect(([1, 2, 3] as const).map((tier) => upgradeCost(tier))).toEqual([
      { starmote: 3, glim: 100 },
      { starmote: 6, glim: 250 },
      { starmote: 10, glim: 500 },
    ]);
  });

  it('reports the missing amounts and the next tier, and "max" at tier 3', () => {
    expect(canUpgrade({ starmote: 4, glim: 100, tier: 1 })).toEqual({
      ok: false,
      missingStarmote: 2,
      missingGlim: 150,
      nextTier: 2,
    });
    expect(canUpgrade({ starmote: 3, glim: 100, tier: 0 })).toEqual({ ok: true, missingStarmote: 0, missingGlim: 0, nextTier: 1 });
    expect(canUpgrade({ starmote: 12, glim: 499, tier: 2 })).toMatchObject({ ok: false, missingGlim: 1, nextTier: 3 });
    expect(canUpgrade({ starmote: Number.NaN, glim: -5, tier: 0 })).toMatchObject({ missingStarmote: 3, missingGlim: 100 });
    expect(canUpgrade({ starmote: 99, glim: 9999, tier: 3 })).toEqual({
      ok: false,
      missingStarmote: 0,
      missingGlim: 0,
      nextTier: null,
    });
  });
});

describe('main-path XP before ms9 (Req 29.3)', () => {
  it('sums to 2,211, which is level 8 (at least level 7)', () => {
    const xp = total(MAIN_PATH_XP_ESTIMATE);
    expect(xp).toBe(2211);
    expect(levelFromXp(xp)).toBeGreaterThanOrEqual(7);
    expect(levelFromXp(xp)).toBe(8);
  });

  it('keeps the design breakdown and still reaches level 7 with every avoidable line skipped', () => {
    const group = (prefix: string): number =>
      total(MAIN_PATH_XP_ESTIMATE.filter((item) => item.label.startsWith(prefix)));
    expect(['전투', '수호 Elite', '단계 완료', '첫 발견', 'Chest'].map(group)).toEqual([656, 550, 660, 255, 90]);
    const required = total(MAIN_PATH_XP_ESTIMATE.filter((item) => !item.avoidable));
    expect(required).toBe(1542);
    expect(levelFromXp(required)).toBe(7);
  });
});
