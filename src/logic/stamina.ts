/*
 * Party-wide stamina (design.md "Stamina (src/logic/stamina, 순수)", Req 17).
 * Pure: every function returns a new state and never mutates its input.
 */
import { clamp } from '../core/math';
import { CHARACTERS } from '../data/characters';
import type { CharacterDef } from '../data/combatTypes';
import { CHARACTER_IDS, type CharacterId, type RegionId } from '../data/ids';

export type StaminaActivity =
  | 'none'
  | 'sprint'
  | 'dodge'
  | 'climbMove'
  | 'climbIdle'
  | 'climbLeap'
  | 'glide'
  | 'swim';

/** Charged once per call (a flat cost) instead of per second. */
export type OneShotActivity = 'dodge' | 'climbLeap';
/** Drained at `rate × passive × dt`. */
export type ContinuousActivity = Exclude<StaminaActivity, 'none' | OneShotActivity>;

export interface StaminaState {
  value: number;
  max: number;
  exhausted: boolean;
  /** Seconds since the last draining tick. */
  idleTimer: number;
}

export interface StaminaRules {
  readonly baseMax: number;
  readonly maxPerTabletSet: number;
  readonly drainPerSecond: Readonly<Record<ContinuousActivity, number>>;
  readonly oneShotCost: Readonly<Record<OneShotActivity, number>>;
  /** Active-character passives: multiplier for the listed activities (Req 17.6). */
  readonly passives: Readonly<Record<CharacterId, Readonly<Partial<Record<StaminaActivity, number>>>>>;
  readonly regenPerSecond: number;
  /** Seconds without drain before regen starts. */
  readonly regenDelay: number;
  /** `exhausted` clears once `value ≥ exhaustClearRatio × max`. */
  readonly exhaustClearRatio: number;
  /** Refused by `canStart` while exhausted (`swim` is deliberately absent). */
  readonly blockedWhileExhausted: readonly StaminaActivity[];
}

// Stamina rates (design Stamina table). Single source of truth: src/player/core/constants.ts
// re-exports these, because src/logic may not import src/player.
export const SPRINT_STAMINA_PER_SEC = 18;
export const CLIMB_MOVE_STAMINA_PER_SEC = 10;
export const CLIMB_IDLE_STAMINA_PER_SEC = 2;
export const GLIDE_STAMINA_PER_SEC = 6;
export const SWIM_STAMINA_PER_SEC = 6;
export const DODGE_STAMINA_COST = 20;
export const CLIMB_LEAP_STAMINA_COST = 20;

/**
 * Stamina activities covered by a character passive's `activity` (src/data/characters, 표 A):
 * 'climb' is the whole climb family, the flat climbLeap included (design Stamina table).
 */
const PASSIVE_ACTIVITIES: Readonly<Record<string, readonly StaminaActivity[]>> = {
  sprint: ['sprint'],
  climb: ['climbMove', 'climbIdle', 'climbLeap'],
  glide: ['glide'],
  swim: ['swim'],
};

/** Per-activity multipliers of one character's passive; an unknown activity adds none. */
export function passiveMultipliers(passive: Readonly<CharacterDef['passive']>): Partial<Record<StaminaActivity, number>> {
  const out: Partial<Record<StaminaActivity, number>> = {};
  for (const activity of PASSIVE_ACTIVITIES[passive.activity] ?? []) out[activity] = passive.staminaMul;
  return out;
}

function passivesFrom(chars: Readonly<Record<CharacterId, Readonly<CharacterDef>>>): StaminaRules['passives'] {
  const out = {} as Record<CharacterId, Partial<Record<StaminaActivity, number>>>;
  for (const id of CHARACTER_IDS) out[id] = passiveMultipliers(chars[id].passive);
  return out;
}

export const STAMINA_RULES: StaminaRules = {
  baseMax: 100,
  maxPerTabletSet: 15,
  drainPerSecond: {
    sprint: SPRINT_STAMINA_PER_SEC,
    climbMove: CLIMB_MOVE_STAMINA_PER_SEC,
    climbIdle: CLIMB_IDLE_STAMINA_PER_SEC,
    glide: GLIDE_STAMINA_PER_SEC,
    swim: SWIM_STAMINA_PER_SEC,
  },
  oneShotCost: { dodge: DODGE_STAMINA_COST, climbLeap: CLIMB_LEAP_STAMINA_COST },
  // Kairen sprint ×0.8, Isla swim ×0.6, Wren glide ×0.7, Talus climb ×0.75 (from the character kits).
  passives: passivesFrom(CHARACTERS),
  regenPerSecond: 25,
  regenDelay: 1,
  exhaustClearRatio: 0.3,
  blockedWhileExhausted: ['sprint', 'dodge', 'climbMove', 'climbIdle', 'climbLeap', 'glide'],
};

/** 100 + 15 per completed regional Echo_Tablet set (Req 10.9). */
export function staminaMax(completedTabletSets: number): number {
  return STAMINA_RULES.baseMax + STAMINA_RULES.maxPerTabletSet * completedTabletSets;
}

/** Main Regions with an Echo_Tablet set: three tablets each, `tab_<region>_1` to `tab_<region>_3` (Req 10.8). */
export const TABLET_SET_REGIONS = ['verdant', 'ember', 'azure'] as const satisfies readonly RegionId[];
export const TABLETS_PER_SET = 3;

/** Regions whose three Echo_Tablets are all in `collected` (e.g. `GameState.world.echoTablets`). */
export function completedTabletSets(collected: readonly string[]): number {
  const have = new Set(collected);
  const complete = (region: RegionId): boolean => {
    for (let n = 1; n <= TABLETS_PER_SET; n++) if (!have.has(`tab_${region}_${n}`)) return false;
    return true;
  };
  return TABLET_SET_REGIONS.filter(complete).length;
}

export function newStamina(max: number): StaminaState {
  return { value: max, max, exhausted: false, idleTimer: 0 };
}

/** A full, rested state (design name); `max` defaults to the base 100. Same as newStamina(max). */
export function createStaminaState(max: number = STAMINA_RULES.baseMax): StaminaState {
  return newStamina(max);
}

export function isOneShot(activity: StaminaActivity): activity is OneShotActivity {
  return activity === 'dodge' || activity === 'climbLeap';
}

/** Passive multiplier of `character` for `activity`; 1 when none applies. */
export function staminaMultiplier(character: CharacterId, activity: StaminaActivity): number {
  return STAMINA_RULES.passives[character][activity] ?? 1;
}

/** Clamps to [0, max]; exhausted turns on at 0 and off at ≥ 30 % of max. */
function settle(s: StaminaState, value: number, idleTimer: number): StaminaState {
  const v = clamp(value, 0, s.max);
  const exhausted = v <= 0 || (s.exhausted && v < STAMINA_RULES.exhaustClearRatio * s.max);
  return { value: v, max: s.max, exhausted, idleTimer };
}

/** Flat dodge / climbLeap cost (Talus pays 75 % for climbLeap); counts as a draining tick. */
export function spendOneShot(s: StaminaState, activity: OneShotActivity, character: CharacterId): StaminaState {
  const cost = STAMINA_RULES.oneShotCost[activity] * staminaMultiplier(character, activity);
  return settle(s, s.value - cost, 0);
}

/**
 * One tick. Draining activities reset `idleTimer`; one-shots are charged once, ignoring `dt`.
 * Idle ticks regen 25/s only for the time past the 1 s delay, so the result does not depend on
 * how the idle time is split into ticks.
 */
export function stepStamina(
  s: StaminaState,
  activity: StaminaActivity,
  character: CharacterId,
  dt: number,
): StaminaState {
  if (isOneShot(activity)) return spendOneShot(s, activity, character);
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (activity !== 'none') {
    const drain = STAMINA_RULES.drainPerSecond[activity] * staminaMultiplier(character, activity) * t;
    return settle(s, s.value - drain, 0);
  }
  const idleTimer = s.idleTimer + t;
  const regenTime = clamp(idleTimer - STAMINA_RULES.regenDelay, 0, t);
  return settle(s, s.value + STAMINA_RULES.regenPerSecond * regenTime, idleTimer);
}

/**
 * Whether `activity` may start now: sprint, dodge, climb* and glide are refused while exhausted,
 * and dodge / climbLeap also need their base cost (the state machine's `stamina ≥ 20`).
 */
export function canStart(s: StaminaState, activity: StaminaActivity): boolean {
  if (s.exhausted && STAMINA_RULES.blockedWhileExhausted.includes(activity)) return false;
  return !isOneShot(activity) || s.value >= STAMINA_RULES.oneShotCost[activity];
}
