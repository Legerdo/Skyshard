// Feature: skyshard-echoes-of-the-wild, Property 22: Telegraph 최소 시간
// Validates: Requirements 6.9, 28.9, 26.5
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { judgeTime } from '../../src/combat/attackRuntime';
import {
  BOSS_ATTACKS, CAELITH_ACTIONS, CAELITH_ATTACKS, MIN_TELEGRAPH, SHARD_CRYSTAL,
  type AttackStrength, type BossAttackDef,
} from '../../src/data/boss';
import type { AttackDef } from '../../src/data/combatTypes';
import { ELITE_DEFS, ENEMY_ATTACKS, getEnemyDef, type EnemyAttackDef } from '../../src/data/enemies';
import { BOSS_IDS, ELITE_IDS, ENEMY_IDS, isBossId, isEliteId, type BossId, type EliteId, type EnemyId } from '../../src/data/ids';

/** Slack for differences of decimal clip times. */
const EPS = 1e-9;

/**
 * A damaging attack as Property 22 sees it: its strength and the warning before each damaging judgement in data
 * order. Clip-timed AttackDefs also carry how long their Telegraph shows and their first damaging judgement's clip
 * time; Caelith's BossAttackDefs give the warning per judgement directly (`strength: null` ones skipped), and the
 * Shard_Crystal pulse counts as a strong attack.
 */
interface TelegraphCase {
  id: string;
  strength: AttackStrength;
  warnings: readonly number[];
  clip: { telegraph: number; firstHit: number } | null;
}

/**
 * Damaging HitEvents (dmgMul > 0) at the runtime's judge time (`t`, plus a ground circle's delay): the Telegraph
 * before the first, the gap since the previous one after it.
 */
function caseFromAttack(def: AttackDef, strength: AttackStrength, id: string = def.id): TelegraphCase {
  const telegraph = def.telegraph?.duration ?? 0;
  const judgements = def.hits.filter((h) => h.dmgMul > 0).map(judgeTime);
  return {
    id,
    strength,
    warnings: judgements.map((t, i) => (i === 0 ? telegraph : t - judgements[i - 1])),
    clip: judgements.length > 0 ? { telegraph, firstHit: judgements[0] } : null,
  };
}

const enemyCase = (def: EnemyAttackDef): TelegraphCase => caseFromAttack(def, def.telegraph.strong ? 'strong' : 'normal');

/** A BossAttackDef's per-judgement Telegraphs of its damaging judgements; null for an action without damage. */
function bossCase(def: BossAttackDef): TelegraphCase | null {
  if (def.strength === null) return null;
  return { id: def.id, strength: def.strength, warnings: def.telegraph.filter((_, i) => def.dmgMul[i] > 0), clip: null };
}

/**
 * The BossEncounter's action schedule of a damaging attack (CAELITH_ACTIONS): each damaging judgement's warning is
 * the time its own Telegraph shows before it (`at − shownAt`), and the first judgement comes no earlier than the
 * action's first Telegraph ends.
 */
function scheduleCase(name: (typeof CAELITH_ATTACKS)[number]): TelegraphCase | null {
  const table: BossAttackDef = BOSS_ATTACKS[name];
  if (table.strength === null) return null;
  const judgements = CAELITH_ACTIONS[name].judgements.filter((_, i) => (table.dmgMul[i] ?? 0) > 0);
  const first = judgements[0];
  return {
    id: `${table.id} schedule`,
    strength: table.strength,
    warnings: judgements.map((j) => j.at - j.shownAt),
    clip: first === undefined ? null : { telegraph: first.at - first.shownAt, firstHit: first.at },
  };
}

/** Caelith: its eight BossAttackDefs, the runtime schedule the encounter plays, and the Shard_Crystal pulse (strong). */
function caelithCases(): TelegraphCase[] {
  const table = CAELITH_ATTACKS.map((name): BossAttackDef => BOSS_ATTACKS[name]).map(bossCase);
  const schedules = CAELITH_ATTACKS.map(scheduleCase);
  const pulse: TelegraphCase = { id: 'shardCrystal pulse', strength: 'strong', warnings: [SHARD_CRYSTAL.pulseTelegraph], clip: null };
  return [...[...table, ...schedules].filter((c): c is TelegraphCase => c !== null), pulse];
}

type Owner = EnemyId | EliteId | BossId;
const OWNERS: readonly Owner[] = [...ENEMY_IDS, ...ELITE_IDS, ...BOSS_IDS];

/** Cases of the attacks that deal damage (at least one damaging judgement). */
const damaging = (cases: readonly TelegraphCase[]): TelegraphCase[] => cases.filter((c) => c.warnings.length > 0);

/**
 * Every damaging attack `owner` plays: an enemy's EnemyDef attacks (Elites carry their extra patterns and base kind's
 * attacks there) plus Sentinel Prime's drone bolt, or Caelith's cases. Placement level scales HP and ATK only, never
 * timing (Caelith is fixed at level 9).
 */
function casesOf(owner: Owner): TelegraphCase[] {
  if (isBossId(owner)) return damaging(caelithCases());
  const drone = isEliteId(owner) ? ELITE_DEFS[owner].drones?.attack : undefined;
  const { attacks } = getEnemyDef(owner);
  return damaging((drone === undefined ? attacks : [...attacks, drone]).map(enemyCase));
}

const arbPlacement = fc.record({ owner: fc.constantFrom(...OWNERS), level: fc.integer({ min: 1, max: 9 }) });

describe('Property 22: Telegraph 최소 시간', () => {
  it('warns ≥ 0.8 s (heavy) / ≥ 0.4 s (ordinary) before every damaging judgement of every enemy, Elite and Caelith attack, at any level', () => {
    expect(MIN_TELEGRAPH).toEqual({ normal: 0.4, strong: 0.8 }); // Req 28.9, 6.9
    const seenAttacks = new Set<string>();
    const seenLevels = new Set<number>();
    const seenStrengths = new Set<AttackStrength>();
    let comboHits = 0; // judgements after the first, checked against their own warning
    fc.assert(
      fc.property(arbPlacement, ({ owner, level }) => {
        seenLevels.add(level);
        for (const c of casesOf(owner)) {
          const min = MIN_TELEGRAPH[c.strength];
          // A clip's Telegraph itself lasts the minimum, and no damaging judgement comes before it ends.
          if (c.clip !== null) {
            expect(c.clip.telegraph, `${c.id} Telegraph`).toBeGreaterThanOrEqual(min - EPS);
            expect(c.clip.firstHit, `${c.id} first hit before its Telegraph ends`).toBeGreaterThanOrEqual(c.clip.telegraph - EPS);
          }
          c.warnings.forEach((w, i) => {
            expect(w, `${c.id} judgement ${i + 1} (L${level})`).toBeGreaterThanOrEqual(min - EPS);
          });
          seenAttacks.add(c.id);
          seenStrengths.add(c.strength);
          comboHits += c.warnings.length - 1;
        }
      }),
      { numRuns: 200, seed: 2201 },
    );
    // Guard against a vacuous pass: every damaging attack in the data (Caelith's with a strength, its clips and the
    // Shard_Crystal pulse included), every level 1–9, both strengths and multi-hit combos must have been checked.
    const expected = [...damaging(ENEMY_ATTACKS.map(enemyCase)), ...damaging(caelithCases())].map((c) => c.id);
    expect([...seenAttacks].sort()).toEqual([...new Set(expected)].sort());
    expect(expected).toEqual(expect.arrayContaining([
      'atk_caelith_slashCombo', 'atk_caelith_groundSlam', 'atk_caelith_sectorBlast', 'atk_caelith_astralSweep', 'shardCrystal pulse',
      // the encounter's runtime schedule of every damaging Caelith attack
      ...CAELITH_ATTACKS.filter((name) => BOSS_ATTACKS[name].strength !== null).map((name) => `atk_caelith_${name} schedule`),
    ]));
    expect(expected).not.toContain('atk_caelith_summonCrystals'); // strength null: no damage
    expect([...seenLevels].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...seenStrengths].sort()).toEqual(['normal', 'strong']);
    expect(comboHits).toBeGreaterThan(50);
  });
});
