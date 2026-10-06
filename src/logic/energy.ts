// Energy gain, Burst readiness and Skill cooldown readiness (design "Energy·Cooldown·Dodge"; Req 24.4–24.7). Pure.
// Energy goes to the Active_Character at the moment of the event; `max` is the Burst cost. Cooldowns are remaining
// sim seconds, counted down every tick for every character (standby ones too, Req 23.8).

import { clamp } from '../core/math';

export type EnergyEventKind = 'normalHit' | 'chargedHit' | 'skillCastHit' | 'reaction' | 'perfectDodge';

/** Energy per event; 'skillCastHit' is once per Skill cast that hits an enemy. */
export const ENERGY_GAINS: Readonly<Record<EnergyEventKind, number>> = {
  normalHit: 1,
  chargedHit: 3,
  skillCastHit: 6,
  reaction: 5,
  perfectDodge: 10,
};

export function energyGain(kind: EnergyEventKind): number {
  return ENERGY_GAINS[kind];
}

/**
 * current + gain, clamped to [0, max]. A non-finite gain leaves `current` unchanged; a non-finite
 * `current` counts as 0 and a non-finite or negative `max` as 0.
 */
export function addEnergy(current: number, max: number, gain: number): number {
  const cap = Number.isFinite(max) ? Math.max(0, max) : 0;
  const cur = clamp(Number.isFinite(current) ? current : 0, 0, cap);
  return Number.isFinite(gain) ? clamp(cur + gain, 0, cap) : cur;
}

/** Burst is ready only with full Energy (current ≥ max, max > 0). */
export function canBurst(current: number, max: number): boolean {
  return Number.isFinite(max) && max > 0 && current >= max;
}

/** Energy right after a Burst is cast. */
export function spendBurst(): 0 {
  return 0;
}

/**
 * The sim clock is a float sum of ticks, so a cooldown counted down tick by tick can stop a hair above 0 on the
 * tick that reaches its end. Remaining time up to this much counts as expired.
 */
export const COOLDOWN_EPS = 1e-6;

/** The Skill can be cast: its remaining cooldown is 0 (Req 24.4). A non-finite remainder is not ready. */
export function skillReady(remaining: number): boolean {
  return Number.isFinite(remaining) && remaining <= COOLDOWN_EPS;
}
