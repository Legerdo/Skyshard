/*
 * Value rules of the custom controls (task 14.1): slider stepping and snapping, and the ratio a slider draws.
 * Pure, so they are unit-tested without a DOM.
 */

export interface SliderRange {
  readonly min: number;
  readonly max: number;
  /** > 0. */
  readonly step: number;
}

/** `value` clamped to the range and snapped to the step grid from `min` (float noise removed). */
export function snapValue(value: number, range: SliderRange): number {
  const { min, max, step } = range;
  if (!Number.isFinite(value)) return min;
  const clamped = Math.min(max, Math.max(min, value));
  const steps = Math.round((clamped - min) / step);
  const snapped = Math.min(max, min + steps * step);
  return Number(snapped.toFixed(6));
}

/** One step down (-1) or up (+1), within the range. */
export function stepValue(value: number, direction: -1 | 1, range: SliderRange): number {
  return snapValue(snapValue(value, range) + direction * range.step, range);
}

/** Position of `value` in the range, 0–1. */
export function valueRatio(value: number, range: SliderRange): number {
  if (range.max <= range.min) return 0;
  return Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
}

/** The value at `ratio` (0–1) of the track, snapped. */
export function valueAtRatio(ratio: number, range: SliderRange): number {
  return snapValue(range.min + Math.min(1, Math.max(0, ratio)) * (range.max - range.min), range);
}

/** Percentage text for 0–1 values: 0.7 → "70%". */
export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
