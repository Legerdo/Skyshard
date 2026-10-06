/*
 * Settings persistence (design "저장과 보정", Req 38.2; task 14.4): the settings live apart from progress under
 * `skyshard.settings` (SETTINGS_KEY) as JSON. Boot reads and repairs them with `sanitizeSettings`; every change is
 * written at once. A store that throws (quota, privacy mode) never blocks a change: memory keeps the value and the
 * failure is reported once. Settings never read or write GameState, so loading, deleting or starting a game leaves
 * them alone. The store is injected (localStorage or the page's in-memory fallback).
 */
import { REMAPPABLE_ACTIONS } from '../input/actions';
import { SETTINGS_KEY, type Settings } from './settings';
import { parseSettings } from './sanitizeSettings';

export type SettingsReader = Pick<Storage, 'getItem'>;
export type SettingsWriterStore = Pick<Storage, 'setItem'>;

/** The stored settings, repaired; defaults when the store is missing, empty, unreadable or throws. */
export function loadSettings(store: SettingsReader | null | undefined): Settings {
  let text: string | null = null;
  try {
    text = store?.getItem(SETTINGS_KEY) ?? null;
  } catch {
    text = null;
  }
  return parseSettings(text);
}

/** JSON of `s` with the fields in a fixed order (bindings in action order). */
export function serializeSettings(s: Readonly<Settings>): string {
  const bindings: Record<string, string> = {};
  for (const action of REMAPPABLE_ACTIONS) bindings[action] = s.bindings[action];
  const out: Record<keyof Settings, unknown> = {
    musicOn: s.musicOn,
    musicVolume: s.musicVolume,
    sfxOn: s.sfxOn,
    sfxVolume: s.sfxVolume,
    qualityPreset: s.qualityPreset,
    renderScale: s.renderScale,
    shadows: s.shadows,
    vegetation: s.vegetation,
    postProcessing: s.postProcessing,
    mouseSensitivity: s.mouseSensitivity,
    invertY: s.invertY,
    shake: s.shake,
    uiScale: s.uiScale,
    bindings,
    showPerfOverlay: s.showPerfOverlay,
  };
  return JSON.stringify(out);
}

/**
 * The `persist` callback of SettingsStore: writes each new value to `skyshard.settings`. Failures are swallowed
 * (the in-memory value stays in effect) and `onError` hears about the first one.
 */
export function settingsWriter(
  store: SettingsWriterStore | null | undefined,
  onError?: (error: unknown) => void,
): (s: Readonly<Settings>) => void {
  let reported = false;
  return (s) => {
    try {
      if (store === null || store === undefined) throw new Error('no settings store');
      store.setItem(SETTINGS_KEY, serializeSettings(s));
    } catch (error) {
      if (!reported) {
        reported = true;
        onError?.(error);
      }
    }
  };
}
