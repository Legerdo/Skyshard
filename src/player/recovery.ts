// RecoverySystem: Safe_Position 기록과 복귀 (design "Safe_Position과 복구"; Req 20.4, 20.5, 20.6, 20.8).
// Part of CollisionResolve: the composition root runs it once per sim tick on the player's final state,
// after every displacement of the tick (design "Tick 갱신 순서").
//
// Safe_Position. An 8-entry ring buffer of standing spots (feet and facing). Once SAFE_POSITION_INTERVAL
// has passed since the last record, the first tick the character stands on safe ground is recorded
// (isSafePositionCandidate): grounded on walkable terrain or a static walkable collider inside PLAY_RADIUS,
// not in water, not on a hazard, a moving platform or any other dynamic collider, and not In_Combat
// (Req 20.4). A spot within SAFE_POSITION_MIN_SPACING of the newest entry refreshes that entry instead of
// adding one, so standing still does not fill the buffer with copies of one place.
//
// Triggers, all on the same path: the feet 2 m or more under the terrain or past 490 m from the origin
// (src/world/worldBounds, Req 20.5); a `fall` lasting STUCK_FALL_TIME while the feet height stays within
// STUCK_FALL_MAX_DY of where that window began (Req 20.6); restorePlayer / requestUnstuck, which the Pause
// "끼임 해제" command uses (Req 20.8); restorePlayer('stairFall', platform) for a Starlit_Stair fall, which goes
// to the given spot instead of a Safe_Position (Req 5.6); restorePlayer('swimExhausted') when Stamina runs out while
// swimming (the controller's `recoveryNeeded`, Req 16.11).
//
// Sequence: RECOVERY_FADE_OUT to black, then the tick reports a teleport to the newest Safe_Position whose
// spot no collider occupies (overlapCapsule), older entries after it and the fallback respawn point last,
// then RECOVERY_FADE_IN: 0.7 s in all, inside the 1 s of Req 20.5. While `active` the adapter locks the
// player's input; it applies the teleport (PlayerController.teleport) and snaps the camera.
//
// Challenge_Area checkpoints (design "체크포인트와 실패 처리", Req 12.8): while the World has registered an area's
// latest checkpoint (or its entrance) with setCheckpointOverride, every recovery without its own target — a fall
// into a `hazard` volume ('hazard'), below the terrain, out of bounds, stuck, the Pause "끼임 해제", a swim out of
// Stamina — goes there first, ahead of the Safe_Positions. setCheckpointOverride(null) (the character left the area)
// returns to the Safe_Position rule.
//
// Pure TypeScript: no three.js / DOM. The system never moves the character itself.

import { clamp01, copyV3, distance, isFiniteNum, isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import { PLAY_RADIUS } from '../data/worldLayout';
import type { CollisionQueries } from '../physics/types';
import { outOfWorldReason } from '../world/worldBounds';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS, GROUND_SNAP_DISTANCE } from './core/constants';
import type { ControllerState } from './core/types';

/** Safe_Position ring buffer size (Req 20.4). */
export const SAFE_POSITION_CAPACITY = 8;
/** Least time between two Safe_Position records (s, Req 20.4). */
export const SAFE_POSITION_INTERVAL = 1;
/** A record closer than this to the newest entry replaces it instead of adding one (m; implementation choice). */
export const SAFE_POSITION_MIN_SPACING = 1;
/** A fall that lasts this long ... (s, Req 20.6) */
export const STUCK_FALL_TIME = 2;
/** ... with the feet height changing by less than this is stuck (m, Req 20.6). */
export const STUCK_FALL_MAX_DY = 0.1;
/** Fade to black before the character is moved (s, Req 20.5). */
export const RECOVERY_FADE_OUT = 0.35;
/** Fade back in after the move (s); with the fade-out 0.7 s, inside the 1 s of Req 20.5. */
export const RECOVERY_FADE_IN = 0.35;

/** Timers within this of their limit have reached it (float slack for summed ticks). */
const TIME_EPS = 1e-9;
/**
 * The blocked test lifts the capsule this far off the recorded feet, so the ground the character stood on
 * does not count as an obstacle (m).
 */
const TARGET_CLEARANCE = 0.05;
/** Feet sunk deeper than this into the ground under them are not standing on it (m). */
const MAX_GROUND_EMBED = 0.05;

/**
 * Why the character is being put back. 'stairFall' is a fall off the Starlit_Stair (Req 5.6), which returns
 * to the last platform stood on instead of a Safe_Position (platforms are dynamic colliders and never
 * recorded). 'lift' is a TEMPORARY route lift pad (src/data/tempRoute.ts, task 4.9) that uses the same fade to
 * put the character on its destination until climbing and gliding exist (tasks 9.1, 9.3). 'swimExhausted' is Stamina
 * running out while swimming (Req 16.11): the controller's `recoveryNeeded` event, which the adapter turns into
 * restorePlayer('swimExhausted'); the character goes to the newest usable Safe_Position like the other reasons.
 * 'lift' is also a Challenge_Area root lift ride (src/world/challengeArea.ts). 'hazard' is a fall into a Challenge_Area's
 * fall judgement volume (design `hazard`, Req 12.8): back to the area's latest checkpoint.
 */
export type RecoveryReason =
  | 'belowTerrain' | 'outOfBounds' | 'stuck' | 'manual' | 'stairFall' | 'lift' | 'swimExhausted' | 'hazard';

export type RecoveryPhase = 'idle' | 'fadeOut' | 'fadeIn';

/** A recorded standing spot: feet position and facing (rad). */
export interface SafePosition {
  pos: Vec3;
  yaw: number;
}

/** The ControllerState fields recovery reads. */
export type RecoveryBody = Pick<ControllerState, 'pos' | 'yaw' | 'mode' | 'grounded' | 'wading'>;

/** Terrain view recovery reads; a TerrainField satisfies it. */
export interface RecoveryTerrain {
  heightAt(x: number, z: number): number;
  /** Water surface level − heightAt where there is water, else 0. */
  waterDepthAt(x: number, z: number): number;
}

/** World queries recovery needs; a CollisionWorld over a TerrainField satisfies it structurally. */
export interface RecoveryWorld extends Pick<CollisionQueries, 'groundProbe' | 'overlapCapsule'> {
  readonly terrain: RecoveryTerrain;
}

/**
 * Extra unsafe ground the collision world does not model yet: water and hazard volumes and moving-platform
 * volumes (VolumeDef, later tasks). Returning true for the feet position blocks a Safe_Position record.
 */
export type UnsafeGroundQuery = (feet: Readonly<Vec3>) => boolean;

export interface RecoveryOptions {
  world: RecoveryWorld;
  /**
   * Last resort when no Safe_Position is usable, read at teleport time (the New Game start for now; later
   * the respawn Hearth or Waystone). Used even if its spot is blocked.
   */
  fallback: () => Readonly<SafePosition>;
  /** Seeds the ring buffer (the New Game start, or the saved last Safe_Position). */
  initial?: Readonly<SafePosition>;
  unsafeAt?: UnsafeGroundQuery;
}

export interface RecoveryTickInput {
  /** The player's state after this tick's movement. */
  body: Readonly<RecoveryBody>;
  dt: number;
  /** In_Combat (Req 20.4); combat does not exist yet. Default false. */
  inCombat?: boolean;
}

/** Where the character must go: the adapter builds a standing ControllerState there. */
export interface RecoveryTeleport {
  reason: RecoveryReason;
  pos: Vec3;
  yaw: number;
  /**
   * 'target': the spot passed to restorePlayer (the Starlit_Stair platform, a lift). 'checkpoint': the Challenge_Area
   * checkpoint registered with setCheckpointOverride.
   */
  source: 'safePosition' | 'fallback' | 'target' | 'checkpoint';
}

/** A Challenge_Area checkpoint registered as the recovery target (setCheckpointOverride). */
export interface CheckpointOverride {
  readonly areaId: string;
  readonly spot: SafePosition;
}

export interface RecoveryTickResult {
  /** Reason of a recovery that began this tick (its fade-out starts). */
  started: RecoveryReason | null;
  /** Set on the one tick the character must be moved: the end of the fade-out. */
  teleport: RecoveryTeleport | null;
}

const nothing = (): RecoveryTickResult => ({ started: null, teleport: null });

const copySafe = (p: Readonly<SafePosition>): SafePosition => ({ pos: copyV3(p.pos), yaw: p.yaw });

/** Fixed-size ring buffer of Safe_Positions: when full, a push overwrites the oldest entry. Stores copies. */
export class SafePositionBuffer {
  private readonly slots: SafePosition[] = [];
  /** Slot of the newest entry; −1 while empty. */
  private newest = -1;

  get size(): number {
    return this.slots.length;
  }

  push(entry: Readonly<SafePosition>): void {
    this.newest = (this.newest + 1) % SAFE_POSITION_CAPACITY;
    this.slots[this.newest] = copySafe(entry);
  }

  /** Overwrites the newest entry (pushes when empty). */
  replaceLatest(entry: Readonly<SafePosition>): void {
    if (this.newest < 0) this.push(entry);
    else this.slots[this.newest] = copySafe(entry);
  }

  latest(): SafePosition | null {
    const entry = this.slots[this.newest];
    return entry === undefined ? null : copySafe(entry);
  }

  /** Entries from the newest to the oldest (copies). */
  newestFirst(): SafePosition[] {
    const n = this.slots.length;
    const out: SafePosition[] = [];
    for (let i = 0; i < n; i++) {
      const entry = this.slots[(this.newest - i + n) % n];
      if (entry !== undefined) out.push(copySafe(entry));
    }
    return out;
  }
}

/**
 * Req 20.4: whether the character's current spot may become a Safe_Position. It must be grounded, out of
 * combat and not wading, inside PLAY_RADIUS (the 470–490 m ring is not walkable ground), with the feet on
 * (not sunk into) standable ground within GROUND_SNAP_DISTANCE that is walkable terrain or a static
 * walkable collider (no hazard, no dynamic collider such as a moving platform, no water surface), above
 * any terrain water (a bridge over a river counts, wading in it does not), and not flagged by `unsafeAt`.
 */
export function isSafePositionCandidate(
  world: RecoveryWorld,
  body: Readonly<RecoveryBody>,
  inCombat: boolean,
  unsafeAt?: UnsafeGroundQuery,
): boolean {
  const { pos } = body;
  if (inCombat || !body.grounded || body.wading || !isFiniteV3(pos)) return false;
  if (pos.x * pos.x + pos.z * pos.z > PLAY_RADIUS * PLAY_RADIUS) return false;
  const ground = world.groundProbe(pos, GROUND_SNAP_DISTANCE, CAPSULE_RADIUS);
  if (ground === null || ground.distance < -MAX_GROUND_EMBED) return false;
  if (!ground.walkable || ground.dynamic || ground.hazard !== null || ground.material === 'water') return false;
  const depth = world.terrain.waterDepthAt(pos.x, pos.z);
  if (depth > 0 && pos.y < world.terrain.heightAt(pos.x, pos.z) + depth) return false;
  return unsafeAt === undefined || !unsafeAt(pos);
}

interface RecoveryRun {
  readonly reason: RecoveryReason;
  /** Explicit destination given to restorePlayer; null picks a Safe_Position. */
  readonly target: SafePosition | null;
  phase: 'fadeOut' | 'fadeIn';
  /** Seconds since the recovery began. */
  elapsed: number;
}

export class RecoverySystem {
  private readonly world: RecoveryWorld;
  private readonly fallback: () => Readonly<SafePosition>;
  private readonly unsafeAt: UnsafeGroundQuery | undefined;
  private readonly buffer = new SafePositionBuffer();
  /** Seconds until the next record is allowed; 0 means due. */
  private recordDue = 0;
  /** Feet height where the current stalled-fall window began; null outside `fall`. */
  private stallY: number | null = null;
  private stallTime = 0;
  private pending: RecoveryReason | null = null;
  private pendingTarget: SafePosition | null = null;
  private run: RecoveryRun | null = null;
  private override: CheckpointOverride | null = null;

  constructor(options: RecoveryOptions) {
    this.world = options.world;
    this.fallback = options.fallback;
    this.unsafeAt = options.unsafeAt;
    if (options.initial !== undefined && isFiniteV3(options.initial.pos)) this.buffer.push(options.initial);
  }

  get phase(): RecoveryPhase {
    return this.run?.phase ?? 'idle';
  }

  /** A recovery is running: player input stays locked until it ends. */
  get active(): boolean {
    return this.run !== null;
  }

  /** Reason of the running recovery; null when idle. */
  get reason(): RecoveryReason | null {
    return this.run?.reason ?? null;
  }

  /** Screen fade for the overlay: 0 clear … 1 black. */
  get fadeAlpha(): number {
    const run = this.run;
    if (run === null) return 0;
    if (run.phase === 'fadeOut') return clamp01(run.elapsed / RECOVERY_FADE_OUT);
    return clamp01(1 - (run.elapsed - RECOVERY_FADE_OUT) / RECOVERY_FADE_IN);
  }

  /** Recorded Safe_Positions, newest first (copies). */
  get safePositions(): SafePosition[] {
    return this.buffer.newestFirst();
  }

  /** The Challenge_Area checkpoint recoveries go to now, or null (a copy). */
  get checkpointOverride(): CheckpointOverride | null {
    const o = this.override;
    return o === null ? null : { areaId: o.areaId, spot: copySafe(o.spot) };
  }

  /**
   * design `setCheckpointOverride`: while inside Challenge_Area `areaId`, recoveries without their own target go to
   * `pos` (facing `yaw`) ahead of the Safe_Positions, as long as its capsule is free (Req 12.8). `null` (or a
   * non-finite spot) clears it: the character left the area.
   */
  setCheckpointOverride(areaId: string | null, pos?: Readonly<Vec3>, yaw = 0): void {
    if (areaId === null || pos === undefined || !isFiniteV3(pos)) {
      this.override = null;
      return;
    }
    this.override = { areaId, spot: { pos: copyV3(pos), yaw: isFiniteNum(yaw) ? yaw : 0 } };
  }

  /**
   * Requests a recovery; it begins on the next tick (the same tick when called before `tick`). With
   * `target` the character goes there (the Starlit_Stair platform, Req 5.6) instead of to a
   * Safe_Position; a non-finite target is ignored. Returns false (and changes nothing) while a recovery is
   * running or another request is waiting.
   */
  restorePlayer(reason: RecoveryReason, target?: Readonly<SafePosition>): boolean {
    if (this.run !== null || this.pending !== null) return false;
    this.pending = reason;
    this.pendingTarget = target !== undefined && isFiniteV3(target.pos) && isFiniteNum(target.yaw) ? copySafe(target) : null;
    return true;
  }

  /** The Pause "끼임 해제" command (Req 20.8): the same path as an automatic recovery. */
  requestUnstuck(): boolean {
    return this.restorePlayer('manual');
  }

  /**
   * One sim tick on the player's final state. Idle: a waiting request, then the out-of-world test, then
   * the stalled-fall test may begin a recovery; otherwise a due Safe_Position is recorded. Running: the
   * fade advances and the tick at the end of the fade-out reports the teleport. A non-positive or
   * non-finite `dt` does nothing.
   */
  tick(input: Readonly<RecoveryTickInput>): RecoveryTickResult {
    const { body, dt } = input;
    if (!(isFiniteNum(dt) && dt > 0)) return nothing();
    if (this.run !== null) return { started: null, teleport: this.advance(this.run, dt) };

    const target = this.pending !== null ? this.pendingTarget : null;
    const reason = this.pending ?? outOfWorldReason(this.world.terrain, body.pos) ?? this.stalledFall(body, dt);
    this.pending = null;
    this.pendingTarget = null;
    if (reason !== null) {
      this.run = { reason, target, phase: 'fadeOut', elapsed: 0 };
      this.resetStall();
      return { started: reason, teleport: null };
    }

    this.recordDue = Math.max(0, this.recordDue - dt);
    if (this.recordDue <= TIME_EPS && isSafePositionCandidate(this.world, body, input.inCombat === true, this.unsafeAt)) {
      this.record(body);
      this.recordDue = SAFE_POSITION_INTERVAL;
    }
    return nothing();
  }

  /** Req 20.6: 'stuck' once a fall has kept its feet height within STUCK_FALL_MAX_DY for STUCK_FALL_TIME. */
  private stalledFall(body: Readonly<RecoveryBody>, dt: number): RecoveryReason | null {
    if (body.mode !== 'fall') {
      this.resetStall();
      return null;
    }
    const y = body.pos.y;
    if (this.stallY === null || Math.abs(y - this.stallY) >= STUCK_FALL_MAX_DY) {
      this.stallY = y; // a new window begins at this height
      this.stallTime = 0;
      return null;
    }
    this.stallTime += dt;
    return this.stallTime >= STUCK_FALL_TIME - TIME_EPS ? 'stuck' : null;
  }

  private resetStall(): void {
    this.stallY = null;
    this.stallTime = 0;
  }

  private record(body: Readonly<RecoveryBody>): void {
    const entry: SafePosition = { pos: copyV3(body.pos), yaw: body.yaw };
    const newest = this.buffer.latest();
    if (newest !== null && distance(newest.pos, entry.pos) < SAFE_POSITION_MIN_SPACING) this.buffer.replaceLatest(entry);
    else this.buffer.push(entry);
  }

  private advance(run: RecoveryRun, dt: number): RecoveryTeleport | null {
    run.elapsed += dt;
    let teleport: RecoveryTeleport | null = null;
    if (run.phase === 'fadeOut' && run.elapsed >= RECOVERY_FADE_OUT - TIME_EPS) {
      const chosen: Omit<RecoveryTeleport, 'reason'> =
        run.target !== null ? { pos: copyV3(run.target.pos), yaw: run.target.yaw, source: 'target' } : this.chooseTarget();
      teleport = { reason: run.reason, ...chosen };
      run.phase = 'fadeIn';
    }
    if (run.phase === 'fadeIn' && run.elapsed >= RECOVERY_FADE_OUT + RECOVERY_FADE_IN - TIME_EPS) {
      this.run = null;
      this.recordDue = 0; // the spot the character now stands on may be recorded at once
      this.resetStall();
    }
    return teleport;
  }

  /** The Challenge_Area checkpoint when one is registered and free, else the newest usable Safe_Position, older ones, the fallback. */
  private chooseTarget(): Omit<RecoveryTeleport, 'reason'> {
    const checkpoint = this.override;
    if (checkpoint !== null && this.isUsableTarget(checkpoint.spot.pos)) {
      return { pos: copyV3(checkpoint.spot.pos), yaw: checkpoint.spot.yaw, source: 'checkpoint' };
    }
    for (const entry of this.buffer.newestFirst()) {
      if (this.isUsableTarget(entry.pos)) return { pos: entry.pos, yaw: entry.yaw, source: 'safePosition' };
    }
    const fallback = this.fallback();
    return { pos: copyV3(fallback.pos), yaw: fallback.yaw, source: 'fallback' };
  }

  /** Inside the world, and no collider (a moved crystal, a raised pillar, a closed barrier) occupies the capsule there. */
  private isUsableTarget(pos: Readonly<Vec3>): boolean {
    if (outOfWorldReason(this.world.terrain, pos) !== null) return false;
    const lifted = { x: pos.x, y: pos.y + TARGET_CLEARANCE, z: pos.z };
    const contacts = this.world.overlapCapsule(lifted, CAPSULE_RADIUS, CAPSULE_HEIGHT - TARGET_CLEARANCE);
    return !contacts.some((c) => c.colliderId !== null);
  }
}
