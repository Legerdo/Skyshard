import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, type Bindings } from '../../../src/input/bindings';
import {
  ACTION_LABELS,
  REMAP_TEXT,
  RemapFlow,
  reservedMessage,
  swapMessage,
  type RemapOutcome,
} from '../../../src/settings/remapFlow';

const defaults = (): Bindings => ({ ...DEFAULT_BINDINGS });

/** The outcome as `applied`, or a failed test. */
function applied(outcome: RemapOutcome): Extract<RemapOutcome, { kind: 'applied' }> {
  if (outcome.kind !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
  return outcome;
}

describe('RemapFlow: waiting for the new key', () => {
  it('ignores input while idle', () => {
    const flow = new RemapFlow();
    expect(flow.phase).toBe('idle');
    expect(flow.input('KeyG', 'down', defaults())).toEqual({ kind: 'ignored' });
    expect(flow.cancel()).toEqual({ kind: 'ignored' });
  });

  it('listens only after the input that chose the action (Enter / A) is released', () => {
    const flow = new RemapFlow();
    flow.begin('jump', 'Enter');
    expect([flow.phase, flow.action, flow.active]).toEqual(['armed', 'jump', true]);
    expect(flow.input('KeyG', 'down', defaults())).toEqual({ kind: 'ignored' }); // still holding Enter
    expect(flow.input('KeyG', 'up', defaults())).toEqual({ kind: 'ignored' });
    expect(flow.phase).toBe('armed');
    flow.input('Enter', 'up', defaults());
    expect(flow.phase).toBe('listening');
    const out = applied(flow.input('KeyG', 'down', defaults()));
    expect(out).toMatchObject({ action: 'jump', code: 'KeyG', swappedWith: null, message: '점프: G 키로 지정했습니다' });
    expect(out.bindings).toEqual({ ...DEFAULT_BINDINGS, jump: 'KeyG' });
    expect([flow.phase, flow.action]).toEqual(['idle', null]);
  });

  it('listens at once after a mouse click, and a new press of an unseen-released trigger counts as the first input', () => {
    const clicked = new RemapFlow();
    clicked.begin('heal', null);
    expect(clicked.phase).toBe('listening');

    const flow = new RemapFlow();
    flow.begin('jump', 'Enter');
    const out = applied(flow.input('Enter', 'down', defaults()));
    expect(out.bindings.jump).toBe('Enter');
  });

  it('takes a mouse button as `Mouse` + button and swaps with its owner', () => {
    const flow = new RemapFlow();
    flow.begin('attack', null);
    const out = applied(flow.input('Mouse2', 'down', defaults()));
    expect(out.swappedWith).toBe('dodge');
    expect(out.bindings).toEqual({ ...DEFAULT_BINDINGS, attack: 'Mouse2', dodge: 'Mouse0' });
    expect(out.message).toBe('공격 ↔ Dodge: 키를 서로 바꿨습니다');
  });
});

describe('RemapFlow: swap, refusal and cancel', () => {
  it('swaps a key another action used and names both actions ("점프 ↔ 상호작용")', () => {
    const flow = new RemapFlow();
    const bindings = defaults();
    flow.begin('jump', null);
    const out = applied(flow.input('KeyF', 'down', bindings));
    expect(out.swappedWith).toBe('interact');
    expect(out.bindings).toEqual({ ...DEFAULT_BINDINGS, jump: 'KeyF', interact: 'Space' });
    expect(out.message).toBe('점프 ↔ 상호작용: 키를 서로 바꿨습니다');
    expect(swapMessage('jump', 'interact')).toBe(out.message);
    expect(bindings).toEqual(DEFAULT_BINDINGS); // the current bindings are never modified
  });

  it('refuses reserved and fixed keys as reserved and keeps waiting', () => {
    const flow = new RemapFlow();
    const bindings = defaults();
    flow.begin('skill', null);
    for (const code of ['F5', 'F11', 'Tab', 'AltLeft', 'ControlRight', 'MetaLeft', 'F3', 'ArrowUp', 'ArrowLeft', 'Mouse1']) {
      const out = flow.input(code, 'down', bindings);
      expect(out, code).toEqual({ kind: 'refused', action: 'skill', code, reason: 'reserved', message: reservedMessage(code) });
      expect([flow.phase, flow.action]).toEqual(['listening', 'skill']);
    }
    expect(reservedMessage('F5')).toBe('F5 키는 예약된 키라 지정할 수 없습니다');
    expect(reservedMessage('Mouse1')).toBe('휠 클릭 키는 예약된 키라 지정할 수 없습니다');
    expect(bindings).toEqual(DEFAULT_BINDINGS);
    // The next accepted key still goes to the same action.
    expect(applied(flow.input('KeyT', 'down', bindings)).bindings.skill).toBe('KeyT');
  });

  it('refuses codes outside the supported list as unknown, and gamepad buttons (fixed layout)', () => {
    const flow = new RemapFlow();
    flow.begin('burst', null);
    for (const code of ['Mouse3', 'Mouse4', 'Unidentified', 'IntlRo']) {
      expect(flow.input(code, 'down', defaults()), code).toEqual({
        kind: 'refused',
        action: 'burst',
        code,
        reason: 'unknown',
        message: REMAP_TEXT.unknown,
      });
    }
    expect(flow.input('PadX', 'down', defaults())).toMatchObject({ kind: 'refused', reason: 'unknown', message: REMAP_TEXT.gamepad });
    expect(flow.active).toBe(true);
  });

  it('cancels with Esc or gamepad B (the remap only) and on request', () => {
    for (const code of ['Escape', 'PadB']) {
      const flow = new RemapFlow();
      flow.begin('jump', null);
      expect(flow.input(code, 'down', defaults()), code).toEqual({ kind: 'cancelled', action: 'jump', message: REMAP_TEXT.cancelled });
      expect(flow.phase).toBe('idle');
    }
    // Esc cancels even before the trigger was released.
    const armed = new RemapFlow();
    armed.begin('map', 'PadA');
    expect(armed.input('Escape', 'down', defaults()).kind).toBe('cancelled');
    // Closing the screen or switching tabs.
    const flow = new RemapFlow();
    flow.begin('quest', null);
    expect(flow.cancel()).toEqual({ kind: 'cancelled', action: 'quest', message: REMAP_TEXT.cancelled });
    expect(flow.active).toBe(false);
  });

  it('keeps the current code as it is and has a Korean label for every remappable action', () => {
    const flow = new RemapFlow();
    flow.begin('attack', null);
    const out = applied(flow.input('Mouse0', 'down', defaults()));
    expect([out.swappedWith, out.bindings]).toEqual([null, DEFAULT_BINDINGS]);
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(Object.keys(DEFAULT_BINDINGS).sort());
    expect(new Set(Object.values(ACTION_LABELS)).size).toBe(Object.keys(ACTION_LABELS).length);
    expect(REMAP_TEXT.prompt).toBe('새 키를 누르세요');
  });
});
