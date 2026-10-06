/*
 * Starlit_Stair fall rule (design.md "진행 게이트": seal_sanctum; Req 5.6). On the stair the last
 * platform stood on is remembered; once the feet drop STAIR_FALL_DISTANCE or more below its top, the
 * character is faded back onto it. Standing on any other ground (the crater floor, the Sanctum) forgets
 * it, so an ordinary fall off the lowest steps just lands. While airborne (jumping, gliding, riding an
 * Updraft) the remembered platform stays.
 *
 * Pure: no three.js, DOM or Math.random.
 */

/** A fall this far below the last platform's top sends the character back (m, Req 5.6). */
export const STAIR_FALL_DISTANCE = 10;

export interface StairFallState {
  /** Index of the last platform stood on; null when off the stair. */
  readonly last: number | null;
}

/** What the feet rest on this tick. */
export interface StairContact {
  readonly grounded: boolean;
  /** Stair platform under the feet (index), or null for any other ground. Ignored when not grounded. */
  readonly platform: number | null;
}

export interface StairFallStep {
  readonly state: StairFallState;
  /** Platform to return to when the character fell this tick, else null. */
  readonly fell: number | null;
}

export const INITIAL_STAIR_FALL_STATE: StairFallState = { last: null };

/**
 * One tick: grounded contact updates the remembered platform; otherwise a drop of STAIR_FALL_DISTANCE or
 * more below `topY(last)` reports `fell` and forgets it (the return puts the character back on it). A
 * non-finite `feetY` changes nothing.
 */
export function stepStairFall(state: StairFallState, contact: StairContact, feetY: number, topY: (platform: number) => number): StairFallStep {
  if (contact.grounded) {
    const last = contact.platform;
    return { state: last === state.last ? state : { last }, fell: null };
  }
  if (state.last === null || !Number.isFinite(feetY)) return { state, fell: null };
  if (topY(state.last) - feetY >= STAIR_FALL_DISTANCE) return { state: INITIAL_STAIR_FALL_STATE, fell: state.last };
  return { state, fell: null };
}
