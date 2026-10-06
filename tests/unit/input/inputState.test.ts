import { describe, expect, it } from 'vitest';
import { CHARGE_SECONDS } from '../../../src/input/actions';
import { DEFAULT_BINDINGS } from '../../../src/input/bindings';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { KEY_YAW_RATE, MOUSE_RAD_PER_PX, STICK_DEADZONE, STICK_YAW_RATE } from '../../../src/input/inputState';

const DT = 1 / 60;
const down = (code: string): RawInput => ({ kind: 'down', code, time: 0 });
const up = (code: string): RawInput => ({ kind: 'up', code, time: 0 });
const axes = (moveX: number, moveY: number, lookX = 0, lookY = 0): RawInput =>
  ({ kind: 'axes', moveX, moveY, lookX, lookY });
const idle = (input: InputState, ticks: number): void => { for (let i = 0; i < ticks; i++) input.beginTick([], DT); };

describe('InputState edges, holds and buffer', () => {
  it('reports pressed only on the tick that receives the event', () => {
    const input = new InputState();
    input.beginTick([down('Space')], DT);
    expect([input.pressed('jump'), input.down('jump')]).toEqual([true, true]);
    input.beginTick([], DT); // second tick of the same render frame
    expect([input.pressed('jump'), input.down('jump')]).toEqual([false, true]);
  });

  it('keeps a press and release inside one tick as both edges', () => {
    const input = new InputState();
    input.beginTick([down('KeyE'), up('KeyE')], DT);
    expect([input.pressed('skill'), input.released('skill'), input.down('skill')]).toEqual([true, true, false]);
    input.beginTick([], DT);
    expect(input.released('skill')).toBe(false);
  });

  it('measures holds in sim time and gives the finished length on the released tick', () => {
    const input = new InputState();
    input.beginTick([down('Mouse0')], DT);
    expect(input.heldTime('attack')).toBe(0);
    idle(input, 24);
    expect(input.heldTime('attack')).toBeCloseTo(0.4, 9);
    input.beginTick([up('Mouse0')], DT);
    expect(input.released('attack') && input.heldTime('attack') >= CHARGE_SECONDS).toBe(true); // Charged rule
    expect(input.heldTime('attack')).toBeCloseTo(25 * DT, 9);
    input.beginTick([], DT);
    expect(input.heldTime('attack')).toBe(0);
    input.beginTick([down('KeyR'), down('Mouse1'), up('KeyR')], DT); // lockOn stays down via Mouse1
    expect([input.pressed('lockOn'), input.released('lockOn'), input.down('lockOn')]).toEqual([true, false, true]);
  });

  it('buffers jump for 0.15 s and hands it out once', () => {
    const input = new InputState();
    input.beginTick([down('Space'), up('Space')], DT);
    idle(input, 5);
    expect([input.consumeBuffered('jump'), input.consumeBuffered('jump')]).toEqual([true, false]);
    input.beginTick([down('Space'), up('Space')], DT);
    idle(input, 9); // exactly 0.15 s later
    expect(input.consumeBuffered('jump')).toBe(true);
    input.beginTick([down('Space'), up('Space')], DT);
    idle(input, 10); // 0.167 s: expired
    expect([input.consumeBuffered('jump'), input.consumeBuffered('attack')]).toEqual([false, false]);
  });

  it('isBuffered peeks at a buffered press without consuming it', () => {
    const input = new InputState();
    expect(input.isBuffered('dodge')).toBe(false);
    input.beginTick([down('Mouse2'), up('Mouse2')], DT);
    idle(input, 9);
    expect([input.isBuffered('dodge'), input.isBuffered('dodge'), input.isBuffered('jump')]).toEqual([true, true, false]);
    expect([input.consumeBuffered('dodge'), input.isBuffered('dodge')]).toEqual([true, false]);
    input.beginTick([down('Mouse2'), up('Mouse2')], DT);
    idle(input, 10); // 0.167 s: expired
    expect(input.isBuffered('dodge')).toBe(false);
  });

  it('flips walkToggled once per press and applies new bindings', () => {
    const input = new InputState();
    input.beginTick([down('KeyX')], DT);
    idle(input, 3);
    expect(input.walkToggled).toBe(true);
    input.beginTick([up('KeyX'), down('KeyX')], DT);
    expect(input.walkToggled).toBe(false);
    input.setBindings({ ...DEFAULT_BINDINGS, jump: 'KeyG' });
    expect(input.down('walkToggle')).toBe(false); // held across the change: ignored until released
    input.beginTick([down('Space'), down('KeyG')], DT);
    expect([input.pressed('jump'), input.down('jump')]).toEqual([true, true]);
  });
});

describe('InputState contexts', () => {
  it('clears edges on a switch and ignores held non-movement keys until released', () => {
    const input = new InputState();
    input.beginTick([down('KeyW'), down('KeyF'), down('Space')], DT);
    input.setContext('dialogue');
    expect([input.context, input.pressed('interact'), input.down('interact')]).toEqual(['dialogue', false, false]);
    expect([input.down('jump'), input.consumeBuffered('jump')]).toEqual([false, false]);
    input.beginTick([up('KeyF')], DT);
    expect(input.released('interact')).toBe(false);
    input.beginTick([down('KeyF')], DT);
    expect(input.pressed('interact')).toBe(true);
    input.setContext('gameplay');
    const after = [input.down('moveForward'), input.pressed('moveForward'), input.down('interact')];
    expect(after).toEqual([true, false, false]); // movement stays down; F is ignored again
    expect(input.moveVector()).toEqual({ x: 0, y: 1 });
  });

  it('reads actions outside the context as idle', () => {
    const input = new InputState();
    input.setContext('menu');
    input.beginTick([down('Space'), down('KeyW'), down('KeyI'), { kind: 'mouseMove', dx: 50, dy: 0 }], DT);
    expect([input.pressed('jump'), input.down('jump'), input.heldTime('jump')]).toEqual([false, false, 0]);
    expect([input.moveVector(), input.lookDelta()]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
    expect(input.pressed('inventory')).toBe(true);
    input.beginTick([down('Escape'), up('Space')], DT);
    expect([input.pressed('pause'), input.released('jump')]).toEqual([true, false]);
  });

  it('releaseAll lets go of every held input', () => {
    const input = new InputState();
    input.beginTick([down('KeyW'), down('Mouse0'), axes(1, 0)], DT);
    input.beginTick([{ kind: 'releaseAll' }], DT);
    expect([input.down('moveForward'), input.down('attack'), input.released('attack')]).toEqual([false, false, true]);
    expect(input.moveVector()).toEqual({ x: 0, y: 0 });
    input.beginTick([down('Mouse0')], DT);
    expect(input.pressed('attack')).toBe(true);
  });
});

describe('InputState movement and look', () => {
  it('normalizes diagonal keys and cancels opposite ones', () => {
    const input = new InputState();
    input.beginTick([down('KeyW'), down('KeyD')], DT);
    expect(input.moveVector().x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(input.moveVector().y).toBeCloseTo(Math.SQRT1_2, 9);
    input.beginTick([up('KeyD'), down('KeyS')], DT);
    expect(input.moveVector()).toEqual({ x: 0, y: 0 });
  });

  it('applies the stick deadzone and prefers the longer of stick and keys', () => {
    const input = new InputState();
    input.beginTick([axes(0.1, -0.05)], DT);
    expect(input.moveVector()).toEqual({ x: 0, y: 0 });
    input.beginTick([axes(0, -1)], DT);
    expect(input.moveVector()).toEqual({ x: 0, y: 1 });
    input.beginTick([axes(0.5, 0)], DT);
    expect(input.moveVector().x).toBeCloseTo((0.5 - STICK_DEADZONE) / (1 - STICK_DEADZONE), 9);
    input.beginTick([down('KeyA')], DT);
    expect(input.moveVector()).toEqual({ x: -1, y: 0 });
  });

  it('accumulates scaled mouse, key and stick look and resets after reading', () => {
    const input = new InputState(DEFAULT_BINDINGS, { sensitivity: 2, invertY: false });
    input.beginTick([{ kind: 'mouseMove', dx: 10, dy: 4 }, { kind: 'mouseMove', dx: 5, dy: 0 }], DT);
    const mouse = input.lookDelta();
    expect(mouse.x).toBeCloseTo(15 * MOUSE_RAD_PER_PX * 2, 9);
    expect(mouse.y).toBeCloseTo(4 * MOUSE_RAD_PER_PX * 2, 9);
    expect(input.lookDelta()).toEqual({ x: 0, y: 0 });
    input.setLookOptions({ sensitivity: 1, invertY: true });
    input.beginTick([down('ArrowRight'), { kind: 'mouseMove', dx: 0, dy: 10 }, axes(0, 0, 1, 0)], DT);
    const mixed = input.lookDelta();
    expect(mixed.x).toBeCloseTo((KEY_YAW_RATE + STICK_YAW_RATE) * DT, 9);
    expect(mixed.y).toBeCloseTo(-10 * MOUSE_RAD_PER_PX, 9);
    input.beginTick([up('ArrowRight'), axes(0, 0, 0.1, 0), { kind: 'wheel', delta: 100 }], DT);
    expect([input.lookDelta(), input.wheelDelta(), input.wheelDelta()]).toEqual([{ x: 0, y: 0 }, 100, 0]);
  });
});
