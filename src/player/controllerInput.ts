// InputSample → ControllerInput (design "Player Controller" collide-and-slide step 1: 카메라 기준 입력).
// The move vector is rotated by the camera yaw of the tick, so forward (W, stick up) walks away from the
// camera and right (D) toward the camera's screen-right, keeping the stick tilt as the length. Buffered
// presses are only peeked here; the controller reports which ones it used and consumeUsedPresses takes
// exactly those from the InputBuffer. Pure: no three.js / DOM.
//
// Conventions (core/math): yaw 0 faces +Z and positive yaw turns toward +X. A camera at `yaw` looks along
// (sin yaw, 0, cos yaw) and its screen-right is (−cos yaw, 0, sin yaw), the same vectors as
// src/camera's cameraRight (not imported: simulation code may not depend on presentation modules).

import type { Vec2 } from '../core/types';
import type { InputState } from '../input/inputState';
import type { ConsumedPresses, ControllerInput } from './core/types';

/** What the adapter reads from the tick's InputState. */
export type ControllerInputSource = Pick<InputState, 'moveVector' | 'down' | 'pressed' | 'isBuffered' | 'walkToggled'>;

/**
 * World-space horizontal move for `move` (x right, y forward, length = stick tilt) under a camera facing
 * `yaw`: y along the camera's forward, x along its screen-right. Rotation only, so the length is kept.
 */
export function cameraRelativeMove(move: Readonly<Vec2>, yaw: number): { x: number; z: number } {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return { x: move.y * sin - move.x * cos, z: move.y * cos + move.x * sin };
}

/** This tick's ControllerInput from the frozen InputState and the camera yaw at tick time. */
export function readControllerInput(input: ControllerInputSource, cameraYaw: number): ControllerInput {
  return {
    move: cameraRelativeMove(input.moveVector(), cameraYaw),
    sprint: input.down('sprint'),
    walk: input.walkToggled,
    jump: input.isBuffered('jump'),
    dodge: input.isBuffered('dodge'),
    release: input.pressed('release'),
  };
}

/** Takes the presses a controller step used out of the InputBuffer (and nothing else). */
export function consumeUsedPresses(input: Pick<InputState, 'consumeBuffered'>, consumed: Readonly<ConsumedPresses>): void {
  if (consumed.jump) input.consumeBuffered('jump');
  if (consumed.dodge) input.consumeBuffered('dodge');
}
