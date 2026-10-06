// Pure player controller tick (design "Player Controller": 이동 상태 머신, 이동 수치, collide-and-slide
// steps 1–7, 등반, 활강, 수영·얕은 물; Req 16.1–16.11, 17.3, 17.4, 18.2–18.10, 19.1–19.7, 20.1). This covers ground
// locomotion (grounded: idle · walk · run · sprint, slide, jump, fall, landing, dodge), climbing (climbAttach → climb ⇄
// climbLeap, ending in mantle, grounded or fall; the wall geometry lives in ./climb), gliding (glideDeploy → glide,
// ending in fall, a landing, swim or climbAttach, with the Updraft and Wind_Zone volumes) and water: shallow water
// (depth < 1.2 m) only sets `wading` (ground speed −20 %, water footsteps), deeper water swims at the surface, leaving
// on the shore (grounded), and Stamina running out there locks the character with `recoveryNeeded` so the adapter's
// RecoverySystem fades it back to the last Safe_Position. hurt / downed / locked keep their mode and only get physics
// without input (afloat in deep water), because their owners (combat, respawn, dialogue / cinematics, recovery) end
// them. Player ↔ agent overlaps are separated afterwards by CollisionResolve (src/physics/separation, Req 20.2).
//
// Pure TypeScript: imports only src/core, src/data (types), src/logic/stamina and src/physics (no
// three.js / DOM / Math.random), and stepController never mutates its arguments.
//
// Timing. A mode entered from input at the start of a tick (jump, dodge) is simulated in that tick
// and its modeTime counts it; a mode entered at the end of a tick (fall, slide, landing, grounded)
// starts at modeTime 0 and is simulated from the next tick. Timed modes end at the end of the tick
// whose modeTime reaches their duration. At 60 Hz the dodge moves for 21 ticks (0.35 s), the hard
// landing ignores input for 24 ticks (0.4 s), i-frames cover 15 ticks (0.25 s) and the coyote window
// takes a jump on the 6 ticks (0.1 s) after the character left the ground. Climbing: 12 pushing ticks
// (0.2 s) attach, climbAttach holds 9 ticks (0.15 s), a ClimbLeap moves 24 ticks (0.4 s, 2 m) and a
// mantle 27 ticks (0.45 s). Gliding: the deploy is entered from the jump press and lasts 18 ticks (0.3 s),
// its last tick turns into glide with `glideStarted`.
//
// Rates. A time limit L becomes tickTime(L) = max(1, ⌊L/dt⌋)·dt, so acceleration reaches the target in
// 9 ticks (0.15 s), deceleration stops from sprint speed in 7 ticks (≤ 0.12 s; a plain 75 m/s² would
// need 8) and heading and facing turn 180° in 9 ticks (0.15 s).

import {
  addScaled,
  angleDelta,
  approach,
  copyV3,
  DEG2RAD,
  dirFromYaw,
  dot,
  isFiniteNum,
  isFiniteV3,
  length,
  lengthSq,
  normalize,
  scale,
  sub,
  wrapAngle,
  yawFromDir,
} from '../../core/math';
import type { Vec3 } from '../../core/types';
import type { CharacterId } from '../../data/ids';
import { canStart, stepStamina, type StaminaActivity, type StaminaState } from '../../logic/stamina';
import type { GroundHit, SurfaceHit, SweepHit } from '../../physics/types';
import {
  chestPoint,
  climbBasis,
  climbMoveDir,
  depenetrate,
  feetFromChest,
  findMantleTarget,
  headClear,
  intoWall,
  nearestClimbSurface,
  sweepAlongWall,
  turnNormal,
  wallToAttach,
  withoutPositive,
  type ClimbBasis,
} from './climb';
import {
  ACCEL_TIME,
  AIR_CONTROL,
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  CLIMB_ATTACH_PUSH_TIME,
  CLIMB_ATTACH_TIME,
  CLIMB_GROUND_DISTANCE,
  CLIMB_LEAP_DISTANCE,
  CLIMB_LEAP_TIME,
  CLIMB_NORMAL_BLEND_TIME,
  CLIMB_REATTACH_DELAY,
  CLIMB_SPEED,
  CLIMB_SURFACE_OFFSET,
  COYOTE_TIME,
  DECEL_TIME,
  DODGE_DURATION,
  DODGE_IFRAMES,
  DODGE_SPEED,
  GLIDE_DEPLOY_BRAKE,
  GLIDE_DEPLOY_TIME,
  GLIDE_GROUND_PROBE,
  GLIDE_MAX_DESCENT_SPEED,
  GLIDE_MIN_GROUND_CLEARANCE,
  GLIDE_SPEED,
  GLIDE_TURN_RATE_DEG,
  GRAVITY,
  GROUND_SNAP_DISTANCE,
  HARD_LANDING_HEIGHT,
  HARD_LANDING_STAGGER,
  JUMP_SPEED,
  MANTLE_TIME,
  MAX_FALL_SPEED,
  RUN_SPEED,
  SLIDE_SPEED,
  SPRINT_SPEED,
  SWIM_DEPTH,
  SWIM_EXIT_PROBE,
  SWIM_FEET_DEPTH,
  SWIM_SETTLE_SPEED,
  SWIM_SPEED,
  FOOTSTEP_STRIDE,
  TURN_TIME,
  UPDRAFT_RISE_SPEED,
  UPDRAFT_TOP_SLACK,
  WADE_SPEED_FACTOR,
  WALK_SPEED,
  WALK_STICK_THRESHOLD,
  WIND_ZONE_PUSH_SPEED,
} from './constants';
import { groundClearance } from './glide';
import { classifySlope, clampAboveTerrain, clipVelocity, moveAndSlide, snapToGround, type SlideResult } from './moveAndSlide';
import { staminaActivity } from './staminaActivity';
import {
  MOVE_MODES,
  isGlideMode,
  type ConsumedPresses,
  type ControllerEvent,
  type ControllerInput,
  type ControllerState,
  type ControllerStepResult,
  type ControllerVolumes,
  type ControllerWorld,
  type MoveMode,
  type WaterSample,
} from './types';

// Tuning (implementation choices, not in the design table).
/** Stick tilt at or below this is no move input. */
const MOVE_EPS = 1e-3;
/** Horizontal speed (m/s) at or below this has no heading. */
const SPEED_EPS = 1e-6;
/** Timers at or below this have expired; timed modes end within this slack of their duration. */
const TIME_EPS = 1e-9;
/** Per-tick rates are raised by this fraction so rounding never adds a tick to a fitted limit. */
const RATE_MARGIN = 1e-6;
/** Airborne ground detection after a downward move (m below the feet). */
const LANDING_SNAP_DISTANCE = 0.05;
/**
 * Soft-lock guard for ground too steep to stand on: the capsule is lifted SUPPORT_LIFT along the
 * ground normal and swept SUPPORT_PROBE downhill. When that is blocked (a crease between two slopes,
 * a slope running into a wall) the character cannot slide any further, so it stands there.
 */
const SUPPORT_LIFT = 0.02;
const SUPPORT_PROBE = 0.05;
/**
 * A grounded move stopped only by walkable contacts that got less than this fraction of its horizontal
 * displacement is retried GROUND_UNSTICK_LIFT higher (well inside GROUND_SNAP_DISTANCE).
 */
const GROUND_STALL_FRACTION = 0.1;
const GROUND_UNSTICK_LIFT = 0.05;

/** Horizontal distance between two feet positions. */
function horizontalGain(from: Readonly<Vec3>, to: Readonly<Vec3>): number {
  return Math.hypot(to.x - from.x, to.z - from.z);
}

/** The slide hit only walkable surfaces yet moved (almost) nowhere: ground inside the skin gap ahead. */
function stalledOnGround(from: Readonly<Vec3>, delta: Readonly<Vec3>, res: Readonly<SlideResult>): boolean {
  const wanted = Math.hypot(delta.x, delta.z);
  return wanted > 1e-6 && res.hits.length > 0 && !res.blocked && !res.steppedUp && horizontalGain(from, res.pos) < wanted * GROUND_STALL_FRACTION;
}

/** Modes on the wall: Stamina running out there lets go (Req 18.7). */
const ON_WALL: ReadonlySet<MoveMode> = new Set<MoveMode>(['climbAttach', 'climb', 'climbLeap']);
/** A move input within 45° of a wall's inward normal pushes into it (attach, Req 18.2). */
const CLIMB_PUSH_COS = Math.SQRT1_2;
/** Vertical climb moves below −this (m per tick) count as climbing down (Req 18.8); others check the mantle. */
const CLIMB_DOWN_EPS = 1e-6;

const up = (): Vec3 => ({ x: 0, y: 1, z: 0 });
const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });

/** Sanitised input of one tick. */
interface Intent {
  /** World-space unit direction of the move input; null when the tilt is at most MOVE_EPS. */
  dir: { x: number; z: number } | null;
  /** Stick tilt in [0, 1] (0 without a direction). */
  tilt: number;
  sprint: boolean;
  walk: boolean;
  jump: boolean;
  dodge: boolean;
  /** The climb / glide release (C) was pressed this tick. */
  release: boolean;
}

/** walk: standable. slide: a 50–65° slope that is not standable. none: no ground, or too steep. */
type GroundKind = 'walk' | 'slide' | 'none';

interface GroundContact {
  kind: GroundKind;
  /** Feet placed on the contact (the probed position when kind is 'none'). */
  pos: Vec3;
  normal: Vec3;
}

/** Mutable working copy of one tick; turned into the next ControllerState at the end. */
interface Tick {
  readonly world: ControllerWorld;
  /** Water, Updraft and Wind_Zone volumes; null: none. */
  readonly volumes: ControllerVolumes | null;
  readonly dt: number;
  readonly input: Intent;
  /** Stamina at the start of the tick (canStart checks). */
  readonly stamina: Readonly<StaminaState>;
  /** The coyote window was open at the start of the tick (checked before this tick's countdown). */
  readonly coyote: boolean;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  mode: MoveMode;
  modeTime: number;
  grounded: boolean;
  groundNormal: Vec3;
  wading: boolean;
  stride: number;
  climbNormal: Vec3 | null;
  climbPush: number;
  climbCooldown: number;
  mantleTarget: Vec3 | null;
  fallStartY: number;
  iFrames: number;
  coyoteTime: number;
  activity: StaminaActivity;
  /** Sweep hits of this tick's last ground or air move (attach checks). */
  contacts: SweepHit[];
  readonly events: ControllerEvent[];
  readonly consumed: ConsumedPresses;
  /** Cleared when a collision step produced a non-finite result: the tick is then discarded. */
  valid: boolean;
}

/**
 * Advances the player controller by one fixed tick of `dt` seconds and returns the new state, the
 * new party stamina, the events of the tick and the buffered presses it used. Stamina is charged
 * through stepStamina with the tick's mode summed up as one activity (staminaActivity: 'sprint',
 * 'dodge' on the dodge's first tick, else 'none' for the ground modes) and the passive of `character`,
 * the Active_Character at call time, so a party switch applies the new passive from the next tick
 * (Req 17.6). New sprints, dodges, climbs, leaps and glides ask canStart first (Req 17.4); an `exhausted`
 * event marks the tick stamina runs out (Req 17.3), and on the wall or in the glide that tick also lets go
 * (Req 18.7, 19.5). A swim that ends its tick with no Stamina left becomes `locked` with `recoveryNeeded`
 * (Req 16.11). `volumes` gives the water, Updraft and Wind_Zone volumes (none when omitted).
 *
 * NaN policy (step 6): a non-positive or non-finite `dt`, a state holding a non-finite number or an
 * unknown mode, or a tick whose collision steps or result turn non-finite returns a copy of the
 * input state and stamina with no events and nothing consumed.
 */
export function stepController(
  s: Readonly<ControllerState>,
  input: Readonly<ControllerInput>,
  world: ControllerWorld,
  stamina: Readonly<StaminaState>,
  character: CharacterId,
  dt: number,
  volumes: ControllerVolumes | null = null,
): ControllerStepResult {
  if (!(isFiniteNum(dt) && dt > 0) || !isValidState(s)) return unchanged(s, stamina);
  const t = beginTick(s, input, world, volumes, stamina, dt);
  switch (t.mode) {
    case 'grounded':
      groundedTick(t);
      break;
    case 'slide':
      slideTick(t);
      break;
    case 'jump':
    case 'fall':
      airTick(t);
      break;
    case 'landing':
      landingTick(t);
      break;
    case 'dodge':
      dodgeTick(t);
      break;
    case 'climbAttach':
      climbAttachTick(t);
      break;
    case 'climb':
      climbTick(t);
      break;
    case 'climbLeap':
      climbLeapTick(t);
      break;
    case 'mantle':
      mantleTick(t);
      break;
    case 'glideDeploy':
    case 'glide':
      glideTick(t);
      break;
    case 'swim':
      swimTick(t);
      break;
    default: // hurt, downed, locked
      passiveTick(t);
      break;
  }
  if (!t.valid) return unchanged(s, stamina);

  const nextStamina = stepStamina(stamina, t.activity, character, dt);
  if (nextStamina.exhausted && !stamina.exhausted) t.events.push({ type: 'exhausted' });
  if (nextStamina.exhausted && ON_WALL.has(t.mode)) dropFromWall(t, 0);
  if (nextStamina.exhausted && isGlideMode(t.mode)) leaveGlide(t); // Req 19.5
  if (t.mode === 'swim' && !(nextStamina.value > 0)) giveOutSwimming(t); // Req 16.11
  finishTick(t);
  const state = toState(t);
  if (!isValidState(state) || !isValidStamina(nextStamina)) return unchanged(s, stamina);
  return { state, stamina: nextStamina, events: t.events, consumed: t.consumed };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** Idle · walk · run · sprint; jump and dodge start from here. */
function groundedTick(t: Tick): void {
  if (t.input.jump) {
    startJump(t);
    airTick(t);
    return;
  }
  if (t.input.dodge && canStart(t.stamina, 'dodge')) {
    startDodge(t);
    dodgeTick(t);
    return;
  }
  const target = groundTarget(t);
  t.activity = staminaActivity('grounded', { sprinting: target.sprinting });
  steer(t, target.speed * (t.wading ? WADE_SPEED_FACTOR : 1), true); // Req 16.9: −20 % while wading
  const from = copyV3(t.pos);
  const ground = groundMove(t);
  t.modeTime += t.dt;
  if (tryEnterWater(t)) return;
  if (ground === 'walk') {
    t.wading = wadingAt(t);
    countSteps(t, from);
    climbPushTick(t);
    return;
  }
  // Left standable ground without jumping: the coyote window opens.
  t.coyoteTime = COYOTE_TIME;
  if (ground === 'slide') setMode(t, 'slide');
  else startFall(t);
}

/**
 * Dodge (Req 16.8): DODGE_SPEED along the dodge direction for DODGE_DURATION (4 m), on the ground
 * with step-up. The direction lives in the velocity, which walls do not clip; at the end the
 * character keeps running speed if a direction is held, else stops.
 */
function dodgeTick(t: Tick): void {
  const dir = dodgeDirection(t);
  t.vel = { x: dir.x * DODGE_SPEED, y: 0, z: dir.z * DODGE_SPEED };
  const ground = groundMove(t);
  t.modeTime += t.dt;
  if (tryEnterWater(t)) return;
  if (ground === 'slide') {
    setMode(t, 'slide');
    return;
  }
  if (ground === 'none') {
    startFall(t);
    return;
  }
  if (t.modeTime >= DODGE_DURATION - TIME_EPS) {
    const keep = t.input.dir !== null ? Math.min(DODGE_SPEED, RUN_SPEED) : 0;
    t.vel = { x: dir.x * keep, y: 0, z: dir.z * keep };
    setMode(t, 'grounded');
  }
}

/**
 * Jump and fall (Req 16.3, 16.4): air control, gravity, the apex (jump → fall) and landing. A fall
 * that started by walking off a ledge still takes a ground jump while the coyote window is open (and
 * the glider is not considered then). Otherwise a jump press in a fall deploys the glider when it can
 * (tryDeploy, Req 19.1); presses it cannot take are left in the buffer, so one made shortly before
 * landing fires on landing (tryLand) and one during a hard landing expires.
 */
function airTick(t: Tick): void {
  if (t.mode === 'fall' && t.input.jump && !t.consumed.jump) {
    if (t.coyote) startJump(t);
    else if (tryDeploy(t)) return;
  }
  airSteer(t);
  const vy = airMove(t);
  if (!t.valid) return;
  t.modeTime += t.dt;
  if (tryAirAttach(t)) return;
  if (vy <= 0 && tryEnterWater(t)) return; // coming down into deep water swims instead of landing on its bed
  if (t.mode === 'jump' && t.vel.y <= 0) setMode(t, 'fall');
  if (vy <= 0) tryLand(t);
}

/** Hard-landing lock (Req 16.5): input is ignored while the character brakes for HARD_LANDING_STAGGER. */
function landingTick(t: Tick): void {
  steer(t, 0, false);
  const ground = groundMove(t);
  t.modeTime += t.dt;
  if (tryEnterWater(t)) return;
  if (ground === 'slide') setMode(t, 'slide');
  else if (ground === 'none') startFall(t);
  else if (t.modeTime >= HARD_LANDING_STAGGER - TIME_EPS) setMode(t, 'grounded');
}

/**
 * Slide (step 5, Req 16.6): down a 50–65° slope toward SLIDE_SPEED along the surface until the
 * ground is standable again (grounded) or gone (fall). Only a coyote jump leaves it by input.
 */
function slideTick(t: Tick): void {
  if (t.coyote && t.input.jump) {
    startJump(t);
    airTick(t);
    return;
  }
  const target = scale(downhill(t.groundNormal), SLIDE_SPEED);
  t.vel = approachV3(t.vel, target, accelStep(SLIDE_SPEED, t.dt));
  const res = moveAndSlide(t.world, t.pos, scale(t.vel, t.dt));
  if (!res.valid) {
    t.valid = false;
    return;
  }
  t.pos = res.pos;
  t.vel = clipVelocity(t.vel, res.normals);
  t.modeTime += t.dt;
  if (tryEnterWater(t)) return;
  const g = probeGround(t.world, t.pos, GROUND_SNAP_DISTANCE);
  if (g.kind === 'none') {
    startFall(t);
    return;
  }
  t.pos = g.pos;
  t.groundNormal = g.normal;
  t.fallStartY = g.pos.y;
  t.grounded = g.kind === 'walk';
  if (g.kind === 'walk') {
    t.vel.y = 0;
    setMode(t, 'grounded');
  }
}

/**
 * hurt / downed / locked: physics without input (braking on the ground, afloat at the swim height in deep water,
 * gravity in the air, landing with a `landed` event). The mode is kept; the systems that set it also end it (a
 * swimmer out of Stamina stays locked afloat until the recovery teleport).
 */
function passiveTick(t: Tick): void {
  const water = t.grounded ? null : deepWaterAt(t);
  if (water !== null) {
    swimMove(t, water.level, false);
  } else if (t.grounded) {
    steer(t, 0, false);
    const ground = groundMove(t);
    if (ground === 'none') {
      t.groundNormal = up();
      t.fallStartY = t.pos.y;
    }
  } else {
    const vy = airMove(t);
    if (t.valid && vy <= 0) {
      const g = probeGround(t.world, t.pos, LANDING_SNAP_DISTANCE);
      if (g.kind === 'walk') touchDown(t, g);
    }
  }
  t.modeTime += t.dt;
}

// ---------------------------------------------------------------------------
// Climbing (design "등반", Req 18.2–18.10)
// ---------------------------------------------------------------------------

/**
 * Grounded attach (Req 18.2): holding the move input into a climbable ≥ 65° wall at chest height for
 * CLIMB_ATTACH_PUSH_TIME attaches, unless canStart(stamina, 'climbMove') refuses (Exhausted). The push
 * time is then kept, so the attach follows once it is allowed; a tick without the push resets it.
 */
function climbPushTick(t: Tick): void {
  const wall = t.input.dir === null ? null : pushedWall(t, t.input.dir);
  if (wall === null) {
    t.climbPush = 0;
    return;
  }
  t.climbPush = Math.min(t.climbPush + t.dt, CLIMB_ATTACH_PUSH_TIME);
  if (t.climbPush >= CLIMB_ATTACH_PUSH_TIME - TIME_EPS && canStart(t.stamina, 'climbMove')) startClimbAttach(t, wall);
}

/**
 * Air attach (Req 18.2): the jump or fall move touched a climbable wall at chest height while the input
 * pushes into it. Not within CLIMB_REATTACH_DELAY of a release, and not while Exhausted.
 */
function tryAirAttach(t: Tick): boolean {
  const dir = t.input.dir;
  if (dir === null || t.climbCooldown > TIME_EPS || t.contacts.length === 0 || !canStart(t.stamina, 'climbMove')) return false;
  const wall = pushedWall(t, dir);
  if (wall === null) return false;
  startClimbAttach(t, wall);
  return true;
}

/** The climbable wall one of this tick's move contacts belongs to, when `dir` pushes into it (within 45°). */
function pushedWall(t: Tick, dir: { x: number; z: number }): SurfaceHit | null {
  for (const hit of t.contacts) {
    const into = intoWall(hit.normal);
    if (into === null || dir.x * into.x + dir.z * into.z < CLIMB_PUSH_COS) continue;
    const wall = wallToAttach(t.world, t.pos, hit.normal);
    if (wall !== null) return wall;
  }
  return null;
}

/** Attach: velocity 0, the chest seated on `wall`, facing it, `climbStarted`; climbAttach from the next tick. */
function startClimbAttach(t: Tick, wall: SurfaceHit): void {
  const n = normalize(wall.normal);
  t.vel = zero();
  t.pos = feetFromChest(addScaled(wall.point, n, CLIMB_SURFACE_OFFSET));
  t.climbNormal = n;
  faceWall(t);
  t.grounded = false;
  t.groundNormal = up();
  t.fallStartY = t.pos.y;
  t.coyoteTime = 0;
  t.climbPush = 0;
  t.events.push({ type: 'climbStarted' });
  setMode(t, 'climbAttach');
}

/** climbAttach: the grab after attaching, held on the wall without move input for CLIMB_ATTACH_TIME, then climb. */
function climbAttachTick(t: Tick): void {
  if (leaveWall(t)) return;
  t.activity = staminaActivity('climbAttach', { moving: false });
  t.vel = zero();
  if (followSurface(t, zero()) === null) {
    lostWall(t);
    return;
  }
  t.modeTime += t.dt;
  if (t.modeTime >= CLIMB_ATTACH_TIME - TIME_EPS) setMode(t, 'climb');
}

/**
 * climb (Req 18.3–18.8): C or an Exhausted pool lets go, a jump leaps, and the move input climbs at
 * CLIMB_SPEED along the wall (climbMove Stamina while it is held, climbIdle otherwise). Then the wall
 * exits: walkable ground under the feet while climbing down stands, a ledge top in reach mantles.
 */
function climbTick(t: Tick): void {
  if (leaveWall(t)) return;
  if (t.input.jump && tryClimbLeap(t)) return;
  const basis = climbBasis(wallNormal(t), t.yaw);
  const dir = topGuard(t, climbMoveDir(t.input.dir, basis), basis);
  t.activity = staminaActivity('climb', { moving: t.input.dir !== null });
  const delta = dir === null ? zero() : scale(dir, CLIMB_SPEED * t.dt);
  const surface = followSurface(t, delta);
  if (surface === null) {
    lostWall(t);
    return;
  }
  t.vel = scale(delta, 1 / t.dt);
  t.modeTime += t.dt;
  wallExit(t, surface, delta.y);
}

/**
 * ClimbLeap start (Req 18.4): toward the input on the wall (straight up without input), CLIMB_LEAP_DISTANCE
 * over CLIMB_LEAP_TIME for the flat climbLeap Stamina, simulated from this tick. Needs canStart(stamina,
 * 'climbLeap'); a leap the top guard leaves no direction for is not taken and the press stays buffered.
 */
function tryClimbLeap(t: Tick): boolean {
  if (!canStart(t.stamina, 'climbLeap')) return false;
  const basis = climbBasis(wallNormal(t), t.yaw);
  const dir = topGuard(t, climbMoveDir(t.input.dir, basis) ?? basis.up, basis);
  if (dir === null) return false;
  t.vel = scale(dir, CLIMB_LEAP_DISTANCE / CLIMB_LEAP_TIME);
  t.consumed.jump = true;
  t.activity = staminaActivity('climbLeap', { entered: true });
  setMode(t, 'climbLeap');
  climbLeapTick(t);
  return true;
}

/**
 * climbLeap: the leap velocity, kept on the wall's tangent plane at the leap speed, carries the chest along
 * the surface for CLIMB_LEAP_TIME; then it re-attaches (climb). The same exits as climb apply, C lets go
 * and losing the wall falls with the leap's momentum.
 */
function climbLeapTick(t: Tick): void {
  if (t.input.release) {
    dropFromWall(t, CLIMB_REATTACH_DELAY);
    return;
  }
  const n = wallNormal(t);
  const basis = climbBasis(n, t.yaw);
  const along = normalize(addScaled(t.vel, n, -dot(t.vel, n)));
  const dir = topGuard(t, lengthSq(along) > 0.5 ? along : null, basis);
  const speed = CLIMB_LEAP_DISTANCE / CLIMB_LEAP_TIME;
  t.vel = dir === null ? zero() : scale(dir, speed);
  const delta = scale(t.vel, t.dt);
  const surface = followSurface(t, delta);
  if (surface === null) {
    if (t.valid) dropFromWall(t, 0, t.vel);
    return;
  }
  t.modeTime += t.dt;
  if (wallExit(t, surface, delta.y)) return;
  if (dir === null || t.modeTime >= CLIMB_LEAP_TIME - TIME_EPS) {
    t.vel = zero();
    setMode(t, 'climb');
  }
}

/**
 * mantle (Req 18.5): a scripted move onto the top in MANTLE_TIME at a constant path speed, first up to the
 * top's height (the capsule stays off the wall), then over it; it ends standing with a `mantled` event.
 */
function mantleTick(t: Tick): void {
  const target = t.mantleTarget;
  if (target === null) {
    dropFromWall(t, 0);
    return;
  }
  const left = MANTLE_TIME - t.modeTime;
  t.vel = zero();
  t.modeTime += t.dt;
  if (left <= t.dt + TIME_EPS) {
    finishMantle(t, target);
    return;
  }
  const rise = Math.max(0, target.y - t.pos.y);
  const dx = target.x - t.pos.x;
  const dz = target.z - t.pos.z;
  const flat = Math.hypot(dx, dz);
  let step = ((rise + flat) * t.dt) / left;
  const dy = Math.min(step, rise);
  t.pos.y += dy;
  step -= dy;
  if (step > 0 && flat > 0) {
    const k = Math.min(1, step / flat);
    t.pos.x += dx * k;
    t.pos.z += dz * k;
  }
}

function startMantle(t: Tick, target: Vec3): void {
  t.mantleTarget = copyV3(target);
  t.vel = zero();
  setMode(t, 'mantle');
}

/** The mantle's end: feet on the top (snapped to its ground), `mantled`, grounded (a slope slides, nothing falls). */
function finishMantle(t: Tick, target: Readonly<Vec3>): void {
  t.pos = copyV3(target);
  t.mantleTarget = null;
  t.climbNormal = null;
  t.events.push({ type: 'mantled' });
  const g = probeGround(t.world, t.pos, GROUND_SNAP_DISTANCE);
  if (g.kind === 'none') {
    startFall(t);
    return;
  }
  t.pos = g.pos;
  t.groundNormal = g.normal;
  t.fallStartY = g.pos.y;
  t.grounded = g.kind === 'walk';
  setMode(t, g.kind === 'walk' ? 'grounded' : 'slide');
}

/**
 * After a wall move (`dy` its vertical part): climbing down onto walkable ground within
 * CLIMB_GROUND_DISTANCE stands (Req 18.8); otherwise a ledge top in reach starts the mantle (Req 18.5). A
 * nearest surface that is walkable ground rather than a wall ends the climb as well (standing on it, or
 * letting go). Returns whether the climb ended.
 */
function wallExit(t: Tick, surface: SurfaceHit, dy: number): boolean {
  const down = dy < -CLIMB_DOWN_EPS;
  if (down && climbDownLand(t)) return true;
  if (!down) {
    const target = findMantleTarget(t.world, t.pos, surface.normal);
    if (target !== null) {
      startMantle(t, target);
      return true;
    }
  }
  if (classifySlope(surface.normal, true) !== 'walk') return false;
  if (!climbDownLand(t)) dropFromWall(t, 0);
  return true;
}

/** Walkable ground within CLIMB_GROUND_DISTANCE under the feet: the climb ends standing on it. */
function climbDownLand(t: Tick): boolean {
  const g = probeGround(t.world, t.pos, CLIMB_GROUND_DISTANCE);
  if (g.kind !== 'walk') return false;
  t.pos = g.pos;
  t.groundNormal = g.normal;
  t.grounded = true;
  t.vel = zero();
  t.fallStartY = g.pos.y;
  t.climbNormal = null;
  setMode(t, 'grounded');
  return true;
}

/** C lets go (Req 18.6, no air re-attach for CLIMB_REATTACH_DELAY); an Exhausted pool drops the character (Req 18.7). */
function leaveWall(t: Tick): boolean {
  if (t.input.release) {
    dropFromWall(t, CLIMB_REATTACH_DELAY);
    return true;
  }
  if (t.stamina.exhausted) {
    dropFromWall(t, 0);
    return true;
  }
  return false;
}

/** No climbable surface within CLIMB_SURFACE_RADIUS of the chest: fall (unless the tick is being discarded). */
function lostWall(t: Tick): void {
  if (t.valid) dropFromWall(t, 0);
}

/** Off the wall into a fall with `vel`: the capsule is pushed out of what it sank into first. */
function dropFromWall(t: Tick, cooldown: number, vel: Readonly<Vec3> = zero()): void {
  t.pos = depenetrate(t.world, t.pos);
  t.vel = copyV3(vel);
  t.climbNormal = null;
  t.mantleTarget = null;
  t.climbCooldown = Math.max(t.climbCooldown, cooldown);
  startFall(t);
}

/**
 * Surface follow (Req 18.10, design "표면 추종"): the chest moves by `delta` (sweepAlongWall), then sits
 * CLIMB_SURFACE_OFFSET out along the normal of the nearest climbable point. climbNormal turns toward that
 * normal, or toward the adjacent face a concave sweep ran into, at 90° per CLIMB_NORMAL_BLEND_TIME, and the
 * facing looks along −climbNormal. Returns the surface, or null (feet moved with the sweep) when no
 * climbable surface is within CLIMB_SURFACE_RADIUS.
 */
function followSurface(t: Tick, delta: Readonly<Vec3>): SurfaceHit | null {
  const moved = sweepAlongWall(t.world, chestPoint(t.pos), delta);
  if (!isFiniteV3(moved.chest)) {
    t.valid = false;
    return null;
  }
  const surface = nearestClimbSurface(t.world, moved.chest);
  if (surface === null) {
    t.pos = feetFromChest(moved.chest);
    return null;
  }
  t.pos = feetFromChest(addScaled(surface.point, surface.normal, CLIMB_SURFACE_OFFSET));
  const target = moved.adopted ?? surface.normal;
  t.climbNormal = t.climbNormal === null ? copyV3(target) : turnNormal(t.climbNormal, target, normalTurnStep(t.dt));
  faceWall(t);
  return surface;
}

/**
 * At the lip of a top that cannot be mantled (the head ray misses, and the mantle check failed) the climb
 * goes no higher: the upward part of `dir` is dropped.
 */
function topGuard(t: Tick, dir: Vec3 | null, basis: ClimbBasis): Vec3 | null {
  if (dir === null || dot(dir, basis.up) <= 0 || !headClear(t.world, t.pos, wallNormal(t))) return dir;
  const side = normalize(withoutPositive(dir, basis.up));
  return lengthSq(side) > 0.5 ? side : null;
}

/** The climbed surface's normal; a climb state without one faces its wall along the yaw. */
function wallNormal(t: Tick): Vec3 {
  return t.climbNormal ?? scale(dirFromYaw(t.yaw), -1);
}

/** Yaw looking along −climbNormal (kept when the normal is nearly vertical). */
function faceWall(t: Tick): void {
  const n = t.climbNormal;
  if (n !== null && Math.hypot(n.x, n.z) > 1e-3) t.yaw = yawFromDir(-n.x, -n.z);
}

// ---------------------------------------------------------------------------
// Gliding (design "활강", Req 19.1–19.7)
// ---------------------------------------------------------------------------

/**
 * Deploy (Req 19.1): a jump press in a fall opens the glider when the downward ray finds the ground
 * GLIDE_MIN_GROUND_CLEARANCE or more below the feet (or nothing within GLIDE_GROUND_PROBE) and
 * canStart(stamina, 'glide') allows it (not Exhausted, Req 17.4). The press is consumed and glideDeploy is
 * simulated from this tick; otherwise nothing changes and the press stays buffered.
 */
function tryDeploy(t: Tick): boolean {
  if (!canStart(t.stamina, 'glide')) return false;
  const clearance = groundClearance(t.world, t.pos, GLIDE_GROUND_PROBE);
  if (clearance !== null && clearance < GLIDE_MIN_GROUND_CLEARANCE) return false;
  t.consumed.jump = true;
  setMode(t, 'glideDeploy');
  glideTick(t);
  return true;
}

/**
 * glideDeploy and glide. Exits by input first: a jump press or C falls (Req 19.3), as does an Exhausted pool
 * (Req 19.5); that fall is simulated from this tick. Then the velocity, in the design's order:
 *   1. vertical: gravity with the descent capped at GLIDE_MAX_DESCENT_SPEED, `vy = max(vy, −2.5)` (Req 19.2); a
 *      faster fall is braked at GLIDE_DEPLOY_BRAKE instead during the deploy;
 *   2. Updraft (glide only, Req 19.6): inside the column `vy = +8` up to its top, 0 at the top (hovering);
 *   3. Wind_Zone (glide only, Req 19.7): WIND_ZONE_PUSH_SPEED along the zone's direction, added to this tick's
 *      displacement only (an offset while inside the zone, never accumulated in the velocity);
 *   4. heading: turned toward the move input at up to GLIDE_TURN_RATE_DEG (kept without input), the facing
 *      follows it; the horizontal speed is GLIDE_SPEED (the deploy eases the fall's speed to it).
 * The glide Stamina activity drains every tick (Wren ×0.7 by her passive). After the airborne move the fall
 * start follows the height, so a later `landed` does not count the altitude glided from. Then the exits by
 * contact, each with `glideEnded`: a climbable wall the glide heads into attaches (climbAttach), deep water
 * (depth ≥ SWIM_DEPTH at or below its surface) swims, ground lands (tryLand, Req 19.4). The deploy's last tick
 * becomes glide with `glideStarted`.
 */
function glideTick(t: Tick): void {
  if (t.input.jump && !t.consumed.jump) {
    t.consumed.jump = true;
    leaveGlide(t);
    airTick(t);
    return;
  }
  if (t.input.release || t.stamina.exhausted) {
    leaveGlide(t);
    airTick(t);
    return;
  }
  const deploying = t.mode === 'glideDeploy';
  t.activity = staminaActivity(t.mode);

  let vy = t.vel.y;
  if (deploying && vy < -GLIDE_MAX_DESCENT_SPEED) vy = Math.min(-GLIDE_MAX_DESCENT_SPEED, vy + GLIDE_DEPLOY_BRAKE * t.dt);
  else vy = Math.max(vy - GRAVITY * t.dt, -GLIDE_MAX_DESCENT_SPEED);
  let pushX = 0;
  let pushZ = 0;
  if (!deploying && t.volumes !== null) {
    const top = updraftTopAt(t.volumes, t.pos);
    if (top !== null) vy = Math.min(UPDRAFT_RISE_SPEED, Math.max(0, (top - t.pos.y) / t.dt));
    const wind = t.volumes.windDirection(t.pos);
    const len = wind === null ? 0 : Math.hypot(wind.x, wind.z);
    if (wind !== null && isFiniteNum(len) && len > SPEED_EPS) {
      pushX = (wind.x / len) * WIND_ZONE_PUSH_SPEED;
      pushZ = (wind.z / len) * WIND_ZONE_PUSH_SPEED;
    }
  }
  const speed0 = Math.hypot(t.vel.x, t.vel.z);
  let heading = speed0 > SPEED_EPS ? yawFromDir(t.vel.x, t.vel.z) : t.yaw;
  const dir = t.input.dir;
  if (dir !== null) heading = turnToward(heading, yawFromDir(dir.x, dir.z), GLIDE_TURN_RATE_DEG * DEG2RAD * t.dt);
  const speed = deploying ? approach(speed0, GLIDE_SPEED, (GLIDE_SPEED / GLIDE_DEPLOY_TIME) * t.dt * (1 + RATE_MARGIN)) : GLIDE_SPEED;
  const along = { x: Math.sin(heading), z: Math.cos(heading) };
  t.yaw = heading;
  t.vel = { x: along.x * speed, y: vy, z: along.z * speed };

  const res = moveAndSlide(t.world, t.pos, { x: (t.vel.x + pushX) * t.dt, y: vy * t.dt, z: (t.vel.z + pushZ) * t.dt });
  if (!res.valid) {
    t.valid = false;
    return;
  }
  t.pos = res.pos;
  t.contacts = res.hits;
  t.vel = clipVelocity(t.vel, res.normals);
  t.grounded = false;
  t.groundNormal = up();
  t.fallStartY = t.pos.y;
  t.modeTime += t.dt;

  if (tryGlideAttach(t, along)) return;
  if (glideIntoWater(t)) return;
  if (vy <= 0 && glideLand(t)) return;
  if (deploying && t.modeTime >= GLIDE_DEPLOY_TIME - TIME_EPS) {
    setMode(t, 'glide');
    t.events.push({ type: 'glideStarted' });
  }
}

/**
 * Top of the Updraft the feet are in; feet up to UPDRAFT_TOP_SLACK above a column's top still count (they are
 * at the top), so the glider hovers there.
 */
function updraftTopAt(volumes: ControllerVolumes, feet: Readonly<Vec3>): number | null {
  const top = volumes.updraftTop(feet) ?? volumes.updraftTop({ x: feet.x, y: feet.y - UPDRAFT_TOP_SLACK, z: feet.z });
  return top !== null && isFiniteNum(top) ? top : null;
}

/**
 * Air attach from a glide (Req 18.2, 19.4): this tick's move touched a climbable wall at chest height that the
 * glide heading (or else the move input) points into; not within CLIMB_REATTACH_DELAY of a release, and not
 * while Exhausted (canStart 'climbMove').
 */
function tryGlideAttach(t: Tick, heading: { x: number; z: number }): boolean {
  if (t.climbCooldown > TIME_EPS || t.contacts.length === 0 || !canStart(t.stamina, 'climbMove')) return false;
  const wall = pushedWall(t, heading) ?? (t.input.dir === null ? null : pushedWall(t, t.input.dir));
  if (wall === null) return false;
  t.events.push({ type: 'glideEnded' });
  startClimbAttach(t, wall);
  return true;
}

/** Deep water under the glider (depth ≥ SWIM_DEPTH, feet at or below its surface): the glide ends in `swim`. */
function glideIntoWater(t: Tick): boolean {
  if (deepWaterAt(t) === null) return false;
  t.events.push({ type: 'glideEnded' });
  startSwim(t);
  return true;
}

/** Ground within LANDING_SNAP_DISTANCE under a gliding descent: `glideEnded`, then the landing of a fall (tryLand). */
function glideLand(t: Tick): boolean {
  if (probeGround(t.world, t.pos, LANDING_SNAP_DISTANCE).kind === 'none') return false;
  t.events.push({ type: 'glideEnded' });
  setMode(t, 'fall');
  tryLand(t);
  return true;
}

/** The glide ends in a fall (jump, C, Stamina 0) with `glideEnded`; the fall height counts from here. */
function leaveGlide(t: Tick): void {
  t.events.push({ type: 'glideEnded' });
  startFall(t);
}

// ---------------------------------------------------------------------------
// Water (design "수영·얕은 물", Req 16.9–16.11)
// ---------------------------------------------------------------------------

/**
 * Deep water (Req 16.10, 19.4): the swim mode with `enteredWater`, simulated from the next tick. The vertical speed stops
 * (no gravity while swimming); the feet then settle to their swim height under the surface.
 */
function startSwim(t: Tick): void {
  t.vel.y = 0;
  t.grounded = false;
  t.groundNormal = up();
  t.fallStartY = t.pos.y;
  t.coyoteTime = 0;
  t.climbNormal = null;
  t.mantleTarget = null;
  t.events.push({ type: 'enteredWater' });
  setMode(t, 'swim');
}

/**
 * Entry into the swim after a move (grounded, landing, slide, dodge, a descending jump or fall; the glide has its own
 * check with `glideEnded`): water at least SWIM_DEPTH deep (level − terrain height) with the feet at or under its surface.
 */
function tryEnterWater(t: Tick): boolean {
  if (deepWaterAt(t) === null) return false;
  startSwim(t);
  return true;
}

/**
 * swim (Req 16.10): surface swimming without gravity (swimMove) with the `swim` Stamina activity while the move input is
 * held (6/s, Isla ×0.6 by her passive; treading water drains nothing), then the exits: walkable ground within
 * SWIM_EXIT_PROBE under the swimming feet stands on the shore (grounded; wading follows where it is shallow), and no
 * water under the character any more falls. Stamina running out is handled after the Stamina step (giveOutSwimming).
 */
function swimTick(t: Tick): void {
  const water = waterSample(t);
  if (water === null) {
    startFall(t);
    airTick(t);
    return;
  }
  t.activity = staminaActivity('swim', { moving: t.input.dir !== null });
  swimMove(t, water.level, true);
  if (!t.valid) return;
  t.modeTime += t.dt;
  swimExit(t);
}

/**
 * One tick afloat on the surface at `level` (swim, and the passive modes in deep water). The horizontal velocity steers
 * like the ground's (acceleration, braking and turn limits) toward the move input at SWIM_SPEED, or brakes without it
 * (or with `useInput` false). The feet move toward the swim height level − SWIM_FEET_DEPTH at up to SWIM_SETTLE_SPEED
 * and are then held exactly there, so the capsule is fixed to the level with the head above the surface. The move is
 * an airborne collide-and-slide; like the ground moves, walls deflect the displacement, not the steered velocity.
 */
function swimMove(t: Tick, level: number, useInput: boolean): void {
  steer(t, useInput ? SWIM_SPEED : 0, useInput);
  const settle = SWIM_SETTLE_SPEED * t.dt;
  const dy = Math.max(-settle, Math.min(settle, level - SWIM_FEET_DEPTH - t.pos.y));
  const res = moveAndSlide(t.world, t.pos, { x: t.vel.x * t.dt, y: dy, z: t.vel.z * t.dt });
  if (!res.valid) {
    t.valid = false;
    return;
  }
  t.pos = res.pos;
  t.contacts = res.hits;
  t.vel.y = 0;
  t.grounded = false;
  t.groundNormal = up();
  t.fallStartY = t.pos.y;
}

/**
 * The swim's exits after its move. The shore probe starts from the swim height (or the feet when they are still above
 * it), so feet still rising from the bed of water that is deep enough do not count its bottom as a shore.
 */
function swimExit(t: Tick): void {
  const water = waterSample(t);
  if (water === null) {
    startFall(t);
    return;
  }
  const from = { x: t.pos.x, y: Math.max(t.pos.y, water.level - SWIM_FEET_DEPTH), z: t.pos.z };
  const g = probeGround(t.world, from, SWIM_EXIT_PROBE);
  if (g.kind !== 'walk') return;
  t.pos = g.pos;
  t.groundNormal = g.normal;
  t.grounded = true;
  t.vel.y = 0;
  t.fallStartY = g.pos.y;
  setMode(t, 'grounded');
}

/**
 * Req 16.11: Stamina ran out while swimming. The character stops and is `locked` (afloat, no input) with
 * `recoveryNeeded`; the adapter's RecoverySystem fades out, teleports it to the last Safe_Position and so ends the lock.
 */
function giveOutSwimming(t: Tick): void {
  t.vel = zero();
  t.events.push({ type: 'recoveryNeeded' });
  setMode(t, 'locked');
}

/** A step every FOOTSTEP_STRIDE of ground walked from `from`; a wading step emits `footstep{material: 'water'}` (Req 16.9). */
function countSteps(t: Tick, from: Readonly<Vec3>): void {
  t.stride += horizontalGain(from, t.pos);
  if (t.stride < FOOTSTEP_STRIDE) return;
  t.stride %= FOOTSTEP_STRIDE;
  if (t.wading) t.events.push({ type: 'footstep', material: 'water' });
}

/** The water column at the feet's (x, z), or null where there is none (or it is not finite). */
function waterSample(t: Tick): WaterSample | null {
  const water = t.volumes?.water(t.pos.x, t.pos.z) ?? null;
  return water !== null && isFiniteNum(water.level) && isFiniteNum(water.depth) ? water : null;
}

/** The water the feet are in: a column whose surface is at or above them (walking a bridge over a river is not). */
function waterAtFeet(t: Tick): WaterSample | null {
  const water = waterSample(t);
  return water !== null && t.pos.y <= water.level ? water : null;
}

/** Water to swim in around the feet: depth = level − terrain height ≥ SWIM_DEPTH (Req 16.10). */
function deepWaterAt(t: Tick): WaterSample | null {
  const water = waterAtFeet(t);
  return water !== null && water.depth >= SWIM_DEPTH ? water : null;
}

/** Wading (Req 16.9): standing with the feet in water shallower than SWIM_DEPTH. */
function wadingAt(t: Tick): boolean {
  if (!t.grounded) return false;
  const water = waterAtFeet(t);
  return water !== null && water.depth < SWIM_DEPTH;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function setMode(t: Tick, mode: MoveMode): void {
  if (t.mode === mode) return;
  t.mode = mode;
  t.modeTime = 0;
}

/** Ground jump (Req 16.3): JUMP_SPEED up, horizontal velocity kept; consumes the buffered jump. */
function startJump(t: Tick): void {
  t.vel.y = JUMP_SPEED;
  t.grounded = false;
  t.groundNormal = up();
  t.fallStartY = t.pos.y;
  t.coyoteTime = 0;
  t.consumed.jump = true;
  t.events.push({ type: 'jumped' });
  setMode(t, 'jump');
}

/**
 * Dodge start (Req 16.8, 24.8): toward the move input (facing snaps to it) or, without input,
 * backward from the facing. Charges the dodge once and sets the i-frames after this tick's countdown.
 */
function startDodge(t: Tick): void {
  const dir = t.input.dir;
  let dx: number;
  let dz: number;
  if (dir !== null) {
    dx = dir.x;
    dz = dir.z;
    t.yaw = yawFromDir(dx, dz);
  } else {
    const facing = dirFromYaw(t.yaw);
    dx = -facing.x;
    dz = -facing.z;
  }
  t.vel = { x: dx * DODGE_SPEED, y: 0, z: dz * DODGE_SPEED };
  t.iFrames = DODGE_IFRAMES;
  t.consumed.dodge = true;
  t.activity = staminaActivity('dodge', { entered: true });
  setMode(t, 'dodge');
}

function startFall(t: Tick): void {
  setMode(t, 'fall');
  t.grounded = false;
  t.groundNormal = up();
  t.fallStartY = t.pos.y;
}

/**
 * After a downward air move: standable ground within LANDING_SNAP_DISTANCE lands (Req 16.5). A fall
 * of HARD_LANDING_HEIGHT or more locks into `landing` and leaves a buffered jump to expire; a
 * shorter one lands in `grounded` and a buffered jump fires the same tick. A slide slope starts a
 * slide without a landing.
 */
function tryLand(t: Tick): void {
  const g = probeGround(t.world, t.pos, LANDING_SNAP_DISTANCE);
  if (g.kind === 'none') return;
  if (g.kind === 'slide') {
    t.pos = g.pos;
    t.groundNormal = g.normal;
    t.fallStartY = g.pos.y;
    setMode(t, 'slide');
    return;
  }
  if (touchDown(t, g) >= HARD_LANDING_HEIGHT) {
    setMode(t, 'landing');
    return;
  }
  setMode(t, 'grounded');
  if (t.input.jump && !t.consumed.jump) startJump(t);
}

/**
 * Puts the feet on standable ground and emits `landed`. Returns the fall height: the highest point
 * since leaving the ground minus the landing height.
 */
function touchDown(t: Tick, g: GroundContact): number {
  const fallHeight = Math.max(0, t.fallStartY - g.pos.y);
  t.pos = g.pos;
  t.groundNormal = g.normal;
  t.grounded = true;
  t.vel.y = 0;
  t.fallStartY = g.pos.y;
  t.coyoteTime = 0;
  t.events.push({ type: 'landed', fallHeight });
  return fallHeight;
}

// ---------------------------------------------------------------------------
// Steering and moves
// ---------------------------------------------------------------------------

/** Ground speed class (Req 16.1): walk at tilt ≤ 0.5 or with walk toggled, sprint while held and not exhausted. */
function groundTarget(t: Tick): { speed: number; sprinting: boolean } {
  const i = t.input;
  if (i.dir === null) return { speed: 0, sprinting: false };
  if (i.walk || i.tilt <= WALK_STICK_THRESHOLD) return { speed: WALK_SPEED, sprinting: false };
  if (i.sprint && canStart(t.stamina, 'sprint')) return { speed: SPRINT_SPEED, sprinting: true };
  return { speed: RUN_SPEED, sprinting: false };
}

/**
 * Ground steering (step 1, Req 16.2), speed and heading tracked separately. The speed moves toward
 * the target by the fitted acceleration (0 → target in ACCEL_TIME) or deceleration (from up to
 * sprint speed to 0 within DECEL_TIME). With input the heading and the facing turn toward it at
 * 180° per TURN_TIME, and from a standstill the heading takes the input direction at once. Without
 * input (or with `useInput` false) the heading and facing are kept and the speed brakes to 0.
 */
function steer(t: Tick, targetSpeed: number, useInput: boolean): void {
  const dir = useInput ? t.input.dir : null;
  const speed0 = Math.hypot(t.vel.x, t.vel.z);
  let heading = speed0 > SPEED_EPS ? yawFromDir(t.vel.x, t.vel.z) : t.yaw;
  let target = 0;
  if (dir !== null) {
    const want = yawFromDir(dir.x, dir.z);
    const turn = turnStep(t.dt);
    heading = speed0 > SPEED_EPS ? turnToward(heading, want, turn) : want;
    t.yaw = turnToward(t.yaw, want, turn);
    target = targetSpeed;
  }
  const step = target >= speed0 ? accelStep(target, t.dt) : decelStep(speed0, t.dt);
  const speed = approach(speed0, target, step);
  t.vel.x = Math.sin(heading) * speed;
  t.vel.z = Math.cos(heading) * speed;
}

/**
 * Air control (Req 16.3): AIR_CONTROL (60 %) of the ground acceleration and turn rate. With input
 * the horizontal velocity moves toward the input direction at max(class speed, current speed up to
 * the dodge speed), so momentum is kept but never grows; without input it is kept unchanged.
 */
function airSteer(t: Tick): void {
  const dir = t.input.dir;
  if (dir === null) return;
  const cls = t.input.walk || t.input.tilt <= WALK_STICK_THRESHOLD ? WALK_SPEED : RUN_SPEED;
  const speed = Math.max(cls, Math.min(Math.hypot(t.vel.x, t.vel.z), DODGE_SPEED));
  const step = AIR_CONTROL * accelStep(cls, t.dt);
  const dx = dir.x * speed - t.vel.x;
  const dz = dir.z * speed - t.vel.z;
  const d = Math.hypot(dx, dz);
  const k = d > step ? step / d : 1;
  t.vel.x += dx * k;
  t.vel.z += dz * k;
  t.yaw = turnToward(t.yaw, yawFromDir(dir.x, dir.z), AIR_CONTROL * turnStep(t.dt));
}

/**
 * Steps 2–4 on the ground: the horizontal velocity is moved with grounded collide-and-slide (0.45 m
 * step-up, steep contacts act as walls) and the feet snap onto ground within GROUND_SNAP_DISTANCE.
 * Walls deflect only the displacement: clipping the stored velocity would lock the turn-limited
 * heading onto the wall tangent, so a push almost straight into a wall would slide along it at
 * nearly full speed instead of 6·cos θ.
 */
function groundMove(t: Tick): GroundKind {
  t.vel.y = 0;
  const delta: Vec3 = { x: t.vel.x * t.dt, y: 0, z: t.vel.z * t.dt };
  let res = moveAndSlide(t.world, t.pos, delta, { grounded: true });
  if (!res.valid) {
    t.valid = false;
    return 'none';
  }
  if (stalledOnGround(t.pos, delta, res)) {
    // Walkable ground rising just ahead inside the skin gap stops every sweep at 0 distance (bilinear
    // terrain creases), so the move would stall there for good. Sweep again from slightly higher; the
    // ground snap below puts the feet back down.
    const lifted = moveAndSlide(t.world, { x: t.pos.x, y: t.pos.y + GROUND_UNSTICK_LIFT, z: t.pos.z }, delta, { grounded: true });
    if (lifted.valid && horizontalGain(t.pos, lifted.pos) > horizontalGain(t.pos, res.pos)) res = lifted;
  }
  t.pos = res.pos;
  t.contacts = res.hits;
  const g = probeGround(t.world, t.pos, GROUND_SNAP_DISTANCE);
  if (g.kind !== 'none') {
    t.pos = g.pos;
    t.groundNormal = g.normal;
    t.fallStartY = g.pos.y;
  }
  t.grounded = g.kind === 'walk';
  return g.kind;
}

/**
 * Gravity (trapezoid over the tick, vertical speed capped at MAX_FALL_SPEED) and an airborne
 * collide-and-slide; contacts clip the velocity. Returns the vertical speed before contacts.
 */
function airMove(t: Tick): number {
  const vy0 = t.vel.y;
  const vy1 = Math.max(vy0 - GRAVITY * t.dt, -MAX_FALL_SPEED);
  const res = moveAndSlide(t.world, t.pos, { x: t.vel.x * t.dt, y: 0.5 * (vy0 + vy1) * t.dt, z: t.vel.z * t.dt });
  if (!res.valid) {
    t.valid = false;
    return vy1;
  }
  t.pos = res.pos;
  t.contacts = res.hits;
  t.vel = clipVelocity({ x: t.vel.x, y: vy1, z: t.vel.z }, res.normals);
  t.grounded = false;
  t.groundNormal = up();
  if (t.pos.y > t.fallStartY) t.fallStartY = t.pos.y;
  return vy1;
}

/** The dodge direction kept in the velocity; backward from the facing if it was lost. */
function dodgeDirection(t: Tick): { x: number; z: number } {
  const speed = Math.hypot(t.vel.x, t.vel.z);
  if (speed > SPEED_EPS) return { x: t.vel.x / speed, z: t.vel.z / speed };
  const facing = dirFromYaw(t.yaw);
  return { x: -facing.x, z: -facing.z };
}

// ---------------------------------------------------------------------------
// Ground classification
// ---------------------------------------------------------------------------

/** Ground within `maxSnap` below the feet (step 4), classified; `pos` is the snapped feet position. */
function probeGround(world: ControllerWorld, pos: Readonly<Vec3>, maxSnap: number): GroundContact {
  const snap = snapToGround(world, pos, maxSnap);
  if (snap.hit === null) return { kind: 'none', pos: copyV3(pos), normal: up() };
  return { kind: groundKind(world, snap.pos, snap.hit), pos: snap.pos, normal: copyV3(snap.hit.normal) };
}

/**
 * Step 5 (Req 16.6). Standable ground walks: the terrain by slope alone (TerrainField.walkable also
 * folds in water depth and the world-edge buffer, which are not about standing), colliders by
 * hit.walkable (walkableTop and slope). Ground the character cannot slide off also walks
 * (isSupported); otherwise a 50–65° slope slides and anything steeper is not ground.
 */
function groundKind(world: ControllerWorld, feet: Readonly<Vec3>, hit: GroundHit): GroundKind {
  const slope = classifySlope(hit.normal, false);
  if (hit.colliderId === null ? slope === 'walk' : hit.walkable) return 'walk';
  if (isSupported(world, feet, hit.normal)) return 'walk';
  return slope === 'slide' ? 'slide' : 'none';
}

/** Whether a short downhill sweep just off the surface with normal `n` is blocked (see SUPPORT_LIFT). */
function isSupported(world: ControllerWorld, feet: Readonly<Vec3>, n: Readonly<Vec3>): boolean {
  const d = downhill(n);
  if (lengthSq(d) < 0.5) return false; // flat or degenerate normal: no downhill direction
  const from = addScaled(feet, n, SUPPORT_LIFT);
  return world.sweepCapsule(from, addScaled(from, d, SUPPORT_PROBE), CAPSULE_RADIUS, CAPSULE_HEIGHT) !== null;
}

/** Unit vector down the slope with normal n (−Y projected onto its plane); zero on flat ground. */
function downhill(n: Readonly<Vec3>): Vec3 {
  return normalize({ x: n.x * n.y, y: n.y * n.y - 1, z: n.z * n.y });
}

// ---------------------------------------------------------------------------
// Tick setup and finish
// ---------------------------------------------------------------------------

function beginTick(
  s: Readonly<ControllerState>,
  input: Readonly<ControllerInput>,
  world: ControllerWorld,
  volumes: ControllerVolumes | null,
  stamina: Readonly<StaminaState>,
  dt: number,
): Tick {
  const t: Tick = {
    world,
    volumes,
    dt,
    input: readIntent(input),
    stamina,
    coyote: s.coyoteTime > TIME_EPS,
    pos: copyV3(s.pos),
    vel: copyV3(s.vel),
    yaw: s.yaw,
    mode: s.mode,
    modeTime: s.modeTime,
    grounded: s.grounded,
    groundNormal: copyV3(s.groundNormal),
    wading: s.wading,
    stride: s.mode === 'grounded' ? s.stride : 0,
    climbNormal: s.climbNormal === null ? null : copyV3(s.climbNormal),
    climbPush: s.mode === 'grounded' ? s.climbPush : 0,
    climbCooldown: countDown(s.climbCooldown, dt),
    mantleTarget: s.mantleTarget === null ? null : copyV3(s.mantleTarget),
    fallStartY: s.fallStartY,
    iFrames: countDown(s.iFrames, dt),
    coyoteTime: countDown(s.coyoteTime, dt),
    activity: 'none',
    contacts: [],
    events: [],
    consumed: { jump: false, dodge: false },
    valid: true,
  };
  t.wading = wadingAt(t); // the water query of the tick's start position (the wading speed)
  return t;
}

/** Move input from the adapter: non-finite components count as 0, the tilt is clamped to 1. */
function readIntent(input: Readonly<ControllerInput>): Intent {
  const x = isFiniteNum(input.move.x) ? input.move.x : 0;
  const z = isFiniteNum(input.move.z) ? input.move.z : 0;
  const len = Math.hypot(x, z);
  const moving = len > MOVE_EPS;
  return {
    dir: moving ? { x: x / len, z: z / len } : null,
    tilt: moving ? Math.min(1, len) : 0,
    sprint: input.sprint === true,
    walk: input.walk === true,
    jump: input.jump === true,
    dodge: input.dodge === true,
    release: input.release === true,
  };
}

/**
 * Steps 6–7: per-mode horizontal speed limit, the fall-speed cap and the terrain clamp
 * y ≥ heightAt(x, z) (Req 20.1), which also stops any downward speed. Then the wading flag of the final position.
 */
function finishTick(t: Tick): void {
  const cap = horizontalCap(t.mode);
  const h = Math.hypot(t.vel.x, t.vel.z);
  if (h > cap) {
    t.vel.x *= cap / h;
    t.vel.z *= cap / h;
  }
  if (t.vel.y < -MAX_FALL_SPEED) t.vel.y = -MAX_FALL_SPEED;
  const clamp = clampAboveTerrain(t.world, t.pos);
  if (clamp.clamped) {
    t.pos = clamp.pos;
    if (t.vel.y < 0) t.vel.y = 0;
  }
  t.wading = wadingAt(t);
}

/**
 * Locomotion never exceeds the dodge speed (the fastest ground move, and the most momentum air
 * control keeps). hurt / downed / locked velocities belong to their owners and only get a sanity bound.
 */
function horizontalCap(mode: MoveMode): number {
  return mode === 'hurt' || mode === 'downed' || mode === 'locked' ? MAX_FALL_SPEED : DODGE_SPEED;
}

function toState(t: Tick): ControllerState {
  return {
    pos: t.pos,
    vel: t.vel,
    yaw: wrapAngle(t.yaw),
    mode: t.mode,
    modeTime: t.modeTime,
    grounded: t.grounded,
    groundNormal: t.groundNormal,
    wading: t.wading,
    stride: t.mode === 'grounded' ? t.stride : 0,
    climbNormal: t.climbNormal,
    climbPush: t.mode === 'grounded' ? t.climbPush : 0,
    climbCooldown: t.climbCooldown,
    mantleTarget: t.mode === 'mantle' ? t.mantleTarget : null,
    fallStartY: t.fallStartY,
    iFrames: t.iFrames,
    coyoteTime: t.coyoteTime,
  };
}

function unchanged(s: Readonly<ControllerState>, stamina: Readonly<StaminaState>): ControllerStepResult {
  return {
    state: {
      ...s,
      pos: copyV3(s.pos),
      vel: copyV3(s.vel),
      groundNormal: copyV3(s.groundNormal),
      climbNormal: s.climbNormal === null ? null : copyV3(s.climbNormal),
      mantleTarget: s.mantleTarget === null ? null : copyV3(s.mantleTarget),
    },
    stamina: { ...stamina },
    events: [],
    consumed: { jump: false, dodge: false },
  };
}

function isValidState(s: Readonly<ControllerState>): boolean {
  return (
    isFiniteV3(s.pos) &&
    isFiniteV3(s.vel) &&
    isFiniteV3(s.groundNormal) &&
    (s.climbNormal === null || isFiniteV3(s.climbNormal)) &&
    (s.mantleTarget === null || isFiniteV3(s.mantleTarget)) &&
    isFiniteNum(s.climbPush) &&
    isFiniteNum(s.stride) &&
    isFiniteNum(s.climbCooldown) &&
    isFiniteNum(s.yaw) &&
    isFiniteNum(s.modeTime) &&
    isFiniteNum(s.fallStartY) &&
    isFiniteNum(s.iFrames) &&
    isFiniteNum(s.coyoteTime) &&
    MOVE_MODES.includes(s.mode)
  );
}

function isValidStamina(s: Readonly<StaminaState>): boolean {
  return isFiniteNum(s.value) && isFiniteNum(s.max) && isFiniteNum(s.idleTimer);
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** Timer after one tick; expired (≤ TIME_EPS) timers are exactly 0. */
function countDown(v: number, dt: number): number {
  const left = v - dt;
  return left > TIME_EPS ? left : 0;
}

/** A time limit fitted to whole ticks (at least one). */
function tickTime(limit: number, dt: number): number {
  return Math.max(1, Math.floor(limit / dt + 1e-9)) * dt;
}

/** Per-tick speed gain that takes 0 → `speed` in ACCEL_TIME. */
function accelStep(speed: number, dt: number): number {
  return (speed / tickTime(ACCEL_TIME, dt)) * dt * (1 + RATE_MARGIN);
}

/** Per-tick speed loss that stops from max(sprint speed, `speed`) within DECEL_TIME. */
function decelStep(speed: number, dt: number): number {
  return (Math.max(SPRINT_SPEED, speed) / tickTime(DECEL_TIME, dt)) * dt * (1 + RATE_MARGIN);
}

/** Per-tick turn that covers 180° in TURN_TIME. */
function turnStep(dt: number): number {
  return (Math.PI / tickTime(TURN_TIME, dt)) * dt * (1 + RATE_MARGIN);
}

/** Per-tick climbNormal turn that covers 90° in CLIMB_NORMAL_BLEND_TIME. */
function normalTurnStep(dt: number): number {
  return (Math.PI / 2 / tickTime(CLIMB_NORMAL_BLEND_TIME, dt)) * dt * (1 + RATE_MARGIN);
}

/** Turns `from` toward `to` along the shorter arc by at most `maxStep` radians. */
function turnToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  return Math.abs(d) <= maxStep ? wrapAngle(to) : wrapAngle(from + Math.sign(d) * maxStep);
}

/** Moves `v` toward `target` by at most `maxStep` (vector length), never overshooting. */
function approachV3(v: Readonly<Vec3>, target: Readonly<Vec3>, maxStep: number): Vec3 {
  const d = sub(target, v);
  const len = length(d);
  return len <= maxStep ? copyV3(target) : addScaled(v, d, maxStep / len);
}
