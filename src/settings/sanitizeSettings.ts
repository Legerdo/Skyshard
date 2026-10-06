/*
 * Settings repair at boot (design "저장과 보정", Req 38.2, 35.3; task 14.4). Pure, like the save's sanitizer:
 * - not an object (missing key, JSON parse failure, array, ...) → every field at its default;
 * - a field of the wrong type, out of range or not one of its values → that field alone at its default (no clamping,
 *   so a broken value never turns into a surprising one);
 * - unknown fields are dropped;
 * - `bindings` missing an action, not a bijection, or holding a reserved / fixed / unknown code → `DEFAULT_BINDINGS`
 *   as a whole, never a partial repair.
 * A valid Settings object passes through unchanged (as a fresh copy).
 */
import { sanitizeBindings } from '../input/bindings';
import { defaultSettings, type QualityPreset, type Settings, type ShadowQuality, type VegetationQuality } from './settings';

/** Numeric ranges of the Settings fields (design "Settings 데이터와 기본값"). */
export const SETTINGS_RANGES = {
  musicVolume: { min: 0, max: 1 },
  sfxVolume: { min: 0, max: 1 },
  renderScale: { min: 0.5, max: 1.0 },
  mouseSensitivity: { min: 0.2, max: 3.0 },
  shake: { min: 0, max: 1 },
  uiScale: { min: 0.8, max: 1.3 },
} as const satisfies Partial<Record<keyof Settings, { min: number; max: number }>>;

export const QUALITY_PRESET_VALUES: readonly QualityPreset[] = ['low', 'medium', 'high'];
export const SHADOW_VALUES: readonly ShadowQuality[] = ['off', 'low', 'high'];
export const VEGETATION_VALUES: readonly VegetationQuality[] = ['low', 'medium', 'high'];

type NumericField = keyof typeof SETTINGS_RANGES;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function inRange(value: unknown, field: NumericField, fallback: number): number {
  const { min, max } = SETTINGS_RANGES[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function oneOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A complete, valid Settings object built from anything (`JSON.parse` output, an old version, garbage). */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  return {
    musicOn: bool(r.musicOn, d.musicOn),
    musicVolume: inRange(r.musicVolume, 'musicVolume', d.musicVolume),
    sfxOn: bool(r.sfxOn, d.sfxOn),
    sfxVolume: inRange(r.sfxVolume, 'sfxVolume', d.sfxVolume),
    qualityPreset: oneOf(r.qualityPreset, QUALITY_PRESET_VALUES, d.qualityPreset),
    renderScale: inRange(r.renderScale, 'renderScale', d.renderScale),
    shadows: oneOf(r.shadows, SHADOW_VALUES, d.shadows),
    vegetation: oneOf(r.vegetation, VEGETATION_VALUES, d.vegetation),
    postProcessing: bool(r.postProcessing, d.postProcessing),
    mouseSensitivity: inRange(r.mouseSensitivity, 'mouseSensitivity', d.mouseSensitivity),
    invertY: bool(r.invertY, d.invertY),
    shake: inRange(r.shake, 'shake', d.shake),
    uiScale: inRange(r.uiScale, 'uiScale', d.uiScale),
    bindings: sanitizeBindings(r.bindings),
    showPerfOverlay: bool(r.showPerfOverlay, d.showPerfOverlay),
  };
}

/** Settings from the stored JSON text; null (no key) or unparsable text gives the defaults. */
export function parseSettings(text: string | null | undefined): Settings {
  if (typeof text !== 'string' || text === '') return defaultSettings();
  try {
    return sanitizeSettings(JSON.parse(text) as unknown);
  } catch {
    return defaultSettings();
  }
}
