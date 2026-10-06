// Gamepad snapshot → RawInput conversion (design.md "입력 아키텍처"). Pure: the browser adapter copies
// `navigator.getGamepads()` state into a PadSnapshot, so this runs in Node tests.

import { GAMEPAD_BUTTON_CODES } from './bindings';
import type { RawInput } from './inputState';

/** Plain copy of a standard-mapping `Gamepad`: button values (0..1) and axes (-1..1). */
export interface PadSnapshot {
  buttons: readonly number[];
  axes: readonly number[];
}

/** Button value at or above which a button counts as down; covers the analog RT (Req 35.2). */
export const PAD_PRESS_THRESHOLD = 0.5;

/** Axis value, or 0 when missing or not finite. */
function axis(axes: readonly number[], i: number): number {
  const value = axes[i] ?? 0;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Diffs `snap` against the previous poll (`prev` null on a pad's first poll): 'down' / 'up' (time 0) for each
 * `GAMEPAD_BUTTON_CODES` button whose state changed, then one 'axes' event (left stick moves, right stick looks).
 * Missing buttons read as up and missing axes as 0. `pressed` is indexed like GAMEPAD_BUTTON_CODES.
 */
export function padToRawInputs(
  prev: readonly boolean[] | null,
  snap: PadSnapshot,
): { pressed: boolean[]; events: RawInput[] } {
  const pressed: boolean[] = [];
  const events: RawInput[] = [];
  GAMEPAD_BUTTON_CODES.forEach((code, i) => {
    const down = (snap.buttons[i] ?? 0) >= PAD_PRESS_THRESHOLD;
    pressed.push(down);
    if (down !== (prev?.[i] ?? false)) events.push({ kind: down ? 'down' : 'up', code, time: 0 });
  });
  events.push({
    kind: 'axes',
    moveX: axis(snap.axes, 0),
    moveY: axis(snap.axes, 1),
    lookX: axis(snap.axes, 2),
    lookY: axis(snap.axes, 3),
  });
  return { pressed, events };
}
