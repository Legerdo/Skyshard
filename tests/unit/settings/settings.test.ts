import { describe, expect, it } from 'vitest';
import { REMAPPABLE_ACTIONS } from '../../../src/input/actions';
import { DEFAULT_BINDINGS, type Bindings } from '../../../src/input/bindings';
import { applySettings, connectSettings, uiScaleValue, type SettingsTargets } from '../../../src/settings/applySettings';
import { loadSettings, serializeSettings, settingsWriter } from '../../../src/settings/persistence';
import { parseSettings, sanitizeSettings, SETTINGS_RANGES } from '../../../src/settings/sanitizeSettings';
import {
  DEFAULT_SETTINGS,
  defaultSettings,
  isCustomQuality,
  QUALITY_PRESETS,
  SETTINGS_KEY,
  SettingsStore,
  type Settings,
} from '../../../src/settings/settings';

/** A valid, non-default Settings value: every field differs from its default. */
function customSettings(): Settings {
  return {
    musicOn: false,
    musicVolume: 0.25,
    sfxOn: false,
    sfxVolume: 0,
    qualityPreset: 'high',
    renderScale: 0.5,
    shadows: 'off',
    vegetation: 'high',
    postProcessing: false,
    mouseSensitivity: 3,
    invertY: true,
    shake: 0,
    uiScale: 1.3,
    bindings: { ...DEFAULT_BINDINGS, jump: 'KeyG', interact: 'Space' },
    showPerfOverlay: true,
  };
}

/** A Map-backed Storage stand-in that records writes; `fail` makes every setItem throw. */
function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  const store = {
    fail: false,
    data,
    writes,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      if (store.fail) throw new DOMException('quota', 'QuotaExceededError');
      writes.push([key, value]);
      data.set(key, value);
    },
  };
  return store;
}

describe('Settings data and defaults', () => {
  it('matches the design table (defaults, ranges, preset values)', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      musicOn: true,
      musicVolume: 0.7,
      sfxOn: true,
      sfxVolume: 0.8,
      qualityPreset: 'medium',
      renderScale: 1.0,
      shadows: 'low',
      vegetation: 'medium',
      postProcessing: true,
      mouseSensitivity: 1.0,
      invertY: false,
      shake: 1.0,
      uiScale: 1.0,
      bindings: DEFAULT_BINDINGS,
      showPerfOverlay: false,
    });
    expect(SETTINGS_RANGES).toEqual({
      musicVolume: { min: 0, max: 1 },
      sfxVolume: { min: 0, max: 1 },
      renderScale: { min: 0.5, max: 1.0 },
      mouseSensitivity: { min: 0.2, max: 3.0 },
      shake: { min: 0, max: 1 },
      uiScale: { min: 0.8, max: 1.3 },
    });
    expect(SETTINGS_KEY).toBe('skyshard.settings');
    // The defaults are the medium preset, so they do not read as "사용자 지정".
    expect(isCustomQuality(DEFAULT_SETTINGS)).toBe(false);
    const fresh = defaultSettings();
    expect(fresh).toEqual(DEFAULT_SETTINGS);
    expect(fresh).not.toBe(DEFAULT_SETTINGS);
    expect(fresh.bindings).not.toBe(DEFAULT_SETTINGS.bindings);
  });
});

describe('sanitizeSettings', () => {
  it('passes a valid Settings value through unchanged, as a fresh copy', () => {
    const valid = customSettings();
    const out = sanitizeSettings(valid);
    expect(out).toEqual(valid);
    expect(out).not.toBe(valid);
    expect(out.bindings).not.toBe(valid.bindings);
    expect(sanitizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    // Range ends are valid values.
    const ends = { ...valid, musicVolume: 1, sfxVolume: 0, renderScale: 1, mouseSensitivity: 0.2, shake: 1, uiScale: 0.8 };
    expect(sanitizeSettings(ends)).toEqual(ends);
  });

  it('gives the full defaults for anything that is not a settings object', () => {
    for (const raw of [undefined, null, 42, 'settings', true, [], [customSettings()]]) {
      expect(sanitizeSettings(raw), JSON.stringify(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('resets only the field with a wrong type, value out of range or unknown enum value (no clamping)', () => {
    const bad: [keyof Settings, unknown][] = [
      ['musicOn', 'yes'],
      ['musicOn', 1],
      ['musicVolume', 1.5],
      ['musicVolume', -0.1],
      ['musicVolume', '0.5'],
      ['musicVolume', Number.NaN],
      ['sfxOn', null],
      ['sfxVolume', Number.POSITIVE_INFINITY],
      ['qualityPreset', 'ultra'],
      ['qualityPreset', 2],
      ['renderScale', 0.4],
      ['renderScale', 1.01],
      ['shadows', 'medium'],
      ['vegetation', 'none'],
      ['postProcessing', 'false'],
      ['mouseSensitivity', 0.1],
      ['mouseSensitivity', 3.5],
      ['invertY', 0],
      ['shake', 2],
      ['shake', -1],
      ['uiScale', 0.7],
      ['uiScale', 1.31],
      ['showPerfOverlay', {}],
    ];
    for (const [field, value] of bad) {
      const valid = customSettings();
      const out = sanitizeSettings({ ...valid, [field]: value });
      expect(out, `${field} = ${String(value)}`).toEqual({ ...valid, [field]: DEFAULT_SETTINGS[field] });
    }
    // A missing field is defaulted alone as well.
    const { uiScale: _uiScale, ...missing } = customSettings();
    expect(sanitizeSettings(missing)).toEqual({ ...customSettings(), uiScale: 1.0 });
  });

  it('drops unknown fields', () => {
    const out = sanitizeSettings({ ...customSettings(), version: 3, fov: 90, __proto_like: { x: 1 } });
    expect(Object.keys(out)).toEqual(Object.keys(DEFAULT_SETTINGS));
    expect(out).toEqual(customSettings());
  });

  it('puts the whole DEFAULT_BINDINGS back for bad bindings, never a partial repair', () => {
    const custom: Bindings = { ...DEFAULT_BINDINGS, jump: 'KeyG', attack: 'KeyP' };
    const { quest: _quest, ...missingAction } = custom;
    const badBindings: unknown[] = [
      missingAction, // an action is missing
      { ...custom, dodge: 'KeyG' }, // not a bijection (jump and dodge share G)
      { ...custom, dodge: 'Escape' }, // fixed
      { ...custom, dodge: 'F5' }, // reserved browser key
      { ...custom, dodge: 'ArrowUp' }, // fixed camera / UI key
      { ...custom, dodge: 'Mouse1' }, // fixed Lock-on button
      { ...custom, dodge: 'Mouse3' }, // unknown
      { ...custom, dodge: 'Unidentified' }, // unknown
      { ...custom, dodge: 'PadA' }, // the gamepad layout is fixed
      { ...custom, dodge: 7 },
      'KeyW',
      [],
      null,
    ];
    for (const bindings of badBindings) {
      const out = sanitizeSettings({ ...customSettings(), bindings });
      expect(out.bindings, JSON.stringify(bindings)).toEqual(DEFAULT_BINDINGS);
      expect(out.bindings.jump).toBe('Space'); // the valid custom jump is not kept either
      expect({ ...out, bindings: null }).toEqual({ ...customSettings(), bindings: null }); // other fields kept
    }
    // Valid custom bindings survive, extra keys dropped.
    const kept = sanitizeSettings({ ...customSettings(), bindings: { ...custom, pause: 'KeyP' } });
    expect(kept.bindings).toEqual(custom);
    expect(Object.keys(kept.bindings)).toEqual([...REMAPPABLE_ACTIONS]);
  });

  it('parseSettings: no key or unreadable JSON gives the defaults, readable JSON is sanitized', () => {
    for (const text of [null, undefined, '', '{', 'not json', 'null', '[1, 2]', '"text"']) {
      expect(parseSettings(text), String(text)).toEqual(DEFAULT_SETTINGS);
    }
    expect(parseSettings(JSON.stringify(customSettings()))).toEqual(customSettings());
    expect(parseSettings(JSON.stringify({ ...customSettings(), musicVolume: 2 }))).toEqual({ ...customSettings(), musicVolume: 0.7 });
  });
});

describe('SettingsStore', () => {
  it('notifies only the fields that changed and skips no-op changes', () => {
    const store = new SettingsStore();
    const heard: string[][] = [];
    const unsubscribe = store.subscribe((_next, changed) => heard.push([...changed]));
    store.set({ musicVolume: 0.3, sfxVolume: 0.8 });
    store.set({ musicVolume: 0.3 });
    store.set({ bindings: { ...DEFAULT_BINDINGS } });
    store.set({ bindings: { ...DEFAULT_BINDINGS, jump: 'KeyG' } });
    expect(heard).toEqual([['musicVolume'], ['bindings']]);
    unsubscribe();
    store.set({ invertY: true });
    expect(heard).toHaveLength(2);
    expect(store.get().invertY).toBe(true);
  });

  it('applies a preset’s four fields together and reads a direct change as "사용자 지정"', () => {
    const store = new SettingsStore();
    store.set({ qualityPreset: 'low' });
    expect(store.get()).toMatchObject({ qualityPreset: 'low', ...QUALITY_PRESETS.low });
    expect(isCustomQuality(store.get())).toBe(false);
    store.set({ renderScale: 0.9 });
    expect(isCustomQuality(store.get())).toBe(true);
    expect(store.get().qualityPreset).toBe('low'); // particles and LOD keep following the preset
    // Picking the same preset again (the screen sends its fields too) clears "사용자 지정".
    store.set({ qualityPreset: 'low', ...QUALITY_PRESETS.low });
    expect(isCustomQuality(store.get())).toBe(false);
    // Fields given in the same patch win over the preset's values.
    store.set({ qualityPreset: 'high', shadows: 'low' });
    expect(store.get()).toMatchObject({ qualityPreset: 'high', renderScale: 1, shadows: 'low', vegetation: 'high' });
    expect(isCustomQuality(store.get())).toBe(true);
  });

  it('keeps and announces a change even when persisting it throws', () => {
    const store = new SettingsStore(DEFAULT_SETTINGS, () => {
      throw new Error('quota');
    });
    let heard = 0;
    store.subscribe(() => heard++);
    expect(() => store.set({ uiScale: 1.2 })).not.toThrow();
    expect([store.get().uiScale, heard]).toEqual([1.2, 1]);
  });

  it('copies its initial value', () => {
    const initial = customSettings();
    const store = new SettingsStore(initial);
    initial.bindings.jump = 'KeyH';
    expect(store.get().bindings.jump).toBe('KeyG');
  });
});

describe('settings persistence (skyshard.settings)', () => {
  it('writes the whole settings JSON on every change, and only on a change', () => {
    const storage = memoryStore();
    const store = new SettingsStore(loadSettings(storage), settingsWriter(storage));
    expect(storage.writes).toEqual([]); // loading writes nothing
    store.set({ musicVolume: 0.4 });
    store.set({ musicVolume: 0.4 });
    store.set({ bindings: { ...DEFAULT_BINDINGS, jump: 'KeyF', interact: 'Space' } });
    expect(storage.writes.map(([key]) => key)).toEqual([SETTINGS_KEY, SETTINGS_KEY]);
    expect(JSON.parse(storage.writes[0][1])).toMatchObject({ musicVolume: 0.4 });
    expect(storage.data.get(SETTINGS_KEY)).toBe(serializeSettings(store.get()));
    // The next boot restores exactly these settings.
    expect(loadSettings(storage)).toEqual(store.get());
    expect([...storage.data.keys()]).toEqual([SETTINGS_KEY]); // no save key is touched
  });

  it('serializes every field in a fixed order and round-trips through sanitizeSettings', () => {
    const text = serializeSettings(customSettings());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(Object.keys(DEFAULT_SETTINGS));
    expect(Object.keys(parsed.bindings as object)).toEqual([...REMAPPABLE_ACTIONS]);
    expect(parseSettings(text)).toEqual(customSettings());
  });

  it('boots with repaired settings from a damaged key and with defaults when the store fails', () => {
    expect(loadSettings(memoryStore({ [SETTINGS_KEY]: '{"musicVolume": 9, "sfxOn": false, "junk": 1}' }))).toEqual({
      ...DEFAULT_SETTINGS,
      sfxOn: false,
    });
    expect(loadSettings(memoryStore({ [SETTINGS_KEY]: '{"truncated' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    const throwing = {
      getItem: (): string | null => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps applying the value in memory when the write fails and reports the failure once', () => {
    const storage = memoryStore();
    storage.fail = true;
    const errors: unknown[] = [];
    const store = new SettingsStore(DEFAULT_SETTINGS, settingsWriter(storage, (error) => errors.push(error)));
    const heard: number[] = [];
    store.subscribe((next) => heard.push(next.shake));
    store.set({ shake: 0.5 });
    store.set({ shake: 0.25 });
    expect(store.get().shake).toBe(0.25);
    expect(heard).toEqual([0.5, 0.25]);
    expect(errors).toHaveLength(1);
    expect(storage.data.size).toBe(0);
    // Once the store works again, the next change is written.
    storage.fail = false;
    store.set({ shake: 0 });
    expect(parseSettings(storage.data.get(SETTINGS_KEY)).shake).toBe(0);
    // No store at all: nothing throws, the failure is reported.
    const missing: unknown[] = [];
    const orphan = new SettingsStore(DEFAULT_SETTINGS, settingsWriter(null, (error) => missing.push(error)));
    orphan.set({ invertY: true });
    expect([orphan.get().invertY, missing.length]).toEqual([true, 1]);
  });
});

describe('applySettings / connectSettings', () => {
  function fakeTargets() {
    const log: string[] = [];
    const targets: SettingsTargets = {
      input: {
        setBindings: (b) => log.push(`input.bindings jump=${b.jump}`),
        setLookOptions: (o) => log.push(`look ${o.sensitivity} ${o.invertY}`),
      },
      browserInput: { setBindings: (b) => log.push(`browser.bindings jump=${b.jump}`) },
      perf: { setVisible: (v) => log.push(`perf ${v}`) },
      root: { style: { setProperty: (name, value) => log.push(`${name}=${value}`) } },
    };
    return { log, targets };
  }

  it('applies everything on connect, then only the changed fields at once', () => {
    const store = new SettingsStore();
    const { log, targets } = fakeTargets();
    const disconnect = connectSettings(store, targets);
    expect(log.splice(0)).toEqual([
      'input.bindings jump=Space',
      'browser.bindings jump=Space',
      'look 1 false',
      '--ui-scale=1',
      'perf false',
    ]);
    store.set({ uiScale: 1.25 });
    store.set({ invertY: true });
    store.set({ mouseSensitivity: 2.5 });
    store.set({ showPerfOverlay: true });
    store.set({ bindings: { ...DEFAULT_BINDINGS, jump: 'KeyG' } });
    store.set({ musicVolume: 0.1 }); // audio subscribes on its own; nothing here
    expect(log.splice(0)).toEqual([
      '--ui-scale=1.25',
      'look 1 true',
      'look 2.5 true',
      'perf true',
      'input.bindings jump=KeyG',
      'browser.bindings jump=KeyG',
    ]);
    disconnect();
    store.set({ uiScale: 0.8 });
    expect(log).toEqual([]);
  });

  it('writes --ui-scale as a short number and works without the optional targets', () => {
    expect([uiScaleValue(0.8), uiScaleValue(1.3), uiScaleValue(1.0500000001), uiScaleValue(1.15)]).toEqual(['0.8', '1.3', '1.05', '1.15']);
    const calls: string[] = [];
    applySettings(customSettings(), {
      input: { setBindings: () => calls.push('bindings'), setLookOptions: (o) => calls.push(`look ${o.sensitivity} ${o.invertY}`) },
    });
    expect(calls).toEqual(['bindings', 'look 3 true']);
  });
});
