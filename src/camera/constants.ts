// Camera numbers (design "Camera": 궤도 추적, 카메라 충돌과 근접 페이드, 흔들림과 impulse, 연출 전환;
// Req 21.1–21.4, 35.8). Units: metres, seconds and radians unless the name says otherwise.
//
// Look input rates live in src/input/inputState.ts (MOUSE_RAD_PER_PX 0.12°/px at sensitivity 1,
// KEY_YAW_RATE 150°/s, KEY_PITCH_RATE 90°/s, STICK_YAW_RATE 180°/s, STICK_PITCH_RATE 90°/s):
// InputState.lookDelta() already returns radians with mouse sensitivity and invertY applied, and the
// browser adapter records mouse movement only while the pointer is locked.

import { DEG2RAD } from '../core/math';

// --- Orbit (Req 21.1, 21.2) ---
/** Orbit target height above the Active_Character's feet (shoulder). */
export const SHOULDER_HEIGHT = 1.55;
/** Orbit target offset toward the camera's right. */
export const SHOULDER_RIGHT = 0.35;
export const DEFAULT_DISTANCE = 5.5;
/** Range of the wheel-controlled userDistance. */
export const MIN_USER_DISTANCE = 3;
export const MAX_USER_DISTANCE = 8;
/** userDistance changes by WHEEL_STEP_METERS per WHEEL_STEP_DELTA of wheel deltaY (positive = farther). */
export const WHEEL_STEP_METERS = 0.5;
export const WHEEL_STEP_DELTA = 100;
/** Pitch after a snap. Positive pitch looks down from above. */
export const DEFAULT_PITCH = 15 * DEG2RAD;
export const MIN_PITCH = -60 * DEG2RAD;
export const MAX_PITCH = 75 * DEG2RAD;
/** Vertical field of view, degrees (three.js PerspectiveCamera.fov). */
export const CAMERA_FOV_DEG = 60;

// --- Smoothing (critically damped springs, real time) ---
/** Orbit target smoothing: horizontal and vertical (absorbs jump and stair bobbing). */
export const TARGET_SMOOTH_TIME_H = 0.05;
export const TARGET_SMOOTH_TIME_V = 0.12;
/** Camera distance following userDistance (wheel). */
export const DISTANCE_SMOOTH_TIME = 0.2;
/**
 * Guard, not a design number: the smoothed target stays within this distance of the character
 * (horizontally, and vertically) so a 40 m/s fall cannot leave the character off screen.
 */
export const MAX_TARGET_LAG = 1;
/** Not design numbers: a squeezed shoulder offset keeps this gap to the wall and grows back with this smooth time. */
export const SHOULDER_SKIN = 0.05;
export const SHOULDER_RETURN_SMOOTH_TIME = 0.2;

// --- Collision (Req 21.3) ---
/** Radius of the camera's sphere casts and overlap tests. */
export const CAMERA_RADIUS = 0.25;
/** The camera stops this far before the sphere-cast contact: collision distance = hitDistance − margin. */
export const COLLISION_MARGIN = 0.2;
/** A newly blocked camera reaches the collision distance within this time (at once when it would be inside geometry). */
export const PULL_IN_TIME = 0.1;
/** Ease-out return to the wanted distance after the obstacle is gone. */
export const RETURN_TIME = 0.5;
/** Closest the camera gets to the orbit target. */
export const MIN_DISTANCE = 0.6;
/** The camera stays at least this far above the terrain height under it. */
export const GROUND_CLEARANCE = 0.3;

// --- Near fade (Req 21.4) ---
/** The character fades when the camera gets closer than FADE_START_DISTANCE and turns opaque again at FADE_END_DISTANCE. */
export const FADE_START_DISTANCE = 1;
export const FADE_END_DISTANCE = 1.2;
export const FADED_OPACITY = 0.35;
/** Time for a full opacity change (1 ↔ FADED_OPACITY). */
export const FADE_TIME = 0.15;

// --- Shake (Req 35.8) ---
export const TRAUMA_DECAY_PER_SEC = 1.6;
/** Offset at trauma 1 and 100% intensity: position per axis (m) and yaw / pitch / roll. */
export const SHAKE_MAX_OFFSET = 0.25;
export const SHAKE_MAX_ANGLE = 3 * DEG2RAD;
export const SHAKE_NOISE_HZ = 18;
/** The shake position offset is clamped to the collision margin, so shake never pushes the camera into geometry. */
export const SHAKE_OFFSET_LIMIT = COLLISION_MARGIN;

// --- Teleport snap ---
/** A feet move above max(TELEPORT_MIN_JUMP, TELEPORT_SPEED · realDt) in one frame is a teleport. */
export const TELEPORT_MIN_JUMP = 1.5;
export const TELEPORT_SPEED = 50;
