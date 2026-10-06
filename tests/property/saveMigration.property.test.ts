// Feature: skyshard-echoes-of-the-wild, Property 4: 버전 마이그레이션의 보존성
/*
 * Validates: Requirements 36.11. For a valid save of a version v below the current one, migrate(raw, v) does not throw
 * and gives a current-schema value: sanitizing it makes no repairs, it passes validateGameState, and the Skyshard count,
 * quest stages and level are the original ones.
 *
 * SAVE_VERSION is 1, the first released schema, so the real MIGRATIONS table has no step yet and every real legacy
 * version set is empty (checked below). The chain itself is exercised with a representative legacy layout ("version 1"
 * of a table whose target is 2: renamed and nested fields, a list where a set is now) and its migration step, run
 * through the same migrate() and readSaveDocument() the loader uses.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stateChecksum } from '../../src/logic/save/envelope';
import { SAVE_VERSION, type GameState } from '../../src/logic/save/gameState';
import { readSaveDocument } from '../../src/logic/save/load';
import { migrate, MIGRATIONS, type Migration } from '../../src/logic/save/migrate';
import { sanitizeGameState } from '../../src/logic/save/sanitize';
import { validateGameState } from '../../src/logic/save/validate';
import { arbGameState } from './generators/gameState';

/** A legacy layout: `skyshardCount`, `progress.{level,xp}`, `questLog` for quests, `money` for Glim. */
function toLegacy(s: GameState): Record<string, unknown> {
  const { skyshards, quests, party, inventory, ...rest } = structuredClone(s);
  const { level, xp, ...partyRest } = party;
  const { glim, ...inventoryRest } = inventory;
  return { ...rest, skyshardCount: skyshards, questLog: quests, progress: { level, xp }, party: partyRest, inventory: { ...inventoryRest, money: glim } };
}

const legacyToCurrent: Migration = (old) => {
  const o = old as Record<string, unknown> & {
    skyshardCount: number; questLog: unknown; progress: { level: number; xp: number }; party: Record<string, unknown>;
    inventory: Record<string, unknown> & { money: number };
  };
  const { skyshardCount, questLog, progress, party, inventory, ...rest } = o;
  const { money, ...inv } = inventory;
  return { ...rest, skyshards: skyshardCount, quests: questLog, party: { ...party, level: progress.level, xp: progress.xp }, inventory: { ...inv, glim: money } };
};

const FIXTURE_TABLE: Readonly<Record<number, Migration>> = { 1: legacyToCurrent };
const FIXTURE_TARGET = 2;

describe('Property 4: version migration preserves progress', () => {
  it('the real table has a step for every version below SAVE_VERSION', () => {
    for (let v = 1; v < SAVE_VERSION; v++) expect(typeof MIGRATIONS[v]).toBe('function');
  });

  it('migrating a legacy save keeps Skyshards, quest stages and level, and needs no repairs', () => {
    fc.assert(
      fc.property(arbGameState, (s) => {
        const legacy = toLegacy(s);
        let migrated: unknown;
        expect(() => {
          migrated = migrate(legacy, 1, FIXTURE_TABLE, FIXTURE_TARGET);
        }).not.toThrow();
        const { state, repairs } = sanitizeGameState(migrated);
        expect(repairs).toEqual([]);
        expect(validateGameState(state)).toEqual([]);
        expect(state.skyshards).toBe(s.skyshards);
        expect(state.quests.main).toEqual(s.quests.main);
        expect(state.quests.side).toEqual(s.quests.side);
        expect(state.party.level).toBe(s.party.level);

        // The loader takes the same path for an older envelope version.
        const env = JSON.stringify({ format: 'skyshard-save', version: 1, savedAt: '', playTimeSec: 0, checksum: stateChecksum(legacy), state: legacy });
        const read = readSaveDocument(env, { migrations: FIXTURE_TABLE, version: FIXTURE_TARGET });
        expect(read.ok).toBe(true);
        if (read.ok) expect(read.state).toEqual(state);
      }),
      { numRuns: 200 },
    );
  });

  it('a missing step or a throwing step makes migrate throw (loadSave treats it as corrupt)', () => {
    expect(() => migrate({}, 1, {}, 2)).toThrow();
    expect(() => migrate({}, 1, { 1: () => { throw new Error('bad'); } }, 2)).toThrow();
    expect(() => migrate({}, 0)).toThrow();
    expect(() => migrate({}, 1.5)).toThrow();
  });
});
