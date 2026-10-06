import { describe, expect, it } from 'vitest';
import { INPUT_ACTIONS, REMAPPABLE_ACTIONS, type RemappableAction } from '../../../src/input/actions';
import {
  DEFAULT_BINDINGS,
  RESERVED_CODES,
  buildCodeMap,
  isValidBindings,
  remapBinding,
  sanitizeBindings,
  type Bindings,
} from '../../../src/input/bindings';

const withBinding = (action: RemappableAction, code: unknown): Record<string, unknown> => ({
  ...DEFAULT_BINDINGS,
  [action]: code,
});

describe('default bindings', () => {
  it('bind every remappable action to a distinct, non-reserved code', () => {
    expect(isValidBindings(DEFAULT_BINDINGS)).toBe(true);
    // Fixed: pause (Esc), perfOverlay (F3) and the four arrow-key camera actions (task 14.4, design "키 재지정").
    expect(REMAPPABLE_ACTIONS).toHaveLength(INPUT_ACTIONS.length - 6);
    for (const fixed of ['pause', 'perfOverlay', 'camLeft', 'camRight', 'camUp', 'camDown']) {
      expect(REMAPPABLE_ACTIONS).not.toContain(fixed);
    }
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual([...REMAPPABLE_ACTIONS].sort());
    expect(DEFAULT_BINDINGS).toMatchObject({
      moveForward: 'KeyW',
      jump: 'Space',
      sprint: 'ShiftLeft',
      walkToggle: 'KeyX',
      attack: 'Mouse0',
      dodge: 'Mouse2',
    });
    expect(Object.isFrozen(DEFAULT_BINDINGS)).toBe(true);
  });

  it('code map adds the fixed keyboard, mouse and gamepad inputs', () => {
    const map = buildCodeMap(DEFAULT_BINDINGS);
    expect(map.get('KeyW')).toEqual(['moveForward']);
    expect(map.get('Escape')).toEqual(['pause']);
    expect(map.get('F3')).toEqual(['perfOverlay']);
    expect(map.get('Mouse1')).toEqual(['lockOn']);
    expect(map.get('ArrowLeft')).toEqual(['camLeft']);
    expect(map.get('ArrowDown')).toEqual(['camDown']);
    expect(map.get('ShiftRight')).toEqual(['sprint']);
    expect(map.get('PadA')).toEqual(['jump']);
    expect(map.get('PadB')).toEqual(['dodge', 'release']);
    expect(map.get('KeyP')).toBeUndefined();
  });
});

describe('remapBinding', () => {
  it('moves an action to an unused code and leaves the argument untouched', () => {
    const before: Bindings = { ...DEFAULT_BINDINGS };
    expect(remapBinding(DEFAULT_BINDINGS, 'jump', 'KeyG')).toEqual({
      ok: true,
      bindings: { ...DEFAULT_BINDINGS, jump: 'KeyG' },
      swappedWith: null,
    });
    expect(DEFAULT_BINDINGS).toEqual(before);
  });

  it('swaps with the action that already uses the code, keeping a bijection', () => {
    const b: Bindings = { ...DEFAULT_BINDINGS };
    const result = remapBinding(b, 'jump', 'KeyF');
    expect(result).toEqual({
      ok: true,
      bindings: { ...DEFAULT_BINDINGS, jump: 'KeyF', interact: 'Space' },
      swappedWith: 'interact',
    });
    expect(b.jump).toBe('Space');
    if (!result.ok) throw new Error('expected ok');
    expect(isValidBindings(result.bindings)).toBe(true);
    expect(buildCodeMap(result.bindings).get('Space')).toEqual(['interact']);
  });

  it('returns an equal copy for the current code', () => {
    const result = remapBinding(DEFAULT_BINDINGS, 'attack', 'Mouse0');
    expect(result).toEqual({ ok: true, bindings: { ...DEFAULT_BINDINGS }, swappedWith: null });
    if (result.ok) expect(result.bindings).not.toBe(DEFAULT_BINDINGS);
  });

  it('rejects reserved codes and unknown codes or actions', () => {
    for (const code of RESERVED_CODES) {
      expect(remapBinding(DEFAULT_BINDINGS, 'jump', code), code).toEqual({ ok: false, reason: 'reserved' });
    }
    for (const code of ['Mouse3', 'Unidentified', '', 'PadA', 'keyw']) {
      expect(remapBinding(DEFAULT_BINDINGS, 'jump', code), code).toEqual({ ok: false, reason: 'unknown' });
    }
    const fixed = 'pause' as RemappableAction;
    expect(remapBinding(DEFAULT_BINDINGS, fixed, 'KeyP')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('lets a binding take ShiftRight, which then no longer sprints', () => {
    const result = remapBinding(DEFAULT_BINDINGS, 'jump', 'ShiftRight');
    if (!result.ok) throw new Error('expected ok');
    expect(buildCodeMap(result.bindings).get('ShiftRight')).toEqual(['jump']);
  });
});

describe('isValidBindings / sanitizeBindings', () => {
  const { jump: _jump, ...missingJump } = DEFAULT_BINDINGS;

  it('fall back to the defaults on duplicates, reserved or unknown codes and bad shapes', () => {
    const invalid: unknown[] = [
      undefined,
      null,
      42,
      'KeyW',
      [],
      {},
      missingJump,
      withBinding('jump', 'KeyW'),
      withBinding('jump', 'Escape'),
      withBinding('jump', 'Mouse3'),
      withBinding('jump', 7),
      withBinding('jump', null),
    ];
    for (const x of invalid) {
      expect(isValidBindings(x), JSON.stringify(x)).toBe(false);
      expect(sanitizeBindings(x)).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('keep valid bindings, drop extra keys and always return a fresh object', () => {
    const custom = { ...withBinding('jump', 'KeyG'), extra: 'KeyP' };
    expect(isValidBindings(custom)).toBe(true);
    expect(sanitizeBindings(custom)).toEqual({ ...DEFAULT_BINDINGS, jump: 'KeyG' });
    expect(sanitizeBindings(JSON.parse(JSON.stringify(custom)))).toEqual({ ...DEFAULT_BINDINGS, jump: 'KeyG' });
    const fallback = sanitizeBindings('garbage');
    expect(fallback).not.toBe(DEFAULT_BINDINGS);
    expect(Object.isFrozen(fallback)).toBe(false);
  });
});
