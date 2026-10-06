// Feature: skyshard-echoes-of-the-wild, Property 2: 불러오기의 전체성과 백업 복구
/*
 * Validates: Requirements 36.10, 36.12. For stores whose main and backup keys each hold an arbitrary string, an arbitrary
 * JSON value, truncated JSON, an envelope with damaged fields, a valid envelope or nothing, loadSave never throws and
 * returns 'ok' / 'none' / 'unrecoverable'; an 'ok' state passes validateGameState; an unreadable main with a valid
 * backup envelope loads from the backup.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serializeSave, stateChecksum } from '../../src/logic/save/envelope';
import { MemoryStore } from '../../src/logic/save/keyValueStore';
import { loadSave, readSaveDocument } from '../../src/logic/save/load';
import { SAVE_KEYS } from '../../src/logic/save/saveKeys';
import { validateGameState } from '../../src/logic/save/validate';
import { arbDamagedState, arbGameState, arbJsonValue, withDamage } from './generators/gameState';

type Slot = { kind: 'empty' } | { kind: 'text'; text: string } | { kind: 'valid'; text: string };

const envelopeFields = ['format', 'version', 'savedAt', 'playTimeSec', 'checksum', 'state'] as const;

const arbSlot: fc.Arbitrary<Slot> = fc.oneof(
  fc.constant<Slot>({ kind: 'empty' }),
  fc.string({ maxLength: 40 }).map((text): Slot => ({ kind: 'text', text })),
  arbJsonValue.map((v): Slot => ({ kind: 'text', text: JSON.stringify(v) ?? 'null' })),
  // Truncated JSON of a real envelope.
  fc.tuple(arbGameState, fc.double({ min: 0, max: 0.999, noNaN: true })).map(([s, cut]): Slot => {
    const text = serializeSave(s, 10);
    return { kind: 'text', text: text.slice(0, Math.floor(text.length * cut)) };
  }),
  // A real envelope with one envelope field replaced.
  fc.tuple(arbGameState, fc.constantFrom(...envelopeFields), arbJsonValue).map(([s, key, value]): Slot => {
    const env = JSON.parse(serializeSave(s, 10)) as Record<string, unknown>;
    return { kind: 'text', text: JSON.stringify(withDamage(env, [key], value)) };
  }),
  // A damaged state inside an envelope whose checksum matches (sanitize has to repair it).
  arbDamagedState.map((state): Slot => {
    const json = JSON.parse(JSON.stringify(state ?? null)) as unknown;
    return { kind: 'text', text: JSON.stringify({ format: 'skyshard-save', version: 1, savedAt: '', playTimeSec: 0, checksum: stateChecksum(json), state: json }) };
  }),
  arbGameState.map((s): Slot => ({ kind: 'valid', text: serializeSave(s, 42) })),
);

describe('Property 2: load totality and backup recovery', () => {
  it('loadSave never throws, returns one of the three results and an ok state is valid', () => {
    fc.assert(
      fc.property(arbSlot, arbSlot, (main, backup) => {
        const store = new MemoryStore();
        if (main.kind !== 'empty') store.setItem(SAVE_KEYS.main, main.text);
        if (backup.kind !== 'empty') store.setItem(SAVE_KEYS.backup, backup.text);
        let result: ReturnType<typeof loadSave> | undefined;
        expect(() => {
          result = loadSave(store, { now: () => 1_000 });
        }).not.toThrow();
        expect(['ok', 'none', 'unrecoverable']).toContain(result?.kind);
        if (result?.kind === 'ok') expect(validateGameState(result.state)).toEqual([]);
        if (main.kind === 'empty' || (main.kind === 'text' && main.text === '')) expect(result?.kind).toBe('none');
        const mainReadable = main.kind !== 'empty' && readSaveDocument(main.text).ok;
        if (main.kind !== 'empty' && main.text !== '' && !mainReadable && backup.kind === 'valid') {
          expect(result?.kind).toBe('ok');
          if (result?.kind === 'ok') expect(result.source).toBe('backup');
        }
      }),
      { numRuns: 200 },
    );
  });
});
