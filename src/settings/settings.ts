/*
 * Settings contract (design.md "Settings 데이터와 기본값", Req 35.3, 35.8, 37.5, 38.1, 38.2): the player's options,
 * kept apart from GameState under the localStorage key `skyshard.settings`. This file fixes the shape, the defaults
 * and the change-notification API so the Audio, Render, Camera, Input and UI systems can depend on it; persistence,
 * `sanitizeSettings` and the Settings screen live next to it (task 14.4).
 *
 * Consumers subscribe once and apply each change within its budget: audio 0.1 s, graphics 1 s without a restart,
 * controls / accessibility at once.
 */
import { DEFAULT_BINDINGS, type Bindings } from '../input/bindings';

export type QualityPreset = 'low' | 'medium' | 'high';
export type ShadowQuality = 'off' | 'low' | 'high';
export type VegetationQuality = 'low' | 'medium' | 'high';

export interface Settings {
  musicOn: boolean;
  /** 0–1. */
  musicVolume: number;
  sfxOn: boolean;
  /** 0–1. */
  sfxVolume: number;
  qualityPreset: QualityPreset;
  /** 0.5–1.0. */
  renderScale: number;
  shadows: ShadowQuality;
  vegetation: VegetationQuality;
  postProcessing: boolean;
  /** 0.2–3.0. */
  mouseSensitivity: number;
  invertY: boolean;
  /** Camera shake strength 0–1 (UI 0–100 %). */
  shake: number;
  /** 0.8–1.3. */
  uiScale: number;
  bindings: Bindings;
  showPerfOverlay: boolean;
}

/** Graphics fields a preset sets together (design "품질 프리셋"). */
export type PresetFields = Pick<Settings, 'renderScale' | 'shadows' | 'vegetation' | 'postProcessing'>;

export const QUALITY_PRESETS: Readonly<Record<QualityPreset, Readonly<PresetFields>>> = {
  low: { renderScale: 0.75, shadows: 'off', vegetation: 'low', postProcessing: false },
  medium: { renderScale: 1.0, shadows: 'low', vegetation: 'medium', postProcessing: true },
  high: { renderScale: 1.0, shadows: 'high', vegetation: 'high', postProcessing: true },
};

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
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
  bindings: { ...DEFAULT_BINDINGS },
  showPerfOverlay: false,
});

/** localStorage key of the settings JSON. */
export const SETTINGS_KEY = 'skyshard.settings';

/** A fresh, independent copy of the defaults. */
export function defaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_SETTINGS.bindings } };
}

/** "사용자 지정": any of the four preset fields differs from the chosen preset's values. */
export function isCustomQuality(s: Readonly<Settings>): boolean {
  const p = QUALITY_PRESETS[s.qualityPreset];
  return s.renderScale !== p.renderScale || s.shadows !== p.shadows || s.vegetation !== p.vegetation || s.postProcessing !== p.postProcessing;
}

export type SettingsListener = (next: Readonly<Settings>, changed: ReadonlySet<keyof Settings>) => void;

/**
 * In-memory settings with change notification. `persist` (optional) is called after every change with the new
 * value, e.g. the localStorage writer of task 14.4; a failing writer never blocks the change (Req 38.2).
 */
export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<SettingsListener>();
  private readonly persist: ((s: Readonly<Settings>) => void) | undefined;

  constructor(initial: Readonly<Settings> = DEFAULT_SETTINGS, persist?: (s: Readonly<Settings>) => void) {
    this.value = { ...initial, bindings: { ...initial.bindings } };
    this.persist = persist;
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  /** Applies `patch`; listeners hear only the fields that really changed. Choosing a preset sets its four fields. */
  set(patch: Partial<Settings>): void {
    const next: Settings = { ...this.value, ...patch, bindings: { ...(patch.bindings ?? this.value.bindings) } };
    if (patch.qualityPreset !== undefined && patch.qualityPreset !== this.value.qualityPreset) {
      Object.assign(next, QUALITY_PRESETS[patch.qualityPreset], pickPresetOverrides(patch));
    }
    const changed = new Set<keyof Settings>();
    for (const key of Object.keys(next) as (keyof Settings)[]) {
      if (key === 'bindings') {
        if (JSON.stringify(next.bindings) !== JSON.stringify(this.value.bindings)) changed.add(key);
      } else if (next[key] !== this.value[key]) changed.add(key);
    }
    if (changed.size === 0) return;
    this.value = next;
    try {
      this.persist?.(next);
    } catch {
      // Memory keeps the value (Req 38.2).
    }
    for (const listener of [...this.listeners]) listener(next, changed);
  }

  /** Calls `listener` on every change; returns the unsubscribe function. */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Preset fields given explicitly in the same patch win over the preset's values. */
function pickPresetOverrides(patch: Partial<Settings>): Partial<PresetFields> {
  const out: Partial<PresetFields> = {};
  if (patch.renderScale !== undefined) out.renderScale = patch.renderScale;
  if (patch.shadows !== undefined) out.shadows = patch.shadows;
  if (patch.vegetation !== undefined) out.vegetation = patch.vegetation;
  if (patch.postProcessing !== undefined) out.postProcessing = patch.postProcessing;
  return out;
}
