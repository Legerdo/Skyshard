/*
 * Applies Settings to the page's systems (design "Settings 데이터와 기본값" 적용 열; task 14.4). Controls and
 * accessibility take effect at once: bindings → the input code map (InputState actions and the BrowserInput
 * preventDefault policy; prompts and Tutorial_Hint key icons read the new bindings on their next frame),
 * mouseSensitivity / invertY → mouse and right-stick look, uiScale → the `--ui-scale` CSS variable,
 * showPerfOverlay → the F3 panel. Camera shake reads `Settings.shake` every frame. Audio and graphics subscribe to
 * the same SettingsStore themselves (0.1 s / 1 s budgets).
 */
import type { Bindings } from '../input/bindings';
import type { LookOptions } from '../input/inputState';
import type { Settings, SettingsStore } from './settings';

export interface SettingsTargets {
  input: { setBindings(b: Readonly<Bindings>): void; setLookOptions(o: LookOptions): void };
  browserInput?: { setBindings(b: Readonly<Bindings>): void };
  perf?: { setVisible(visible: boolean): void };
  /** Usually `document.documentElement`. */
  root?: { style: { setProperty(name: string, value: string): void } };
}

/** `--ui-scale` value of a UI scale (0.8–1.3). */
export function uiScaleValue(scale: number): string {
  return String(Math.round(scale * 1000) / 1000);
}

/** Applies `s` (only the fields in `changed`, or all of them). */
export function applySettings(s: Readonly<Settings>, targets: SettingsTargets, changed?: ReadonlySet<keyof Settings>): void {
  const has = (key: keyof Settings): boolean => changed === undefined || changed.has(key);
  if (has('bindings')) {
    targets.input.setBindings(s.bindings);
    targets.browserInput?.setBindings(s.bindings);
  }
  if (has('mouseSensitivity') || has('invertY')) {
    targets.input.setLookOptions({ sensitivity: s.mouseSensitivity, invertY: s.invertY });
  }
  if (has('uiScale')) targets.root?.style.setProperty('--ui-scale', uiScaleValue(s.uiScale));
  if (has('showPerfOverlay')) targets.perf?.setVisible(s.showPerfOverlay);
}

/** Applies the store's current value now and every later change; returns the unsubscribe function. */
export function connectSettings(store: SettingsStore, targets: SettingsTargets): () => void {
  applySettings(store.get(), targets);
  return store.subscribe((next, changed) => applySettings(next, targets, changed));
}
