import { describe, expect, it, vi } from 'vitest';
import { serializeSave, stateChecksum } from '../../../src/logic/save/envelope';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { MemoryStore } from '../../../src/logic/save/keyValueStore';
import { loadSave, MAX_QUARANTINE, passesLoadChecks, readSaveDocument } from '../../../src/logic/save/load';
import { sanitizeGameState } from '../../../src/logic/save/sanitize';
import { SAVE_KEYS } from '../../../src/logic/save/saveKeys';
import { validateGameState } from '../../../src/logic/save/validate';

// Load pipeline and repair rules (task 15.1, Req 36.1, 36.9–36.12).

const SEED = 20240601;
const fresh = (): GameState => createNewGameState(SEED);
const envelopeOf = (state: unknown, version = 1): string =>
  JSON.stringify({ format: 'skyshard-save', version, savedAt: '2026-01-01T00:00:00.000Z', playTimeSec: 5, checksum: stateChecksum(state), state });
const storeWith = (main?: string, backup?: string): MemoryStore => {
  const s = new MemoryStore();
  if (main !== undefined) s.setItem(SAVE_KEYS.main, main);
  if (backup !== undefined) s.setItem(SAVE_KEYS.backup, backup);
  return s;
};

describe('loadSave', () => {
  it('no main key: none (Continue disabled), even with a backup', () => {
    expect(loadSave(new MemoryStore()).kind).toBe('none');
    expect(loadSave(storeWith(undefined, serializeSave(fresh(), 1))).kind).toBe('none');
  });

  it('a valid save loads from main with no repairs', () => {
    const gs = fresh();
    const r = loadSave(storeWith(serializeSave(gs, 12)));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.source).toBe('main');
      expect(r.repairs).toEqual([]);
      expect(r.state).toEqual(sanitizeGameState(gs).state);
    }
  });

  it.each([
    ['broken JSON', '{"format": "skyshard-save", '],
    ['truncated file', serializeSave(fresh(), 3).slice(0, 200)],
    ['wrong checksum', serializeSave(fresh(), 3).replace(/"checksum":"[0-9a-f]{8}"/, '"checksum":"00000000"')],
    ['version 0', envelopeOf(fresh(), 0)],
    ['future version', envelopeOf(fresh(), 99)],
    ['fractional version', envelopeOf(fresh(), 1.5)],
    ['wrong format', JSON.stringify({ ...JSON.parse(serializeSave(fresh(), 3)), format: 'other' })],
    ['state not an object', JSON.stringify({ format: 'skyshard-save', version: 1, savedAt: '', playTimeSec: 0, checksum: stateChecksum([]), state: [] })],
  ])('%s: falls back to a readable backup', (_name, main) => {
    const backupState = fresh();
    backupState.inventory.glim = 777;
    const r = loadSave(storeWith(main, serializeSave(backupState, 9)));
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.source).toBe('backup');
      expect(r.state.inventory.glim).toBe(777);
    }
  });

  it('main and backup unreadable: quarantined copy, main cleared, unrecoverable; at most 3 copies kept', () => {
    const store = storeWith('garbage-1', 'also garbage');
    let now = 1000;
    const r = loadSave(store, { now: () => now });
    expect(r).toEqual({ kind: 'unrecoverable', quarantinedKey: `${SAVE_KEYS.corruptPrefix}1000` });
    expect(store.getItem(`${SAVE_KEYS.corruptPrefix}1000`)).toBe('garbage-1');
    expect(store.getItem(SAVE_KEYS.main)).toBeNull();
    for (let i = 2; i <= 5; i++) {
      now += 1000;
      store.setItem(SAVE_KEYS.main, `garbage-${i}`);
      loadSave(store, { now: () => now });
    }
    const copies = store.keys().filter((k) => k.startsWith(SAVE_KEYS.corruptPrefix)).sort();
    expect(copies).toHaveLength(MAX_QUARANTINE);
    expect(copies[0]).toBe(`${SAVE_KEYS.corruptPrefix}3000`);
    expect(store.getItem(SAVE_KEYS.backup)).toBe('also garbage'); // the backup is left alone
  });

  it('never throws on a store that throws', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {}, key: () => null, length: 0 };
    expect(() => loadSave(bad)).not.toThrow();
    expect(loadSave(bad).kind).toBe('none');
  });

  it('out-of-range fields with a matching checksum are repaired (one warning) and load', () => {
    const gs = fresh() as unknown as Record<string, unknown> & GameState;
    const raw = structuredClone(gs) as unknown as Record<string, any>;
    raw.inventory.items.con_herbDumpling = 14;
    raw.inventory.items.con_madeUp = 3;
    raw.inventory.glim = -50;
    raw.party.level = 42;
    raw.party.xp = -1;
    raw.skyshards = 3; // the quest is at ms1
    raw.world.puzzles = ['pz_verdant_1', 'pz_nowhere_9'];
    raw.lastSafe = { pos: [Number.NaN, 0, 0], yaw: 0 };
    const warn = vi.fn();
    const r = loadSave(storeWith(envelopeOf(JSON.parse(JSON.stringify(raw)))), { warn });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.state.inventory.items.con_herbDumpling).toBe(10);
    expect(r.state.inventory.items).not.toHaveProperty('con_madeUp');
    expect(r.state.inventory.glim).toBe(0);
    expect(r.state.party.level).toBe(10);
    expect(r.state.party.xp).toBe(3000);
    expect(r.state.skyshards).toBe(0);
    expect(r.state.world.puzzles).toEqual(['pz_verdant_1']);
    expect(r.state.lastSafe).toEqual({ pos: [-246, expect.any(Number), expect.any(Number)], yaw: expect.any(Number) });
    expect(r.repairs).toContain('inventory.con_herbDumpling: 14 → 10');
    expect(validateGameState(r.state)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('passesLoadChecks accepts only documents the loader reads', () => {
    expect(passesLoadChecks(serializeSave(fresh(), 1))).toBe(true);
    expect(passesLoadChecks('{}')).toBe(false);
    expect(passesLoadChecks(null)).toBe(false);
    expect(readSaveDocument('nope').ok).toBe(false);
  });
});
