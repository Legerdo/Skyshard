import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, remapBinding } from '../../../src/input/bindings';
import { InputState } from '../../../src/input/inputState';
import { keyLabel } from '../../../src/input/keyLabels';

// Key names on the interaction prompt come from the current bindings (task 4.5; Req 14.3).
describe('keyLabel', () => {
  it('shortens keyboard, mouse and gamepad codes', () => {
    expect(keyLabel('KeyF')).toBe('F');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('Numpad7')).toBe('Num 7');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('ShiftLeft')).toBe('Shift');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('Mouse0')).toBe('좌클릭');
    expect(keyLabel('Mouse2')).toBe('우클릭');
    expect(keyLabel('PadY')).toBe('Y');
    expect(keyLabel('F9')).toBe('F9');
  });

  it('follows a remapped interact key through InputState.bindings', () => {
    const input = new InputState();
    expect(keyLabel(input.bindings.interact)).toBe('F');
    const remapped = remapBinding(DEFAULT_BINDINGS, 'interact', 'KeyG');
    if (!remapped.ok) throw new Error('remap refused');
    input.setBindings(remapped.bindings);
    expect(keyLabel(input.bindings.interact)).toBe('G');
  });
});
