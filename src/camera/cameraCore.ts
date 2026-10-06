// Third-person orbit camera core (design "Camera": 궤도 추적, 카메라 충돌과 근접 페이드, 흔들림과
// impulse, 연출 전환의 순간 이동 snap; Req 21.1–21.4, 35.8). Pure: no three.js / DOM, and every
// damping and timer runs on real time (realDt), so hit-stop never freezes the camera and the whole
// thing runs in Node tests. threeCamera.ts copies the returned CameraRig to the render camera.
//
// Conventions (core/math): Y-up metres; yaw 0 faces +Z and positive yaw turns toward +X, which is a
// turn to the left, so the camera's screen-right is (−cos yaw, 0, sin yaw). Pitch > 0 looks down from
// above. InputState.lookDelta() reports x > 0 for "turn right" and y > 0 for "look down" with mouse
// sensitivity and invertY already applied, hence yaw −= look.x and pitch += look.y.
//
// Frame order: teleport / snap check → look and wheel → target tracking → Lock-on pull or re-centre →
// distance (user, combat framing, wide lock) → collision → ground clearance → near fade → shake → rig.
// Lock-on (Req 21.6): the yaw / pitch are pulled with a 0.25 s spring toward the view of the midpoint between the
// character and the target, and look input only offsets that goal by up to ±20°, easing back once it stops.
// Without a target lockOn() re-centres behind the character over 0.3 s (Req 21.7). Cinematic blends come later.

import { addScaled, angleDelta, approach, clamp, copyV3, distance, isFiniteV3, lerp, wrapAngle, yawFromDir } from '../core/math';
import type { Vec2, Vec3 } from '../core/types';
import type { CameraCollision } from './cameraCollision';
import {
  COMBAT_DISTANCE_SMOOTH_TIME, COMBAT_RETURN_SECONDS, COMBAT_RETURN_SMOOTH_TIME, combatDistance,
} from './combatFraming';
import {
  LOCK_LOOK_LIMIT, LOCK_SMOOTH_TIME, LOCK_WIDE_DISTANCE, LOCK_WIDE_FOV_SHARE, RECENTER_SECONDS,
} from './lockOn';
import {
  CAMERA_FOV_DEG,
  CAMERA_RADIUS,
  COLLISION_MARGIN,
  DEFAULT_DISTANCE,
  DEFAULT_PITCH,
  DISTANCE_SMOOTH_TIME,
  FADE_END_DISTANCE,
  FADE_START_DISTANCE,
  FADE_TIME,
  FADED_OPACITY,
  GROUND_CLEARANCE,
  MAX_PITCH,
  MAX_TARGET_LAG,
  MAX_USER_DISTANCE,
  MIN_DISTANCE,
  MIN_PITCH,
  MIN_USER_DISTANCE,
  PULL_IN_TIME,
  RETURN_TIME,
  SHOULDER_HEIGHT,
  SHOULDER_RETURN_SMOOTH_TIME,
  SHOULDER_RIGHT,
  SHOULDER_SKIN,
  TARGET_SMOOTH_TIME_H,
  TARGET_SMOOTH_TIME_V,
  TELEPORT_MIN_JUMP,
  TELEPORT_SPEED,
  WHEEL_STEP_DELTA,
  WHEEL_STEP_METERS,
} from './constants';
import { CameraShake, type ShakeOffset } from './shake';
import { easeOutCubic, easeOutQuad, resetSpring, smoothDamp, type Spring } from './smoothing';

/** One render frame of camera input. */
export interface CameraFrame {
  /** Real seconds since the last frame (GameLoop realDt): hit-stop and slow motion do not slow the camera. */
  realDt: number;
  /** Interpolated feet position of the Active_Character. */
  characterPos: Readonly<Vec3>;
  /** Interpolated facing of the Active_Character (rad); a snap puts the camera behind it. */
  characterYaw: number;
  /**
   * InputState.lookDelta(): rotation since the last frame (rad), x > 0 turns right and y > 0 looks
   * down, with mouse sensitivity, invertY and the key / stick rates applied. Default none.
   */
  look?: Readonly<Vec2>;
  /** InputState.wheelDelta(): wheel deltaY since the last frame; +100 moves the camera 0.5 m farther. Default 0. */
  wheel?: number;
  /** Settings.shake, 0..1 (UI 0–100%); 0 disables shake completely. Default 1 (the Settings default). */
  shake?: number;
  /** Body centre of the Lock-on target while locked; null / omitted in follow mode. */
  lock?: Readonly<Vec3> | null;
  /** While In_Combat, the farthest engaged enemy's horizontal distance (combatSpread); null / omitted otherwise. */
  combatSpread?: number | null;
  /** Render aspect ratio (width / height) for the wide-lock check. Default 16 / 9. */
  aspect?: number;
}

/** Pose for the render camera (design CameraRig plus the shake roll). */
export interface CameraRig {
  /** World position, shake included. */
  position: Vec3;
  /** World point the camera looks at, shake included. */
  lookAt: Vec3;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Rotation about the view axis (rad): shake roll, 0 when still. */
  roll: number;
}

export interface CameraCoreOptions {
  /** Camera-blocking geometry. null (default) disables collision and the ground clearance. */
  collision?: CameraCollision | null;
  /** Seed of the shake noise (default DEFAULT_SHAKE_SEED). */
  shakeSeed?: number;
}

/** A timed pull-in or return: the distance it started from and the real time since. */
interface Transition {
  from: number;
  elapsed: number;
}

/** Collision distance changes below this are noise (m). */
const DISTANCE_EPSILON = 1e-3;
/** Slack for summed frame times reaching a transition's duration. */
const TIME_EPSILON = 1e-9;
/** Opacity change per second: a full fade takes FADE_TIME. */
const FADE_RATE = (1 - FADED_OPACITY) / FADE_TIME;
const DEFAULT_ASPECT = 16 / 9;
/** The lock pitch goal's run is at least this long, so a target right beside the character does not tip the view (m). */
const LOCK_MIN_RUN = 1;

/** A re-centre in progress (Req 21.7). */
interface Recenter {
  fromYaw: number;
  deltaYaw: number;
  fromPitch: number;
  elapsed: number;
}

/** Horizontal unit vector to the right of a camera facing `yaw`. */
export function cameraRight(yaw: number): Vec3 {
  return { x: -Math.cos(yaw), y: 0, z: Math.sin(yaw) };
}

/** Unit vector from the orbit target toward the camera. */
function orbitBack(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

/** Keeps the horizontal spring pair within MAX_TARGET_LAG of (x, z). */
function limitLag(sx: Spring, sz: Spring, x: number, z: number): void {
  const dx = sx.value - x;
  const dz = sz.value - z;
  const lag = Math.hypot(dx, dz);
  if (lag <= MAX_TARGET_LAG) return;
  const k = MAX_TARGET_LAG / lag;
  sx.value = x + dx * k;
  sz.value = z + dz * k;
}

const isStill = (s: ShakeOffset): boolean =>
  s.x === 0 && s.y === 0 && s.z === 0 && s.yaw === 0 && s.pitch === 0 && s.roll === 0;

/**
 * Shaken pose: the eye moves by the position offset and the view direction (camera → target) turns by
 * the yaw / pitch offsets. Without shake the rig looks exactly at the target.
 */
function composeRig(position: Vec3, target: Vec3, s: ShakeOffset): CameraRig {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const dz = target.z - position.z;
  const reach = Math.hypot(dx, dy, dz);
  if (isStill(s) || !(reach > 1e-9)) {
    return { position: copyV3(position), lookAt: copyV3(target), fov: CAMERA_FOV_DEG, roll: 0 };
  }
  const yaw = Math.atan2(dx, dz) + s.yaw;
  const pitch = Math.asin(clamp(-dy / reach, -1, 1)) + s.pitch;
  const horizontal = Math.cos(pitch) * reach;
  const eye = { x: position.x + s.x, y: position.y + s.y, z: position.z + s.z };
  return {
    position: eye,
    lookAt: { x: eye.x + Math.sin(yaw) * horizontal, y: eye.y - Math.sin(pitch) * reach, z: eye.z + Math.cos(yaw) * horizontal },
    fov: CAMERA_FOV_DEG,
    roll: s.roll,
  };
}

const cloneRig = (r: Readonly<CameraRig>): CameraRig => ({
  position: copyV3(r.position),
  lookAt: copyV3(r.lookAt),
  fov: r.fov,
  roll: r.roll,
});

/**
 * Follow-mode orbit camera: shoulder target tracking, look / wheel control, sphere-cast collision with
 * pull-in and ease-out return, ground clearance, near fade, trauma shake and teleport snaps. Call
 * update() once per render frame after the sim state is interpolated.
 */
export class CameraCore {
  private readonly collision: CameraCollision | null;
  private readonly shaker: CameraShake;
  private yawValue = 0;
  private pitchValue = DEFAULT_PITCH;
  private user = DEFAULT_DISTANCE;
  /** Wanted distance, following `user`. */
  private readonly dist: Spring = { value: DEFAULT_DISTANCE, velocity: 0 };
  /** Smoothed shoulder point above the feet (the orbit target before the side offset). */
  private readonly pivotX: Spring = { value: 0, velocity: 0 };
  private readonly pivotY: Spring = { value: SHOULDER_HEIGHT, velocity: 0 };
  private readonly pivotZ: Spring = { value: 0, velocity: 0 };
  /** Shoulder offset toward the camera's right, squeezed by walls beside the character. */
  private readonly side: Spring = { value: SHOULDER_RIGHT, velocity: 0 };
  /** Collision distance limit in effect; Infinity while nothing blocks the camera. */
  private limit = Infinity;
  private pull: Transition | null = null;
  private restore: Transition | null = null;
  private faded = false;
  private opacity = 1;
  private orbitDistance = DEFAULT_DISTANCE;
  private targetPoint: Vec3 = { x: 0, y: SHOULDER_HEIGHT, z: 0 };
  private prevFeet: Vec3 | null = null;
  private snapPending = false;
  /** Lock-on: springs pulling yaw / pitch to the framing goal, and the look offsets from it. */
  private locked = false;
  private readonly lockYaw: Spring = { value: 0, velocity: 0 };
  private readonly lockPitch: Spring = { value: DEFAULT_PITCH, velocity: 0 };
  private readonly offsetYaw: Spring = { value: 0, velocity: 0 };
  private readonly offsetPitch: Spring = { value: 0, velocity: 0 };
  private recentering: Recenter | null = null;
  /** Real seconds since the fight ended (Infinity when none ended recently). */
  private sinceCombat = Infinity;
  private rigValue: CameraRig = {
    position: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 1 },
    fov: CAMERA_FOV_DEG,
    roll: 0,
  };

  constructor(options: CameraCoreOptions = {}) {
    this.collision = options.collision ?? null;
    this.shaker = new CameraShake(options.shakeSeed);
  }

  /** Orbit yaw (rad, in (−π, π]), without shake: movement and aiming use it. */
  get yaw(): number {
    return this.yawValue;
  }

  /** Orbit pitch (rad, −60°…+75°, positive looks down), without shake. */
  get pitch(): number {
    return this.pitchValue;
  }

  /** Wheel-controlled distance, 3–8 m (default 5.5 m). */
  get userDistance(): number {
    return this.user;
  }

  /** Camera-to-target distance along the orbit after collision and the 0.6 m minimum (before the ground clearance). */
  get distance(): number {
    return this.orbitDistance;
  }

  /** Orbit target of the last frame: smoothed shoulder point plus the shoulder offset. */
  get target(): Vec3 {
    return copyV3(this.targetPoint);
  }

  /** Opacity the Render_System applies to the Active_Character: 1, or down to 0.35 while the camera is close (Req 21.4). */
  get characterOpacity(): number {
    return this.opacity;
  }

  get trauma(): number {
    return this.shaker.trauma;
  }

  /** Adds shake: trauma = min(1, trauma + amount); scaled by Settings.shake on output. */
  addTrauma(amount: number): void {
    this.shaker.addTrauma(amount);
  }

  /** The last frame was locked on. */
  get lockFraming(): boolean {
    return this.locked;
  }

  /** A re-centre is in progress. */
  get recenteringNow(): boolean {
    return this.recentering !== null;
  }

  /**
   * Turns the camera behind a character facing `characterYaw` and back to the default pitch over 0.3 s (Lock-on
   * pressed with no target, Req 21.7). Ignored while locked.
   */
  recenter(characterYaw: number): void {
    if (this.locked || !Number.isFinite(characterYaw)) return;
    this.recentering = {
      fromYaw: this.yawValue,
      deltaYaw: angleDelta(this.yawValue, wrapAngle(characterYaw)),
      fromPitch: this.pitchValue,
      elapsed: 0,
    };
  }

  /**
   * Makes the next update skip smoothing: the camera goes straight behind the character at the default
   * pitch and userDistance, with the collision state reset (fast travel, Safe_Position recovery, loads).
   * Feet moves larger than max(1.5 m, 50 m/s · realDt) in one frame snap the same way on their own.
   */
  snap(): void {
    this.snapPending = true;
  }

  /** Advances the camera by one render frame. Returns a fresh rig; a non-finite characterPos keeps the last one. */
  update(frame: CameraFrame): CameraRig {
    const feet = frame.characterPos;
    if (!isFiniteV3(feet)) return cloneRig(this.rigValue);
    const dt = frame.realDt > 0 && frame.realDt < Infinity ? frame.realDt : 0;
    const snap = this.takeSnap(feet, dt);
    const lock = frame.lock !== undefined && frame.lock !== null && isFiniteV3(frame.lock) ? frame.lock : null;
    if (lock !== null && !this.locked) {
      resetSpring(this.offsetYaw, 0);
      resetSpring(this.offsetPitch, 0);
      this.lockYaw.velocity = 0;
      this.lockPitch.velocity = 0;
    }
    this.locked = lock !== null;
    if (lock !== null) this.recentering = null;
    if (snap) {
      if (Number.isFinite(frame.characterYaw)) this.yawValue = wrapAngle(frame.characterYaw);
      this.pitchValue = DEFAULT_PITCH;
      this.recentering = null;
    }
    this.applyLook(frame.look, frame.wheel, dt);

    const target = this.trackTarget(feet, dt, snap);
    if (lock !== null && !snap) this.pullToLock(feet, target, lock, dt);
    this.stepRecenter(dt);
    const wanted = this.stepDistance(frame, lock, target, dt, snap);
    const back = orbitBack(this.yawValue, this.pitchValue);
    this.updateLimit(target, back, wanted, dt, snap);
    this.orbitDistance = Math.max(MIN_DISTANCE, Math.min(wanted, this.limit));
    const position = addScaled(target, back, this.orbitDistance);
    this.keepAboveGround(position);
    this.updateFade(distance(position, target), dt, snap);

    this.targetPoint = target;
    this.rigValue = composeRig(position, target, this.shaker.update(dt, frame.shake ?? 1));
    return cloneRig(this.rigValue);
  }

  /** True for a requested snap, the first frame, or a teleport-sized feet move. */
  private takeSnap(feet: Readonly<Vec3>, dt: number): boolean {
    const prev = this.prevFeet;
    const teleported = prev === null || distance(feet, prev) > Math.max(TELEPORT_MIN_JUMP, TELEPORT_SPEED * dt);
    const snap = this.snapPending || teleported;
    this.snapPending = false;
    this.prevFeet = copyV3(feet);
    return snap;
  }

  /**
   * Look rotates 1:1 without smoothing (Req 21.2); while locked it moves the offset from the framing goal instead,
   * clamped to ±LOCK_LOOK_LIMIT and easing back to 0 in frames without look input. The wheel sets userDistance
   * (Req 21.1).
   */
  private applyLook(look: Readonly<Vec2> | undefined, wheel: number | undefined, dt: number): void {
    const lx = look !== undefined && Number.isFinite(look.x) ? look.x : 0;
    const ly = look !== undefined && Number.isFinite(look.y) ? look.y : 0;
    if (this.locked) {
      if (lx !== 0 || ly !== 0) {
        resetSpring(this.offsetYaw, clamp(this.offsetYaw.value - lx, -LOCK_LOOK_LIMIT, LOCK_LOOK_LIMIT));
        resetSpring(this.offsetPitch, clamp(this.offsetPitch.value + ly, -LOCK_LOOK_LIMIT, LOCK_LOOK_LIMIT));
      } else {
        smoothDamp(this.offsetYaw, 0, LOCK_SMOOTH_TIME, dt);
        smoothDamp(this.offsetPitch, 0, LOCK_SMOOTH_TIME, dt);
      }
    } else {
      if (lx !== 0) this.yawValue = wrapAngle(this.yawValue - lx);
      if (ly !== 0) this.pitchValue = clamp(this.pitchValue + ly, MIN_PITCH, MAX_PITCH);
    }
    if (wheel !== undefined && Number.isFinite(wheel)) {
      const step = (wheel / WHEEL_STEP_DELTA) * WHEEL_STEP_METERS;
      this.user = clamp(this.user + step, MIN_USER_DISTANCE, MAX_USER_DISTANCE);
    }
  }

  /**
   * Lock-on soft constraint (Req 21.6): the yaw goal faces from the character toward the target (the direction of
   * their midpoint), the pitch goal is the default pitch plus the elevation from the orbit target down to that
   * midpoint; both plus the look offsets, reached with a LOCK_SMOOTH_TIME critically damped spring.
   */
  private pullToLock(feet: Readonly<Vec3>, target: Readonly<Vec3>, lock: Readonly<Vec3>, dt: number): void {
    const dx = lock.x - feet.x;
    const dz = lock.z - feet.z;
    const goalYaw = Math.hypot(dx, dz) > 1e-3 ? yawFromDir(dx, dz) : this.yawValue;
    const mid = { x: (target.x + lock.x) / 2, y: (target.y + lock.y) / 2, z: (target.z + lock.z) / 2 };
    const run = Math.max(LOCK_MIN_RUN, Math.hypot(mid.x - target.x, mid.z - target.z));
    const goalPitch = clamp(DEFAULT_PITCH + Math.atan2(target.y - mid.y, run) + this.offsetPitch.value, MIN_PITCH, MAX_PITCH);
    const aimYaw = goalYaw + this.offsetYaw.value;
    this.lockYaw.value = aimYaw + angleDelta(aimYaw, this.yawValue); // continuous around the goal
    smoothDamp(this.lockYaw, aimYaw, LOCK_SMOOTH_TIME, dt);
    this.yawValue = wrapAngle(this.lockYaw.value);
    this.lockPitch.value = this.pitchValue;
    smoothDamp(this.lockPitch, goalPitch, LOCK_SMOOTH_TIME, dt);
    this.pitchValue = clamp(this.lockPitch.value, MIN_PITCH, MAX_PITCH);
  }

  /** Eases a started re-centre: behind the character and the default pitch after RECENTER_SECONDS. */
  private stepRecenter(dt: number): void {
    const r = this.recentering;
    if (r === null) return;
    r.elapsed += dt;
    const k = Math.min(1, (r.elapsed + TIME_EPSILON) / RECENTER_SECONDS);
    const e = easeOutQuad(k);
    this.yawValue = wrapAngle(r.fromYaw + r.deltaYaw * e);
    this.pitchValue = clamp(lerp(r.fromPitch, DEFAULT_PITCH, e), MIN_PITCH, MAX_PITCH);
    if (k >= 1) this.recentering = null;
  }

  /**
   * Wanted orbit distance: userDistance; while In_Combat max(userDistance, min(7, 5.5 + 0.2·spread)) with a 0.6 s
   * smoothing, easing back over about 1 s after the fight (Req 21.5); at least 7 m while a lock spreads the
   * character and the target wider than 80% of the horizontal FOV (Req 21.6).
   */
  private stepDistance(frame: CameraFrame, lock: Readonly<Vec3> | null, target: Readonly<Vec3>, dt: number, snap: boolean): number {
    const spread = frame.combatSpread;
    let goal = this.user;
    let smooth = DISTANCE_SMOOTH_TIME;
    if (spread !== undefined && spread !== null && Number.isFinite(spread)) {
      goal = combatDistance(this.user, spread);
      smooth = COMBAT_DISTANCE_SMOOTH_TIME;
      this.sinceCombat = 0;
    } else if (this.sinceCombat < COMBAT_RETURN_SECONDS) {
      this.sinceCombat += dt;
      smooth = COMBAT_RETURN_SMOOTH_TIME;
    }
    if (lock !== null && this.lockIsWide(target, lock, frame.aspect ?? DEFAULT_ASPECT)) {
      goal = Math.max(goal, LOCK_WIDE_DISTANCE);
      smooth = Math.max(smooth, COMBAT_DISTANCE_SMOOTH_TIME);
    }
    if (snap) resetSpring(this.dist, goal);
    else smoothDamp(this.dist, goal, smooth, dt);
    return this.dist.value;
  }

  /** Seen from the last camera position, the orbit target and the lock target are wider apart than 80% of the horizontal FOV. */
  private lockIsWide(target: Readonly<Vec3>, lock: Readonly<Vec3>, aspect: number): boolean {
    const eye = this.rigValue.position;
    const a = Math.atan2(target.x - eye.x, target.z - eye.z);
    const b = Math.atan2(lock.x - eye.x, lock.z - eye.z);
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
    const hFov = 2 * Math.atan(Math.tan((CAMERA_FOV_DEG * Math.PI) / 360) * ratio);
    return Math.abs(angleDelta(a, b)) > LOCK_WIDE_FOV_SHARE * hFov;
  }

  /** Smoothed shoulder point plus the shoulder offset toward the camera's right. */
  private trackTarget(feet: Readonly<Vec3>, dt: number, snap: boolean): Vec3 {
    const x = feet.x;
    const y = feet.y + SHOULDER_HEIGHT;
    const z = feet.z;
    if (snap) {
      resetSpring(this.pivotX, x);
      resetSpring(this.pivotY, y);
      resetSpring(this.pivotZ, z);
    } else {
      smoothDamp(this.pivotX, x, TARGET_SMOOTH_TIME_H, dt);
      smoothDamp(this.pivotZ, z, TARGET_SMOOTH_TIME_H, dt);
      smoothDamp(this.pivotY, y, TARGET_SMOOTH_TIME_V, dt);
      limitLag(this.pivotX, this.pivotZ, x, z);
      const lagY = this.pivotY.value - y;
      if (Math.abs(lagY) > MAX_TARGET_LAG) this.pivotY.value = y + Math.sign(lagY) * MAX_TARGET_LAG;
    }
    const pivot = { x: this.pivotX.value, y: this.pivotY.value, z: this.pivotZ.value };
    const right = cameraRight(this.yawValue);
    const room = this.shoulderRoom(pivot, right);
    // Squeeze at once so the target never sits in the wall; grow back smoothly.
    if (snap || room < this.side.value) resetSpring(this.side, room);
    else smoothDamp(this.side, room, SHOULDER_RETURN_SMOOTH_TIME, dt);
    return addScaled(pivot, right, this.side.value);
  }

  /** How far the target can sit toward the camera's right before a wall beside the character. */
  private shoulderRoom(pivot: Vec3, right: Vec3): number {
    if (this.collision === null) return SHOULDER_RIGHT;
    const hit = this.collision.sweep(pivot, addScaled(pivot, right, SHOULDER_RIGHT), CAMERA_RADIUS);
    if (hit === null || !Number.isFinite(hit)) return SHOULDER_RIGHT;
    return clamp(hit - SHOULDER_SKIN, 0, SHOULDER_RIGHT);
  }

  /**
   * Collision distance limit (Req 21.3). A sphere cast from the target toward the wanted camera
   * position gives hitDistance − COLLISION_MARGIN. A shorter limit is reached within PULL_IN_TIME, and
   * at once on a snap or when the camera would sit inside geometry; a longer one is eased back over
   * RETURN_TIME.
   */
  private updateLimit(target: Vec3, back: Vec3, wanted: number, dt: number, snap: boolean): void {
    const collision = this.collision;
    let cast = Infinity;
    if (collision !== null) {
      const hit = collision.sweep(target, addScaled(target, back, wanted), CAMERA_RADIUS);
      if (hit !== null && Number.isFinite(hit)) cast = Math.max(0, hit - COLLISION_MARGIN);
    }
    const goal = Math.min(wanted, cast); // where the collision allows the camera this frame
    const shown = Math.min(wanted, this.limit); // where it would be without a change
    if (snap) {
      this.limit = cast < wanted ? cast : Infinity;
      this.pull = null;
      this.restore = null;
    } else if (goal < shown - DISTANCE_EPSILON || (this.pull !== null && goal < shown)) {
      // Blocked closer than the camera is: pull in. Once the pull time has passed the camera follows the
      // limit directly, so walking back toward a wall never leaves it inside.
      this.restore = null;
      const pull = (this.pull ??= { from: shown, elapsed: 0 });
      pull.elapsed += dt;
      const k = (pull.elapsed + TIME_EPSILON) / PULL_IN_TIME;
      let next = Math.min(shown, lerp(pull.from, goal, easeOutQuad(k)));
      if (k >= 1 || collision?.overlaps(addScaled(target, back, Math.max(MIN_DISTANCE, next)), CAMERA_RADIUS)) {
        next = goal;
      }
      this.limit = next;
    } else if (this.limit < Infinity && (goal > shown + DISTANCE_EPSILON || (this.restore !== null && goal > shown))) {
      // Room behind the camera again: ease back out, finishing a started return on time.
      this.pull = null;
      const restore = (this.restore ??= { from: shown, elapsed: 0 });
      restore.elapsed += dt;
      const k = (restore.elapsed + TIME_EPSILON) / RETURN_TIME;
      if (k >= 1) {
        this.limit = goal < wanted ? goal : Infinity;
        this.restore = null;
      } else {
        this.limit = lerp(restore.from, goal, easeOutCubic(k));
      }
    } else {
      // Holding where the collision allows (or free).
      this.pull = null;
      this.restore = null;
      if (this.limit >= wanted - DISTANCE_EPSILON) this.limit = Infinity;
    }
  }

  /** Keeps the camera GROUND_CLEARANCE above the terrain under it. */
  private keepAboveGround(p: Vec3): void {
    if (this.collision === null) return;
    const floor = this.collision.groundHeight(p.x, p.z) + GROUND_CLEARANCE;
    if (p.y < floor) p.y = floor; // a NaN height compares false and changes nothing
  }

  /** Near fade with hysteresis: fades below FADE_START_DISTANCE, clears again at FADE_END_DISTANCE (Req 21.4). */
  private updateFade(actual: number, dt: number, snap: boolean): void {
    if (this.faded ? actual >= FADE_END_DISTANCE : actual < FADE_START_DISTANCE) this.faded = !this.faded;
    const goal = this.faded ? FADED_OPACITY : 1;
    this.opacity = snap ? goal : approach(this.opacity, goal, FADE_RATE * dt);
  }
}
