import { describe, expect, it } from 'vitest';
import { GAMEPAD_BUTTON_CODES } from '../../../src/input/bindings';
import { padToRawInputs, type PadSnapshot } from '../../../src/input/gamepad';
import type { RawInput } from '../../../src/input/inputState';

const BUTTON_COUNT = GAMEPAD_BUTTON_CODES.length;
const RT = GAMEPAD_BUTTON_CODES.indexOf('PadRT');
/** Standard-mapping snapshot: every button at 0 except `values` (index → value). */
const snap = (values: Record<number, number> = {}, axes: number[] = [0, 0, 0, 0]): PadSnapshot => ({
  buttons: Array.from({ length: BUTTON_COUNT }, (_, i) => values[i] ?? 0),
  axes,
});
const buttonEvents = (events: readonly RawInput[]): RawInput[] => events.filter((e) => e.kind !== 'axes');
const NO_AXES: RawInput = { kind: 'axes', moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

describe('padToRawInputs', () => {
  it('emits downs for buttons already pressed on the first snapshot, then one axes event', () => {
    const { pressed, events } = padToRawInputs(null, snap({ 0: 1, 12: 1 }, [0.5, -0.25, 0, 1]));
    expect(events).toEqual([
      { kind: 'down', code: 'PadA', time: 0 },
      { kind: 'down', code: 'PadUp', time: 0 },
      { kind: 'axes', moveX: 0.5, moveY: -0.25, lookX: 0, lookY: 1 },
    ]);
    expect(pressed).toHaveLength(BUTTON_COUNT);
    expect(pressed.flatMap((down, i) => (down ? [GAMEPAD_BUTTON_CODES[i]] : []))).toEqual(['PadA', 'PadUp']);
  });

  it('emits only the axes event when no button changed', () => {
    const first = padToRawInputs(null, snap({ 1: 1 }));
    const second = padToRawInputs(first.pressed, snap({ 1: 1 }));
    expect(second.events).toEqual([NO_AXES]);
    expect(second.pressed).toEqual(first.pressed);
  });

  it('counts the analog RT as down from 0.5 and up again below it', () => {
    let state = padToRawInputs(null, snap({ [RT]: 0.4 }));
    expect(buttonEvents(state.events)).toEqual([]);
    state = padToRawInputs(state.pressed, snap({ [RT]: 0.6 }));
    expect(buttonEvents(state.events)).toEqual([{ kind: 'down', code: 'PadRT', time: 0 }]);
    state = padToRawInputs(state.pressed, snap({ [RT]: 0.4 }));
    expect(buttonEvents(state.events)).toEqual([{ kind: 'up', code: 'PadRT', time: 0 }]);
    state = padToRawInputs(state.pressed, snap({ [RT]: 0.5 }));
    expect(buttonEvents(state.events)).toEqual([{ kind: 'down', code: 'PadRT', time: 0 }]);
  });

  it('reads missing axes as 0 and missing buttons as up', () => {
    expect(padToRawInputs(null, { buttons: [], axes: [] }).events).toEqual([NO_AXES]);
    const held = padToRawInputs(null, snap({ 0: 1 })).pressed;
    expect(padToRawInputs(held, { buttons: [], axes: [0.3, Number.NaN] }).events).toEqual([
      { kind: 'up', code: 'PadA', time: 0 },
      { kind: 'axes', moveX: 0.3, moveY: 0, lookX: 0, lookY: 0 },
    ]);
  });
});
