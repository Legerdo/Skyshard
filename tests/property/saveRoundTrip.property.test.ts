// Feature: skyshard-echoes-of-the-wild, Property 1: 저장 데이터 round-trip
/*
 * Validates: Requirements 36.9, 36.1. For any valid GameState s and play time t ≥ 0,
 * sanitizeGameState(JSON.parse(serializeSave(s, t)).state) is s (deep-equal) with no repairs, and loadSave over a store
 * holding serializeSave(s, t) under the main key returns ok / main / no repairs with a state deep-equal to s.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serializeSave } from '../../src/logic/save/envelope';
import { MemoryStore } from '../../src/logic/save/keyValueStore';
import { loadSave } from '../../src/logic/save/load';
import { sanitizeGameState } from '../../src/logic/save/sanitize';
import { SAVE_KEYS } from '../../src/logic/save/saveKeys';
import { validateGameState } from '../../src/logic/save/validate';
import { arbGameState } from './generators/gameState';

const arbPlayTime = fc.double({ min: 0, max: 1e6, noNaN: true }).map((v) => v + 0);

describe('Property 1: save data round-trip', () => {
  it('the generator only makes valid states', () => {
    fc.assert(
      fc.property(arbGameState, (s) => {
        expect(validateGameState(s)).toEqual([]);
        expect(sanitizeGameState(s).repairs).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('serialize → parse → sanitize and loadSave both give back the same state with no repairs', () => {
    fc.assert(
      fc.property(arbGameState, arbPlayTime, (s, t) => {
        const text = serializeSave(s, t);
        const direct = sanitizeGameState((JSON.parse(text) as { state: unknown }).state);
        expect(direct.repairs).toEqual([]);
        expect(direct.state).toEqual(s);

        const store = new MemoryStore();
        store.setItem(SAVE_KEYS.main, text);
        const loaded = loadSave(store);
        expect(loaded.kind).toBe('ok');
        if (loaded.kind !== 'ok') return;
        expect(loaded.source).toBe('main');
        expect(loaded.repairs).toEqual([]);
        expect(loaded.state).toEqual(s);
      }),
      { numRuns: 200 },
    );
  });
});
