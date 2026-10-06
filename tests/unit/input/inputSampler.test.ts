import { describe, expect, it } from 'vitest';
import { InputSampler } from '../../../src/input/inputSampler';
import { InputState, MOUSE_RAD_PER_PX, STICK_DEADZONE, type RawInput } from '../../../src/input/inputState';

// Frame → tick hand-off (design "Tick 갱신 순서"): collect() once per render frame, beginTick() per sim tick.
const DT = 1 / 60;
const down = (code: string): RawInput => ({ kind: 'down', code, time: 0 });
const up = (code: string): RawInput => ({ kind: 'up', code, time: 0 });
const axes = (moveX: number, moveY: number): RawInput => ({ kind: 'axes', moveX, moveY, lookX: 0, lookY: 0 });

function setup(): { state: InputState; sampler: InputSampler } {
  const state = new InputState();
  return { state, sampler: new InputSampler(state) };
}

describe('InputSampler', () => {
  it('gives a frame’s events to its first tick only (a 30 fps frame running two ticks)', () => {
    const { state, sampler } = setup();
    sampler.collect([down('Space')]);
    sampler.beginTick(DT);
    expect([state.pressed('jump'), state.isBuffered('jump')]).toEqual([true, true]);
    sampler.beginTick(DT);
    expect([state.pressed('jump'), state.down('jump')]).toEqual([false, true]);
  });

  it('keeps the events of frames without a tick for the next tick (144 fps)', () => {
    const { state, sampler } = setup();
    sampler.collect([down('Space')]);
    sampler.collect([up('Space')]); // second frame, still no tick
    expect(sampler.pendingCount).toBe(2);
    sampler.beginTick(DT);
    expect([state.pressed('jump'), state.released('jump'), state.down('jump')]).toEqual([true, true, false]);
    expect(sampler.pendingCount).toBe(0);
  });

  it('adds mouse look at once, before any tick, and not again on the next tick', () => {
    const { state, sampler } = setup();
    sampler.collect([{ kind: 'mouseMove', dx: 12, dy: -3 }]);
    expect(sampler.pendingCount).toBe(0);
    const look = state.lookDelta();
    expect(look.x).toBeCloseTo(12 * MOUSE_RAD_PER_PX, 12);
    expect(look.y).toBeCloseTo(-3 * MOUSE_RAD_PER_PX, 12);
    sampler.beginTick(DT);
    expect(state.lookDelta()).toEqual({ x: 0, y: 0 });
  });

  it('reduces back-to-back gamepad polls to the latest stick state', () => {
    const { state, sampler } = setup();
    for (let frame = 0; frame < 30; frame++) sampler.collect([axes(0, -0.2)]); // paused: no ticks
    sampler.collect([axes(1, 0)]);
    expect(sampler.pendingCount).toBe(1);
    sampler.beginTick(DT);
    expect(state.moveVector()).toEqual({ x: 1, y: 0 });

    sampler.collect([axes(0, 0), down('Space'), axes(0.6, 0)]);
    expect(sampler.pendingCount).toBe(3); // a key event between polls keeps both, in order
    sampler.beginTick(DT);
    expect(state.pressed('jump')).toBe(true);
    expect(state.moveVector().x).toBeCloseTo((0.6 - STICK_DEADZONE) / (1 - STICK_DEADZONE), 12);
  });

  it('flush() under a menu tracks held keys, so the key that closes the menu is ignored in play until released', () => {
    const { state, sampler } = setup();
    state.setContext('menu');
    sampler.collect([down('Space'), down('KeyW')]); // e.g. gamepad A / Space confirming "새로 시작", W held
    sampler.flush();
    expect(sampler.pendingCount).toBe(0);
    expect(state.pressed('jump')).toBe(false); // the menu context reads game actions as idle

    state.setContext('gameplay'); // the Gameplay HUD is on top now
    sampler.beginTick(DT);
    expect([state.pressed('jump'), state.down('jump'), state.isBuffered('jump')]).toEqual([false, false, false]);
    expect(state.down('moveForward')).toBe(true); // movement keys stay down across the switch

    sampler.collect([up('Space'), down('Space')]);
    sampler.beginTick(DT);
    expect(state.pressed('jump')).toBe(true);
  });

  it('flush() clears the previous edges even without new events', () => {
    const { state, sampler } = setup();
    state.setContext('menu');
    sampler.collect([down('F3')]);
    sampler.flush();
    expect(state.pressed('perfOverlay')).toBe(true); // allowed in menus
    sampler.flush();
    expect(state.pressed('perfOverlay')).toBe(false);
  });
});
