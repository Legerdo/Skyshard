// Mode → StaminaActivity summary (design "Player Controller" → "인터페이스": stepController sums up each
// tick's mode and input as one StaminaActivity for stepStamina). Pure TypeScript: types only.
//
// The climb rows are used by the climb modes (task 9.1), the glide rows by glideDeploy / glide (task 9.3) and the swim
// row by the swim mode (task 9.4).

import type { StaminaActivity } from '../../logic/stamina';
import type { MoveMode } from './types';

/** What a mode tick did, beyond its mode. */
export interface ActivityFlags {
  /** The mode was entered this tick (dodge and climbLeap charge only then). */
  readonly entered?: boolean;
  /** Ground movement ran at sprint speed this tick. */
  readonly sprinting?: boolean;
  /** Move input was held (climb and swim drain only while moving, Req 16.10, 18.3). */
  readonly moving?: boolean;
}

/**
 * The Stamina activity of a tick simulated in `mode`:
 * - grounded: `sprint` while sprinting, else `none`
 * - dodge / climbLeap: the flat cost on the entry tick only, else `none`
 * - climbAttach / climb: `climbMove` with move input, else `climbIdle` (holding on to the wall)
 * - glideDeploy / glide: `glide`
 * - swim: `swim` with move input (Req 16.10: drained while swimming), else `none`
 * - every other mode (slide, jump, fall, landing, mantle, hurt, downed, locked): `none`
 */
export function staminaActivity(mode: MoveMode, flags: ActivityFlags = {}): StaminaActivity {
  switch (mode) {
    case 'grounded':
      return flags.sprinting === true ? 'sprint' : 'none';
    case 'dodge':
      return flags.entered === true ? 'dodge' : 'none';
    case 'climbLeap':
      return flags.entered === true ? 'climbLeap' : 'none';
    case 'climbAttach':
    case 'climb':
      return flags.moving === true ? 'climbMove' : 'climbIdle';
    case 'glideDeploy':
    case 'glide':
      return 'glide';
    case 'swim':
      return flags.moving === true ? 'swim' : 'none';
    default:
      return 'none';
  }
}
