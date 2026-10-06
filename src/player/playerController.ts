// Player_Controller adapter around the pure core (design "Player Controller", "Tick 갱신 순서"). Once per
// sim tick it turns the frozen InputSample and the camera yaw into ControllerInput, runs stepController,
// consumes the buffered presses the tick used and keeps the previous and current ControllerState; each
// render frame reads an interpolated pose between the two with the loop's alpha (Req 1.9). The state
// only changes through stepController's result, a knockback slide collided along the world after it
// (knockback(), Req 28.10), Wren's gliding Skill lift (glideRise(), Req 19.9), or teleport(), which replaces it
// with a fresh standing state (Safe_Position recovery). After each tick it hands the glide wind loudness (height
// above the ground and speed, Req 19.10) to its GlideWindSink. Pure: no three.js / DOM.

import { clamp01, distance, isFiniteV3, lerpAngle, lerpV3, wrapAngle } from '../core/math';
import type { Vec3 } from '../core/types';
import type { CharacterId } from '../data/ids';
import type { InputState } from '../input/inputState';
import { createStaminaState, type StaminaState } from '../logic/stamina';
import { consumeUsedPresses, readControllerInput, type ControllerInputSource } from './controllerInput';
import { GLIDE_GROUND_PROBE } from './core/constants';
import { glideLift, glideWindIntensity, groundClearance } from './core/glide';
import { moveAndSlide } from './core/moveAndSlide';
import { stepController } from './core/stepController';
import {
  createControllerState, isGlideMode, type ControllerEvent, type ControllerState, type ControllerVolumes, type ControllerWorld,
  type MoveMode,
} from './core/types';

/** A hit's knockback slides the character over this long (s), like an enemy's. */
export const PLAYER_KNOCKBACK_SECONDS = 0.15;
/** Modes a knockback does not move (climbing and mantling keep their surface contact); a pending push is dropped. */
const KNOCKBACK_IMMUNE_MODES: ReadonlySet<MoveMode> = new Set<MoveMode>(['climbAttach', 'climb', 'climbLeap', 'mantle', 'locked']);

/** Render-time pose of the Active_Character: feet position and facing (rad). */
export interface PlayerPose {
  pos: Vec3;
  yaw: number;
}

/** The InputState view a tick needs: reading the sample and consuming the presses it used. */
export type PlayerTickInput = ControllerInputSource & Pick<InputState, 'consumeBuffered'>;

/**
 * Pose between two consecutive tick states: position lerped and yaw along the shortest arc (wrapped to
 * (−π, π]). `alpha` is clamped to [0, 1]; a non-finite alpha shows `curr`.
 */
export function interpolatePose(prev: Readonly<ControllerState>, curr: Readonly<ControllerState>, alpha: number): PlayerPose {
  const t = Number.isFinite(alpha) ? clamp01(alpha) : 1;
  return { pos: lerpV3(prev.pos, curr.pos, t), yaw: lerpAngle(prev.yaw, curr.yaw, t) };
}

/**
 * Where the glide wind loudness goes each tick (Req 19.10): the Audio_System's setGlideWind (task 16.3) drives the
 * wind loop's gain and filter from it. Defined here, on the simulation side, so the audio layer implements it.
 */
export interface GlideWindSink {
  /** Called once per tick with i ∈ [0, 1]; 0 while not gliding. */
  setGlideWind(intensity: number): void;
}

export interface PlayerControllerOptions {
  world: ControllerWorld;
  /** Water, Updraft and Wind_Zone volumes (src/world/controllerVolumes). Default none. */
  volumes?: ControllerVolumes | null;
  /** Feet position to start at. */
  pos: Readonly<Vec3>;
  /** Facing to start with (rad). */
  yaw: number;
  /** Active_Character for the Stamina passives. Default 'kairen' (the only member at New Game). */
  character?: CharacterId;
  /** Party Stamina to start with. Default a full, rested base pool. */
  stamina?: StaminaState;
  /** Receives the glide wind loudness every tick. Default none (read `windIntensity` instead). */
  glideWind?: GlideWindSink | null;
}

export class PlayerController {
  private activeCharacter: CharacterId;
  private readonly world: ControllerWorld;
  private readonly volumes: ControllerVolumes | null;
  private readonly glideWind: GlideWindSink | null;
  private prev: ControllerState;
  private curr: ControllerState;
  private staminaState: StaminaState;
  /** Knockback slide in progress: horizontal velocity (m/s) and seconds left; null when none. */
  private push: { x: number; z: number; left: number } | null = null;
  private wind = 0;

  constructor(options: PlayerControllerOptions) {
    this.world = options.world;
    this.volumes = options.volumes ?? null;
    this.glideWind = options.glideWind ?? null;
    this.activeCharacter = options.character ?? 'kairen';
    this.curr = createControllerState(options.pos, options.yaw);
    this.prev = this.curr;
    this.staminaState = options.stamina ?? createStaminaState();
  }

  /**
   * Glide wind loudness of the last tick in [0, 1] (Req 19.10): from the height above the ground (the downward ray,
   * GLIDE_GROUND_PROBE when it finds nothing) and the speed the character moved at that tick, 0 while not gliding.
   */
  get windIntensity(): number {
    return this.wind;
  }

  /** Active_Character whose Stamina passive the next tick applies. */
  get character(): CharacterId {
    return this.activeCharacter;
  }

  /**
   * Party switch (Req 23.1): the new Active_Character takes over this body as it is, so position, yaw and
   * velocity (vertical component included), the movement mode and Stamina carry over unchanged, and the next
   * tick already moves it (well inside the 0.1 s handover).
   */
  switchCharacter(id: CharacterId): void {
    this.activeCharacter = id;
  }

  /** State after the last tick. */
  get state(): Readonly<ControllerState> {
    return this.curr;
  }

  /** State before the last tick (the interpolation start). */
  get previous(): Readonly<ControllerState> {
    return this.prev;
  }

  get stamina(): Readonly<StaminaState> {
    return this.staminaState;
  }

  /**
   * Task 12.4 (깃털 방울 `dodgeStaminaMul`): gives back `amount` Stamina right after this tick's Dodge paid its full
   * cost, clamped to the max; a Dodge that emptied the pool is no longer exhausted once refunded. Non-positive or
   * non-finite amounts change nothing.
   */
  refundStamina(amount: number): void {
    if (!(Number.isFinite(amount) && amount > 0)) return;
    const s = this.staminaState;
    this.staminaState = { ...s, value: Math.min(s.max, s.value + amount), exhausted: s.exhausted && s.value > 0 };
  }

  /**
   * Task 12.7 (Echo_Tablet set, Req 10.9): sets the party's max Stamina to `max`; a raise adds the difference to the
   * current value too, so the new capacity is there at once. Non-finite or non-positive maxima change nothing.
   */
  setStaminaMax(max: number): void {
    if (!(Number.isFinite(max) && max > 0)) return;
    const s = this.staminaState;
    const value = Math.min(max, s.value + Math.max(0, max - s.max));
    this.staminaState = { ...s, max, value };
  }

  /**
   * One sim tick of `dt`: reads `input` (already advanced by beginTick) with movement relative to
   * `cameraYaw`, steps the controller and consumes the presses it used. Returns the tick's events; the composition
   * root turns `recoveryNeeded` (a swim out of Stamina, now `locked`) into a RecoverySystem fade whose teleport() ends
   * the lock (Req 16.11).
   */
  tick(input: PlayerTickInput, cameraYaw: number, dt: number): ControllerEvent[] {
    const controls = readControllerInput(input, cameraYaw);
    const result = stepController(this.curr, controls, this.world, this.staminaState, this.activeCharacter, dt, this.volumes);
    consumeUsedPresses(input, result.consumed);
    this.prev = this.curr;
    this.curr = this.slide(result.state, dt);
    this.staminaState = result.stamina;
    this.wind = this.measureWind(dt);
    this.glideWind?.setGlideWind(this.wind);
    return result.events;
  }

  /**
   * Wren's Skill cast while gliding (Req 19.9): lifts the character `rise` m at once, stopping under a ceiling
   * (core glideLift). The previous state stays, so the render pose rises over the next tick. Returns false (nothing
   * changes) outside glideDeploy / glide or for a non-positive rise.
   */
  glideRise(rise: number): boolean {
    const lifted = glideLift(this.curr, this.world, rise);
    if (lifted === null) return false;
    this.curr = lifted;
    return true;
  }

  /** The glide wind loudness after a tick of `dt`: height above the ground and the speed moved (Req 19.10). */
  private measureWind(dt: number): number {
    if (!isGlideMode(this.curr.mode)) return 0;
    const height = groundClearance(this.world, this.curr.pos, GLIDE_GROUND_PROBE) ?? GLIDE_GROUND_PROBE;
    const speed = Number.isFinite(dt) && dt > 0 ? distance(this.prev.pos, this.curr.pos) / dt : 0;
    return glideWindIntensity(height, speed);
  }

  /** Seconds left of the knockback slide (0 when none). */
  get knockbackRemaining(): number {
    return this.push?.left ?? 0;
  }

  /**
   * An enemy hit's knockback (Req 28.10): pushes the character `distance` m along the horizontal part of `direction`
   * over PLAYER_KNOCKBACK_SECONDS, starting next tick, collided against the world after each controller step. A new
   * push replaces one still sliding; non-positive or non-finite distances and zero directions do nothing.
   */
  knockback(direction: Readonly<Vec3>, distance: number): void {
    if (!(Number.isFinite(distance) && distance > 0)) return;
    const h = Math.hypot(direction.x, direction.z);
    if (!(Number.isFinite(h) && h > 1e-9)) return;
    const speed = distance / PLAYER_KNOCKBACK_SECONDS;
    this.push = { x: (direction.x / h) * speed, z: (direction.z / h) * speed, left: PLAYER_KNOCKBACK_SECONDS };
  }

  /** This tick's part of the knockback slide, moved with collide-and-slide from the stepped state. */
  private slide(state: ControllerState, dt: number): ControllerState {
    const push = this.push;
    if (push === null) return state;
    if (KNOCKBACK_IMMUNE_MODES.has(state.mode)) {
      this.push = null;
      return state;
    }
    const s = Number.isFinite(dt) && dt > 0 ? Math.min(dt, push.left) : 0;
    push.left -= s;
    if (push.left <= 1e-9) this.push = null;
    if (!(s > 0)) return state;
    const moved = moveAndSlide(this.world, state.pos, { x: push.x * s, y: 0, z: push.z * s }, { grounded: state.grounded });
    return moved.valid ? { ...state, pos: moved.pos } : state;
  }

  /** Interpolated pose for a render frame: `alpha` 0 is the previous tick, 1 the last one. */
  pose(alpha: number): PlayerPose {
    return interpolatePose(this.prev, this.curr, alpha);
  }

  /**
   * Turns the character to `yaw` (wrapped to (−π, π]) without moving it: combat facing at an attack start.
   * The previous state keeps its yaw, so the render pose turns over the next tick. Non-finite yaws are ignored.
   */
  face(yaw: number): void {
    if (!Number.isFinite(yaw)) return;
    this.curr = { ...this.curr, yaw: wrapAngle(yaw) };
  }

  /**
   * Puts the character at `pos` facing `yaw`, standing at rest (createControllerState): Safe_Position
   * recovery now, fast travel and loads later. The previous state moves too, so the render pose does not
   * sweep across the jump; Stamina is kept and a knockback slide is dropped. A non-finite `pos` changes nothing
   * and returns false.
   */
  teleport(pos: Readonly<Vec3>, yaw: number): boolean {
    if (!isFiniteV3(pos)) return false;
    this.curr = createControllerState(pos, yaw);
    this.prev = this.curr;
    this.push = null;
    return true;
  }
}
