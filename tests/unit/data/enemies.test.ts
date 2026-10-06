import { describe, expect, it } from 'vitest';
import {
  ELITE_DEFS, ENEMY_ATTACKS, ENEMY_DEFS, REGION_ENEMY_LEVELS, isRegionEnemyLevel, type EnemyDef,
} from '../../../src/data/enemies';
import { ELITE_IDS, ENEMY_IDS, isEliteId, isEnemyId, type EliteId, type EnemyId } from '../../../src/data/ids';
import { XP_SOURCES } from '../../../src/data/progression';
import { computeDamage } from '../../../src/logic/damage';
import { scaledDamageLevel, scaledMaxHp } from '../../../src/logic/enemyScaling';

// Enemy / Elite data (design "적 정의", "Elite", "적 드롭"; Req 28.1, 28.13, 8.9, 26.9).
const ALL_IDS: readonly (EnemyId | EliteId)[] = [...ENEMY_IDS, ...ELITE_IDS];
const HIDDEN: readonly EliteId[] = ['oldMossback', 'emberjaw', 'galeclaw'];

describe('enemy data', () => {
  it('defines the 8 kinds and 6 Elites under their ids, with unique atk_<owner>_<name> attacks', () => {
    expect(Object.keys(ENEMY_DEFS).sort()).toEqual([...ALL_IDS].sort());
    for (const id of ALL_IDS) expect(ENEMY_DEFS[id].id).toBe(id);
    const ids = ENEMY_ATTACKS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ENEMY_ATTACKS) {
      expect(isEnemyId(a.owner) || isEliteId(a.owner), a.id).toBe(true);
      expect(a.id.startsWith(`atk_${a.owner}_`), a.id).toBe(true);
    }
    for (const id of ALL_IDS) for (const a of ENEMY_DEFS[id].attacks) expect(ENEMY_ATTACKS).toContain(a);
  });

  it('covers the five archetypes and tells every two kinds apart by ≥ 3 of silhouette, movement, reach, speed, HP, weakness', () => {
    const kinds = ENEMY_IDS.map((id) => ENEMY_DEFS[id]);
    expect([...new Set(kinds.flatMap((k) => k.archetypes))].sort()).toEqual(['charger', 'defensive', 'elemental', 'melee', 'ranged']);
    const traits = (d: EnemyDef): unknown[] =>
      [d.silhouette, JSON.stringify(d.movement), d.attackRange, d.moveSpeed, d.hp, JSON.stringify(d.weakness)];
    kinds.forEach((a, i) =>
      kinds.slice(i + 1).forEach((b) => {
        const tb = traits(b);
        expect(traits(a).filter((v, k) => v !== tb[k]).length, `${a.id} / ${b.id}`).toBeGreaterThanOrEqual(3);
      }),
    );
  });

  it('places kinds at their region levels and scales HP +10% / ATK ×1.06 per level above L₀ (Req 8.9)', () => {
    expect(REGION_ENEMY_LEVELS).toEqual({ verdant: [1, 3], ember: [4, 6], azure: [6, 8], sanctum: [9, 9] });
    for (const id of ENEMY_IDS) {
      const d = ENEMY_DEFS[id];
      expect([d.baseLevel, d.scaling], id).toEqual([REGION_ENEMY_LEVELS[d.regions[0] ?? 'verdant'][0], 'level']);
    }
    for (const id of ELITE_IDS) expect(isRegionEnemyLevel(ELITE_DEFS[id].region, ELITE_DEFS[id].level), id).toBe(true);
    // Design example: a Thornspitter at Ember Ravine level 4 has HP 293 and effective ATK 53.6.
    const ts = ENEMY_DEFS.thornspitter;
    const atkEff = computeDamage({
      baseAtk: ts.atk, level: scaledDamageLevel(ts, 4), equipAtkPct: 0, dmgMul: 1, abilityUpgradePct: 0, equipDmgPct: 0,
      def: 0, critChance: 0, rng01: 0, kind: 'enemy',
    }).raw;
    expect([scaledMaxHp(ts, 4), Math.round(atkEff * 10) / 10]).toEqual([293, 53.6]);
  });

  it('builds hidden Elites as base HP ×2.5 / ATK ×1.3 scaled by level and guardians as fixed stats at damage level 1', () => {
    expect([scaledMaxHp(ENEMY_DEFS.oldMossback, 1), ENEMY_DEFS.oldMossback.atk]).toEqual([1300, 91]);
    for (const id of HIDDEN) {
      const elite = ENEMY_DEFS[id];
      const base = ENEMY_DEFS[ELITE_DEFS[id].base ?? 'bramblekin'];
      expect(elite.hp, id).toBeCloseTo(base.hp * 2.5, 9);
      expect(elite.atk, id).toBeCloseTo(base.atk * 1.3, 9);
      expect([elite.baseLevel, elite.scaling, elite.def, elite.moveSpeed], id).toEqual([base.baseLevel, 'level', base.def, base.moveSpeed]);
      expect(elite.attacks.slice(-base.attacks.length), id).toEqual(base.attacks); // keeps the base kind's attacks
      expect(elite.attacks.length, id).toBeGreaterThan(base.attacks.length);
      expect(scaledMaxHp(elite, 3), id).toBe(Math.round(elite.hp * 1.1 ** (3 - elite.baseLevel)));
    }
    const fixed: readonly [EliteId, number, number][] = [
      ['rootboundWarden', 1600, 70], ['cinderAlpha', 2000, 85], ['sentinelPrime', 2600, 95],
    ];
    for (const [id, hp, atk] of fixed) {
      const elite = ENEMY_DEFS[id];
      expect([elite.scaling, elite.atk], id).toEqual(['fixed', atk]);
      for (const level of [1, 5, 9]) expect([scaledMaxHp(elite, level), scaledDamageLevel(elite, level)], id).toEqual([hp, 1]);
    }
    // Summoned kinds use their own attacks; Sentinel Prime's drone bolt is listed with the rest.
    expect([ELITE_DEFS.rootboundWarden.summon?.kind, ELITE_DEFS.cinderAlpha.summon?.kind]).toEqual(['bramblekin', 'cinderHound']);
    expect(ENEMY_ATTACKS).toContain(ELITE_DEFS.sentinelPrime.drones?.attack);
  });

  it('uses stagger thresholds 100 / 250 / 400, the table XP / Glim and Starmote drops (10% × 1, Elites × 3)', () => {
    const table: Record<EnemyId, [number, number, number]> = {
      bramblekin: [100, 12, 6], thornspitter: [100, 15, 8], mossbackBrute: [250, 35, 20], cinderHound: [100, 20, 10],
      slagshell: [100, 35, 18], ashWisp: [100, 22, 12], windcutter: [100, 28, 15], aetherSentinel: [250, 50, 28],
    };
    for (const id of ENEMY_IDS) {
      const d = ENEMY_DEFS[id];
      expect([d.staggerThreshold, d.xp, d.glim], id).toEqual(table[id]);
      expect(d.drops, id).toEqual([{ item: 'mat_starmote', chance: 0.1, count: 1 }]);
    }
    for (const id of ELITE_IDS) {
      const d = ENEMY_DEFS[id];
      expect([d.staggerThreshold, d.xp, d.elite?.id], id).toEqual([400, XP_SOURCES.elite[id], id]);
      expect(d.drops, id).toEqual([{ item: 'mat_starmote', chance: 1, count: 3 }]);
    }
  });
});
