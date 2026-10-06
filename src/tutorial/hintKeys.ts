/*
 * Key icons of a Tutorial_Hint (Req 34.3): the labels of the keys CURRENTLY bound to the hint's actions, so a remap
 * shows at once on the HUD card and in Settings "조작 안내 보기". Pure: no DOM.
 */

import type { Vec2 } from '../core/types';
import type { InputAction } from '../input/actions';
import { FIXED_INPUTS, type Bindings } from '../input/bindings';
import { keyLabel } from '../input/keyLabels';

/** Labels of the keys bound to `actions`, in action order, without repeats (a key driving two actions shows once). */
export function hintKeyLabels(actions: readonly InputAction[], bindings: Readonly<Bindings>): string[] {
  const labels: string[] = [];
  for (const action of actions) {
    const code = action in bindings ? bindings[action as keyof Bindings] : FIXED_INPUTS.find(([, a]) => a === action)?.[0];
    if (code === undefined) continue;
    const label = keyLabel(code);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Look input the camera reads each frame (the Camera_System's CameraLookInput; InputState satisfies it). */
export interface LookSource {
  lookDelta(): Vec2;
  wheelDelta(): number;
}

/**
 * `source` for the camera, reporting every frame's look delta to `onLook` as the camera takes it (the tutorial's
 * camera hint completes on mouse look, which only the camera reads).
 */
export function tapLook(source: LookSource, onLook: (delta: Vec2) => void): LookSource {
  return {
    lookDelta: () => {
      const delta = source.lookDelta();
      if (delta.x !== 0 || delta.y !== 0) onLook(delta);
      return delta;
    },
    wheelDelta: () => source.wheelDelta(),
  };
}
