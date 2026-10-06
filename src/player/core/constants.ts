// Movement numbers for the pure player controller: the design "이동 수치" table, the movement
// state machine and collide-and-slide steps 1–7 (design "Player Controller"). Units: metres,
// seconds, degrees, Stamina points. Pure TypeScript: imports only src/physics/types and
// src/logic/stamina.
//
// Layering note: src/logic may not import src/player, so the Stamina rates live in
// src/logic/stamina (single source of truth) and are only re-exported here.

import { MAX_WALKABLE_SLOPE_DEG } from '../../physics/types';

export {
  CLIMB_IDLE_STAMINA_PER_SEC,
  CLIMB_LEAP_STAMINA_COST,
  CLIMB_MOVE_STAMINA_PER_SEC,
  DODGE_STAMINA_COST,
  GLIDE_STAMINA_PER_SEC,
  SPRINT_STAMINA_PER_SEC,
  SWIM_STAMINA_PER_SEC,
} from '../../logic/stamina';

// --- Ground speeds (Req 16.1, 16.2) ---
export const WALK_SPEED = 2.5;
export const RUN_SPEED = 6;
export const SPRINT_SPEED = 9;
/** Stick tilt at or below this walks; above it runs (unless walkToggle is on). */
export const WALK_STICK_THRESHOLD = 0.5;
/** Upper bounds: 0 → target speed, target speed → 0, and facing interpolation time. */
export const ACCEL_TIME = 0.15;
export const DECEL_TIME = 0.12;
export const TURN_TIME = 0.15;

// --- Jump and fall (Req 16.3, 16.4) ---
export const GRAVITY = 25;
export const JUMP_APEX_HEIGHT = 1.4;
/** √(2 · 25 · 1.4) ≈ 8.3666 m/s, so a jump peaks JUMP_APEX_HEIGHT above take-off. */
export const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_APEX_HEIGHT);
/** Fraction of ground input authority kept while airborne (jump / fall). */
export const AIR_CONTROL = 0.6;
export const MAX_FALL_SPEED = 40;
/** Walk off a ledge without jumping: jump still counts as a ground jump for this long. */
export const COYOTE_TIME = 0.1;
/** A jump pressed during a fall that cannot deploy the glider is kept this long for landing. */
export const LANDING_JUMP_BUFFER = 0.15;

// --- Landing (Req 16.5) ---
/** Falls of at least this height stagger on landing (no fall damage). */
export const HARD_LANDING_HEIGHT = 12;
export const HARD_LANDING_STAGGER = 0.4;

// --- Dodge (Req 16.8, 24.8) ---
export const DODGE_DURATION = 0.35;
export const DODGE_DISTANCE = 4;
/** DODGE_DISTANCE / DODGE_DURATION ≈ 11.43 m/s; with no direction input the dodge goes backward. */
export const DODGE_SPEED = DODGE_DISTANCE / DODGE_DURATION;
export const DODGE_IFRAMES = 0.25;

// --- Capsule and collide-and-slide (steps 2–4, Req 16.7, 20.1) ---
export const CAPSULE_RADIUS = 0.4;
export const CAPSULE_HEIGHT = 1.75;
/** Gap kept between the capsule and what it hits. */
export const SKIN_WIDTH = 0.01;
/** Ledges up to this height above the feet are stepped onto automatically. */
export const STEP_UP_HEIGHT = 0.45;
/** Ground within this distance below the feet is snapped to while grounded and not jumping. */
export const GROUND_SNAP_DISTANCE = 0.3;
export const MAX_SLIDE_ITERATIONS = 4;

// --- Slopes (step 5, Req 16.6) ---
/** ≤ this walks (same value as the collision layer's walkable test). */
export const WALKABLE_SLOPE_DEG = MAX_WALKABLE_SLOPE_DEG;
/** Above WALKABLE_SLOPE_DEG and below this slides; at or above it a climbable surface can be climbed. */
export const CLIMB_SLOPE_DEG = 65;
export const SLIDE_SPEED = 6;

// --- Water (Req 16.9–16.11, design "수영·얕은 물") ---
/** Water at least this deep swims; shallower water only sets the wading flag. */
export const SWIM_DEPTH = 1.2;
/** Speed multiplier while wading (−20%). */
export const WADE_SPEED_FACTOR = 0.8;
export const SWIM_SPEED = 3.5;
/** Walkable ground at most this far under the swimming feet ends the swim on the shore (grounded). */
export const SWIM_EXIT_PROBE = 0.5;
/**
 * While swimming the feet are held this far under the water surface (the capsule is fixed to the level), so the head
 * stays about 1 m above it. Implementation choice: it must stay below SWIM_DEPTH − SWIM_EXIT_PROBE (0.7), so water deep
 * enough to swim in (≥ 1.2 m) never also has ground within the exit probe; the swim ends at ≤ 1.1 m and starts at ≥ 1.2 m.
 */
export const SWIM_FEET_DEPTH = 0.6;
/** The feet move to their swim height (entering from the bottom or from a fall) at up to this vertical speed (m/s). */
export const SWIM_SETTLE_SPEED = 4;
/**
 * Implementation choice: horizontal ground distance per step (m). While wading every step emits
 * `footstep{material: 'water'}` (splash VFX and the water step sound, Req 16.9): 3.4 steps/s at the wading run speed.
 */
export const FOOTSTEP_STRIDE = 1.4;

// --- Climbing (Req 18.2–18.10, design "등반") ---
export const CLIMB_SPEED = 2;
export const CLIMB_LEAP_DISTANCE = 2;
/** Pushing into a climbable ≥ 65° surface this long attaches. */
export const CLIMB_ATTACH_PUSH_TIME = 0.2;
/** Climbing down onto ground at most this far below the feet ends the climb. */
export const CLIMB_GROUND_DISTANCE = 0.3;
/**
 * The chest point follows the nearest climbable surface: the capsule centre on its axis, so the capsule
 * centre stays CLIMB_SURFACE_OFFSET off the surface (design Property 28).
 */
export const CLIMB_CHEST_HEIGHT = CAPSULE_HEIGHT / 2;
/** Height of the head ray above the feet (top edge check). */
export const CLIMB_HEAD_HEIGHT = 1.7;
/** The chest point sits this far out along the surface normal: capsule radius 0.4 + 0.05. */
export const CLIMB_SURFACE_OFFSET = 0.45;
/** closestSurface radius around the chest point; no climbable surface within it drops the character into a fall. */
export const CLIMB_SURFACE_RADIUS = 0.9;
/** climbNormal turns toward the surface normal at 90° per this long. */
export const CLIMB_NORMAL_BLEND_TIME = 0.1;
/**
 * Objects lower than this are never climbed (Req 18.9): the attach ray toward the wall starts this far above
 * the feet, so lower obstacles are stepped onto (≤ 0.45 m) or jumped over instead.
 */
export const CLIMB_MIN_OBJECT_HEIGHT = 1;
/** Implementation choices (not in the design table): the grab of climbAttach and the ClimbLeap length. */
export const CLIMB_ATTACH_TIME = 0.15;
export const CLIMB_LEAP_TIME = 0.4;
/** After a release (C) an air contact does not attach again for this long. */
export const CLIMB_REATTACH_DELAY = 0.3;
/** Mantle (Req 18.5, ≤ 0.5 s): the scripted move onto the top takes this long. */
export const MANTLE_TIME = 0.45;
/** Walkable ground on top is searched up to this far past the wall. */
export const MANTLE_REACH = 1.2;

// --- Gliding and air volumes (Req 19.1, 19.2, 19.6, 19.7, 19.9, 19.10, design "활강") ---
/** Horizontal glide speed, kept at this magnitude while gliding (the Wind_Zone push comes on top). */
export const GLIDE_SPEED = 9;
export const GLIDE_MAX_DESCENT_SPEED = 2.5;
export const GLIDE_DEPLOY_TIME = 0.3;
/** The glider deploys only with ground at least this far below the feet (or none within GLIDE_GROUND_PROBE). */
export const GLIDE_MIN_GROUND_CLEARANCE = 3;
/** Reach of the downward deploy ray (m). */
export const GLIDE_GROUND_PROBE = 200;
/** The glide heading turns toward the move input at up to this rate (°/s). */
export const GLIDE_TURN_RATE_DEG = 200;
/**
 * Braking of a faster fall during glideDeploy (m/s²): (MAX_FALL_SPEED − GLIDE_MAX_DESCENT_SPEED) / GLIDE_DEPLOY_TIME, so
 * even a fall at the 40 m/s cap is down to the glide's descent speed by the end of the deploy.
 */
export const GLIDE_DEPLOY_BRAKE = (MAX_FALL_SPEED - GLIDE_MAX_DESCENT_SPEED) / GLIDE_DEPLOY_TIME;
export const UPDRAFT_RISE_SPEED = 8;
/**
 * Feet up to this far above an Updraft's top still count as at the top (vy 0), so a glider hovers there instead
 * of dropping out of the column and rising back in on alternate ticks.
 */
export const UPDRAFT_TOP_SLACK = 0.05;
export const WIND_ZONE_PUSH_SPEED = 4;
/**
 * Glide wind loudness i = clamp01(0.5·h / GLIDE_WIND_FULL_HEIGHT + 0.5·v / GLIDE_WIND_FULL_SPEED) from the height
 * above the ground h and the speed v (Req 19.10; the Audio_System's setGlideWind, task 16.3).
 */
export const GLIDE_WIND_FULL_HEIGHT = 40;
export const GLIDE_WIND_FULL_SPEED = 13;
