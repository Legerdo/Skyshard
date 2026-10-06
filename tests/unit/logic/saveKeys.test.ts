import { describe, expect, it } from 'vitest';
import { hasSaveData, SAVE_KEYS, type SaveProbe } from '../../../src/logic/save/saveKeys';

const store = (entries: Record<string, string>): SaveProbe => ({ getItem: (key) => entries[key] ?? null });

describe('hasSaveData (Title Continue, Req 31.3)', () => {
  it('uses the design storage keys', () => {
    expect(SAVE_KEYS).toEqual({
      main: 'skyshard.save',
      backup: 'skyshard.save.bak',
      corruptPrefix: 'skyshard.save.corrupt.',
      settings: 'skyshard.settings',
    });
  });

  it('is true only when the main save key holds data', () => {
    expect(hasSaveData(store({ 'skyshard.save': '{"format":"skyshard-save"}' }))).toBe(true);
    expect(hasSaveData(store({}))).toBe(false);
    expect(hasSaveData(store({ 'skyshard.save': '' }))).toBe(false);
    // Only the main key counts, like loadSave's `none` result; settings and backups alone are not a save.
    expect(hasSaveData(store({ 'skyshard.settings': '{}', 'skyshard.save.bak': '{}' }))).toBe(false);
  });

  it('treats a missing or throwing storage as no save data', () => {
    expect(hasSaveData(null)).toBe(false);
    expect(
      hasSaveData({
        getItem: () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBe(false);
  });
});
