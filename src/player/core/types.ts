// Shared types for the pure player controller core (design "Player Controller" → "인터페이스").
// Pure TypeScript: imports only src/core, src/physics and (types only) src/logic/stamina (no
// three.js / DOM / Math.random). The three.js view reads ControllerState each render frame; only
// stepController's return value produces a new state, and no function here mutates its arguments.

import { copyV3, wrapAngle } from '../../core/math';
import type { Vec3 } from '../../core/types';
import type { StaminaState } from '../../logic/stamina';
import type { CollisionQueries, Heightfield, SurfaceMaterial } from '../../physics/types';

export type MoveMode =
  | 'grounded'
  | 'slide'
  | 'jump'
  | 'fall'
  | 'landing'
  | 'dodge'
  | 'climbAttach'
  | 'climb'
  | 'climbLeap'
  | 'mantle'
  | 'glideDeploy'
  | 'glide'
  | 'swim'
  | 'hurt'
  | 'downed'
  | 'locked';

/**
 * The climbing family (design "등반"): on the wall (climbAttach, climb, climbLeap) and the mantle onto its top.
 * Combat input is ignored and party switches are refused in these modes (Req 18.11, 23.4).
 */
export const CLIMB_MODES: ReadonlySet<MoveMode> = new Set<MoveMode>(['climbAttach', 'climb', 'climbLeap', 'mantle']);

export function isClimbMode(mode: MoveMode): boolean {
  return CLIMB_MODES.has(mode);
}

/**
 * The gliding family (design "활강"): the deploy and the glide itself. Party switches are refused (Req 23.4); Wren's
 * Skill may be cast and lifts the character (Req 19.9).
 */
export const GLIDE_MODES: ReadonlySet<MoveMode> = new Set<MoveMode>(['glideDeploy', 'glide']);

export function isGlideMode(mode: MoveMode): boolean {
  return GLIDE_MODES.has(mode);
}

/** Every MoveMode, in declaration order (for exhaustive tests and generators). */
export const MOVE_MODES: readonly MoveMode[] = [
  'grounded',
  'slide',
  'jump',
  'fall',
  'landing',
  'dodge',
  'climbAttach',
  'climb',
  'climbLeap',
  'mantle',
  'glideDeploy',
  'glide',
  'swim',
  'hurt',
  'downed',
  'locked',
];

/**
 * Controller state: the design fields plus `coyoteTime`. `pos` is the capsule's feet (lowest point).
 */
export interface ControllerState {
  pos: Vec3;
  /**
   * m/s. In the ground modes (grounded, landing, dodge) this is the steered velocity: walls deflect
   * the displacement (collide-and-slide), not the stored velocity, so pushing into a wall keeps it.
   * While gliding it is the glide's own velocity (heading × GLIDE_SPEED and the vertical speed); a Wind_Zone's
   * push is added to the displacement only, so it holds while inside the zone and never accumulates (Req 19.7).
   */
  vel: Vec3;
  /** Facing, radians (core/math convention: 0 faces +Z, positive turns toward +X). */
  yaw: number;
  mode: MoveMode;
  /** Seconds spent in the current mode. */
  modeTime: number;
  /** Feet on standable ground (a slide slope is contact but not standable). */
  grounded: boolean;
  /** Unit normal of the ground contact found in the last tick (standable or slide slope); {0,1,0} when none. */
  groundNormal: Vec3;
  /**
   * Standing in water shallower than the swim depth (Req 16.9): grounded with the feet under a water surface whose
   * depth (level − terrain height) is below SWIM_DEPTH. Ground speed −20%, water footsteps, no mode change.
   */
  wading: boolean;
  /**
   * Horizontal distance (m) walked in `grounded` since the last step, a step every FOOTSTEP_STRIDE (a wading step emits
   * `footstep{material: 'water'}`); 0 outside `grounded`. Not a design field.
   */
  stride: number;
  /**
   * Outward unit normal of the surface being climbed, turned toward the nearest surface's normal at 90° per
   * 0.1 s; the facing looks along −climbNormal. Null outside climbAttach / climb / climbLeap / mantle.
   */
  climbNormal: Vec3 | null;
  /**
   * Seconds the move input has pushed a grounded character into a climbable ≥ 65° wall at chest height
   * (attach at CLIMB_ATTACH_PUSH_TIME, Req 18.2); 0 otherwise. Not a design field.
   */
  climbPush: number;
  /** Seconds left before an air contact may attach again after a release (C); 0 otherwise. Not a design field. */
  climbCooldown: number;
  /** Feet destination of the mantle in progress; null outside `mantle`. Not a design field. */
  mantleTarget: Vec3 | null;
  /**
   * Feet height where the current fall started: the ground height while in contact, then the highest
   * point reached in the air (landed.fallHeight = fallStartY − landing y).
   */
  fallStartY: number;
  /** Remaining invulnerability, seconds (dodge i-frames). */
  iFrames: number;
  /**
   * Remaining coyote time, seconds. Not a design field: set to COYOTE_TIME when the character leaves
   * standable ground without jumping (grounded → fall / slide), so a jump in that window is still a
   * ground jump; 0 otherwise. It is what tells a walk-off fall from the fall after a jump's apex.
   */
  coyoteTime: number;
}

export type ControllerEvent =
  | { type: 'jumped' }
  | { type: 'landed'; fallHeight: number }
  | { type: 'climbStarted' }
  | { type: 'mantled' }
  | { type: 'glideStarted' }
  | { type: 'glideEnded' }
  | { type: 'enteredWater' }
  | { type: 'footstep'; material: SurfaceMaterial }
  | { type: 'exhausted' }
  | { type: 'recoveryNeeded' };

export type ControllerEventType = ControllerEvent['type'];

/**
 * One tick of player intent. Not defined by the design; chosen for slice B:
 * - `move` is the WORLD-space desired horizontal direction whose length in [0, 1] is the stick tilt
 *   (the adapter rotates the stick by the camera yaw; the controller clamps longer vectors to 1).
 * - `sprint` is held; `walk` is the current walkToggle state (not a press).
 * - `jump` / `dodge` mean "a buffered press is available" (InputBuffer). The controller stays pure,
 *   so its step result reports which of them it used (ConsumedPresses) and the adapter calls
 *   InputBuffer.consume for those.
 * - `release` is the climb / glide release button (C) pressed this tick (edge, not buffered).
 */
export interface ControllerInput {
  move: { x: number; z: number };
  sprint: boolean;
  walk: boolean;
  jump: boolean;
  dodge: boolean;
  release: boolean;
}

/** Buffered presses a controller step used; the adapter consumes exactly these from InputBuffer. */
export interface ConsumedPresses {
  jump: boolean;
  dodge: boolean;
}

/**
 * stepController's result: the design's `{ state, stamina, events }` plus `consumed`, the buffered
 * presses this tick used (none when the tick was discarded).
 */
export interface ControllerStepResult {
  state: ControllerState;
  stamina: StaminaState;
  events: ControllerEvent[];
  consumed: ConsumedPresses;
}

/**
 * The world view the controller needs. Deviation from the design signature (which takes
 * CollisionQueries): the safety clamp y ≥ heightAt(x, z) (collide-and-slide step 7, Req 20.1)
 * needs terrain heights, which CollisionQueries does not expose. A CollisionWorld satisfies this
 * type structurally.
 */
export type ControllerWorld = CollisionQueries & { readonly terrain: Pick<Heightfield, 'heightAt'> };

/** Water depth and surface level at a point (design "물·기류·트리거 볼륨" `water`). */
export interface WaterSample {
  /** Surface height (y). */
  readonly level: number;
  /** level − terrain height (m, > 0). */
  readonly depth: number;
}

/**
 * The water, Updraft and Wind_Zone volumes the controller reads (design "Player Controller": the core depends only on
 * the collision queries and these volume interfaces). src/world/controllerVolumes builds one from the VolumeIndex and
 * the terrain; without one there is no water and no air volume.
 */
export interface ControllerVolumes {
  /** Water at (x, z), or null where there is none. */
  water(x: number, z: number): WaterSample | null;
  /** Top height (feet y where the rise stops) of the Updraft containing `feet`, the highest when several do; else null. */
  updraftTop(feet: Readonly<Vec3>): number | null;
  /** Horizontal unit push direction of the Wind_Zone containing `feet` (the first when several do); else null. */
  windDirection(feet: Readonly<Vec3>): { readonly x: number; readonly z: number } | null;
}

/**
 * Initial state: standing ('grounded', at rest, no coyote time) at `pos` facing `yaw` (wrapped to
 * (−π, π]; a non-finite yaw becomes 0). `pos` is copied.
 */
export function createControllerState(pos: Readonly<Vec3>, yaw: number): ControllerState {
  return {
    pos: copyV3(pos),
    vel: { x: 0, y: 0, z: 0 },
    yaw: Number.isFinite(yaw) ? wrapAngle(yaw) : 0,
    mode: 'grounded',
    modeTime: 0,
    grounded: true,
    groundNormal: { x: 0, y: 1, z: 0 },
    wading: false,
    stride: 0,
    climbNormal: null,
    climbPush: 0,
    climbCooldown: 0,
    mantleTarget: null,
    fallStartY: pos.y,
    iFrames: 0,
    coyoteTime: 0,
  };
}
