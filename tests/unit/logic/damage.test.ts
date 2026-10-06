import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import {
  CRIT_MULTIPLIER,
  FRONT_GUARD_MUL,
  LEVEL_ATK_GROWTH,
  SHIELD_REACTION_MUL,
  SHIELD_SAME_MUL,
  VULNERABLE_MUL,
  computeDamage,
  staggerGain,
  type DamageInput,
} from '../../../src/logic/damage';
import { ENERGY_GAINS, addEnergy, canBurst, energyGain, spendBurst, type EnergyEventKind } from '../../../src/logic/energy';

// Level 1, no bonuses, DEF 0 and no crit, so amount = round(baseAtk × dmgMul) unless overridden.
const base: DamageInput = {
  baseAtk: 100,
  level: 1,
  equipAtkPct: 0,
  dmgMul: 1,
  abilityUpgradePct: 0,
  equipDmgPct: 0,
  def: 0,
  critChance: 0,
  rng01: 0.5,
  kind: 'normal',
};
const dmg = (over: Partial<DamageInput>): number => computeDamage({ ...base, ...over }).amount;

describe('computeDamage', () => {
  it('exports the designed multipliers', () => {
    expect([CRIT_MULTIPLIER, LEVEL_ATK_GROWTH, FRONT_GUARD_MUL]).toEqual([1.5, 1.06, 0.3]);
    expect([SHIELD_SAME_MUL, SHIELD_REACTION_MUL, VULNERABLE_MUL]).toEqual([0.25, 3, 1.5]);
  });

  it('applies defFactor 100 / (100 + def): level 1, DEF 50 → 2/3', () => {
    expect(computeDamage({ ...base, baseAtk: 120, def: 50 })).toEqual({ amount: 80, crit: false, raw: 120 });
    expect(dmg({ def: 100 })).toBe(50);
  });

  it('compounds ATK ×1.06 per level and adds equipment and upgrade bonuses', () => {
    expect([2, 3, 10].map((level) => dmg({ level }))).toEqual([106, 112, 169]); // 106, 112.36, 168.95
    expect(dmg({ equipAtkPct: 0.2, abilityUpgradePct: 0.15, equipDmgPct: 0.1 })).toBe(150); // 120 × 1.25
    expect(dmg({ dmgMul: 1.6 })).toBe(160);
  });

  it('crits ×1.5 exactly when rng01 < critChance', () => {
    expect(computeDamage({ ...base, baseAtk: 120, def: 50, critChance: 0.6, rng01: 0.59 })).toEqual({
      amount: 120,
      crit: true,
      raw: 120,
    });
    expect(computeDamage({ ...base, critChance: 0.5, rng01: 0.5 }).crit).toBe(false);
    expect(dmg({ critChance: 1, rng01: 0.999999 })).toBe(150);
    expect(computeDamage({ ...base, kind: 'enemy', critChance: 0, rng01: 0 }).crit).toBe(false);
  });

  it('front guard cuts Normal_Attack damage only, to 30%', () => {
    expect(dmg({ frontGuard: true })).toBe(30);
    expect(dmg({ frontGuard: true, kind: 'charged' })).toBe(100);
  });

  it('applies Element_Shield, vulnerable and reaction bonuses', () => {
    expect([dmg({ shield: 'same' }), dmg({ shield: 'reaction' }), dmg({ shield: 'other' }), dmg({ shield: null })]).toEqual([
      25, 300, 100, 100,
    ]);
    expect(dmg({ vulnerable: true })).toBe(150);
    expect(dmg({ kind: 'reaction', reactionDamagePct: 0.5 })).toBe(150);
    expect(dmg({ kind: 'skill', reactionDamagePct: 0.5 })).toBe(100);
  });

  it('never deals less than 1', () => {
    expect(computeDamage({ ...base, baseAtk: 0 })).toEqual({ amount: 1, crit: false, raw: 0 });
    expect(dmg({ baseAtk: 1, dmgMul: 0.1, def: 1000 })).toBe(1);
    expect(dmg({ dmgMul: 0 })).toBe(1);
  });

  it('sanitizes non-finite and out-of-range inputs', () => {
    expect(computeDamage({ ...base, baseAtk: Number.NaN })).toEqual({ amount: 1, crit: false, raw: 0 });
    expect([Number.NaN, -3, 0, 99].map((level) => dmg({ level }))).toEqual([100, 100, 100, 169]);
    expect([Number.NaN, -50].map((def) => dmg({ def }))).toEqual([100, 100]);
    expect(dmg({ equipAtkPct: Number.NaN, abilityUpgradePct: Infinity, equipDmgPct: -Infinity })).toBe(100);
    expect(dmg({ dmgMul: Number.NaN })).toBe(1);
    expect(computeDamage({ ...base, critChance: Number.NaN, rng01: 0 }).crit).toBe(false);
    expect(computeDamage({ ...base, critChance: 0.5, rng01: Number.NaN }).crit).toBe(true); // roll → 0
    expect(computeDamage({ ...base, rng01: -1 }).crit).toBe(false);
  });

  it('is deterministic for a roll pre-drawn from a seeded Rng', () => {
    const input: DamageInput = { ...base, critChance: 0.5, rng01: createRng(42).next() };
    expect(computeDamage(input)).toEqual(computeDamage({ ...input }));
    expect(computeDamage(input).crit).toBe(input.rng01 < 0.5);
  });

  it('staggerGain is poise, ×1.5 on a Terra-marked target', () => {
    expect([staggerGain(10, false), staggerGain(10, true)]).toEqual([10, 15]);
    expect([staggerGain(Number.NaN, true), staggerGain(-5, false)]).toEqual([0, 0]);
  });
});

describe('energy', () => {
  it('grants the designed Energy per event', () => {
    const expected = { normalHit: 1, chargedHit: 3, skillCastHit: 6, reaction: 5, perfectDodge: 10 };
    expect(ENERGY_GAINS).toEqual(expected);
    for (const [kind, gain] of Object.entries(expected)) expect(energyGain(kind as EnergyEventKind)).toBe(gain);
  });

  it('addEnergy clamps to [0, max] and ignores non-finite gains', () => {
    expect([addEnergy(0, 60, 1), addEnergy(55, 60, 10), addEnergy(5, 60, -10), addEnergy(80, 60, 0)]).toEqual([
      1, 60, 0, 60,
    ]);
    expect([addEnergy(10, 60, Number.NaN), addEnergy(10, 60, Infinity), addEnergy(Number.NaN, 60, 3)]).toEqual([10, 10, 3]);
  });

  it('canBurst only at max, and spendBurst empties the Energy', () => {
    expect([canBurst(60, 60), canBurst(59, 60), canBurst(0, 0), canBurst(Number.NaN, 70)]).toEqual([true, false, false, false]);
    expect(spendBurst()).toBe(0);
  });
});
