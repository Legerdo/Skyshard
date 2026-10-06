import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../../src/data/characters';
import { CHARACTER_IDS } from '../../src/data/ids';
import { InputState, type RawInput } from '../../src/input/inputState';
import { STAMINA_RULES, createStaminaState, passiveMultipliers, type StaminaState } from '../../src/logic/stamina';
import { createCollisionWorld } from '../../src/physics/collisionWorld';
import { flatHeightfield } from '../../src/physics/heightfield';
import { RUN_SPEED, SPRINT_SPEED } from '../../src/player/core/constants';
import { staminaActivity } from '../../src/player/core/staminaActivity';
import { MOVE_MODES, type ControllerEvent } from '../../src/player/core/types';
import { PlayerController } from '../../src/player/playerController';
import { STAMINA_RING_START, stepStaminaRing, staminaRingView, type StaminaRingState } from '../../src/ui/staminaRing';

// Task 6.15: party Stamina through the Player_Controller (Req 17.1–17.6). The rule tables themselves are in
// tests/unit/logic/stamina.test.ts; these examples run the real controller on flat ground at 60 Hz.
const DT = 1 / 60;
const down = (code: string): RawInput => ({ kind: 'down', code, time: 0 });
const up = (code: string): RawInput => ({ kind: 'up', code, time: 0 });

function setup(stamina?: StaminaState): { player: PlayerController; input: InputState; tick: (raw?: RawInput[]) => ControllerEvent[] } {
  const player = new PlayerController({ world: createCollisionWorld(flatHeightfield(0)), pos: { x: 0, y: 0, z: 0 }, yaw: 0, stamina });
  const input = new InputState();
  const tick = (raw: RawInput[] = []): ControllerEvent[] => {
    input.beginTick(raw, DT);
    return player.tick(input, 0, DT);
  };
  return { player, input, tick };
}

const SPRINT: RawInput[] = [down('KeyW'), down('ShiftLeft')];
const STOP: RawInput[] = [up('KeyW'), up('ShiftLeft')];
const hSpeed = (p: PlayerController): number => Math.hypot(p.state.vel.x, p.state.vel.z);

describe('Stamina through the controller', () => {
  it('Kairen sprints for 14.4 per second (passive ×0.8), Isla for 18', () => {
    for (const [who, rate] of [['kairen', 14.4], ['isla', 18]] as const) {
      const { player, tick } = setup();
      player.switchCharacter(who);
      tick(SPRINT);
      for (let i = 1; i < 60; i++) tick();
      expect(player.stamina.value).toBeCloseTo(100 - rate, 6);
      expect(hSpeed(player)).toBeCloseTo(SPRINT_SPEED, 9);
    }
  });

  it('recovers nothing for 1 s after the last drain, then 25 per second', () => {
    const { player, tick } = setup();
    tick(SPRINT);
    for (let i = 1; i < 60; i++) tick();
    const drained = player.stamina.value; // 85.6
    tick(STOP);
    for (let i = 1; i < 60; i++) tick();
    expect(player.stamina.value).toBeCloseTo(drained, 9);
    for (let i = 0; i < 30; i++) tick();
    expect(player.stamina.value).toBeCloseTo(drained + 12.5, 6); // 0.5 s at 25/s
    for (let i = 0; i < 60; i++) tick();
    expect(player.stamina.value).toBe(100); // capped at max
  });

  it('turns Exhausted at 0 with one exhausted event, refuses sprint and dodge, and clears at 30 % of max', () => {
    const { player, tick } = setup({ value: 1, max: 100, exhausted: false, idleTimer: 0 });
    const events: ControllerEvent['type'][] = [];
    events.push(...tick(SPRINT).map((e) => e.type));
    for (let i = 1; i < 10; i++) events.push(...tick().map((e) => e.type));
    expect(events).toEqual(['exhausted']);
    expect(player.stamina).toMatchObject({ value: 0, exhausted: true });
    for (let i = 0; i < 20; i++) tick();
    expect(hSpeed(player)).toBeCloseTo(RUN_SPEED, 9); // Shift still held, running
    tick([down('Mouse2'), up('Mouse2')]);
    expect(player.state.mode).toBe('grounded'); // the Dodge is refused

    tick(STOP);
    let prev = player.stamina.value;
    let ticks = 0;
    while (player.stamina.exhausted && ticks++ < 600) {
      prev = player.stamina.value;
      tick();
    }
    expect(prev).toBeLessThan(0.3 * 100);
    expect(player.stamina.value).toBeGreaterThanOrEqual(0.3 * 100);
    expect(player.stamina.value).toBeLessThan(0.3 * 100 + 25 * DT + 1e-9);
  });

  it('keeps the value on a party switch and applies the new passive from the next tick', () => {
    const { player, tick } = setup();
    tick(SPRINT);
    for (let i = 1; i < 30; i++) tick();
    const before = player.stamina.value;
    expect(before).toBeCloseTo(100 - 14.4 / 2, 6);
    player.switchCharacter('isla');
    expect(player.stamina.value).toBe(before);
    tick();
    expect(player.stamina.value).toBeCloseTo(before - 18 * DT, 9);
    player.switchCharacter('kairen');
    const mid = player.stamina.value;
    tick();
    expect(player.stamina.value).toBeCloseTo(mid - 14.4 * DT, 9);
  });
});

describe('passives and the activity summary', () => {
  it('takes the multipliers from the character kits (Talus: the whole climb family)', () => {
    for (const id of CHARACTER_IDS) expect(STAMINA_RULES.passives[id]).toEqual(passiveMultipliers(CHARACTERS[id].passive));
    expect(STAMINA_RULES.passives).toEqual({
      kairen: { sprint: 0.8 },
      isla: { swim: 0.6 },
      wren: { glide: 0.7 },
      talus: { climbMove: 0.75, climbIdle: 0.75, climbLeap: 0.75 },
    });
    expect(passiveMultipliers({ activity: 'unknown', staminaMul: 0.5, text: '' })).toEqual({});
  });

  it('sums up each mode as one StaminaActivity', () => {
    const all = { entered: true, sprinting: true, moving: true };
    const rows = MOVE_MODES.map((m) => [m, staminaActivity(m, all), staminaActivity(m)]);
    expect(Object.fromEntries(rows.map(([m, a, b]) => [m, `${a}/${b}`]))).toEqual({
      grounded: 'sprint/none',
      slide: 'none/none',
      jump: 'none/none',
      fall: 'none/none',
      landing: 'none/none',
      dodge: 'dodge/none',
      climbAttach: 'climbMove/climbIdle',
      climb: 'climbMove/climbIdle',
      climbLeap: 'climbLeap/none',
      mantle: 'none/none',
      glideDeploy: 'glide/glide',
      glide: 'glide/glide',
      swim: 'swim/none',
      hurt: 'none/none',
      downed: 'none/none',
      locked: 'none/none',
    });
  });
});

describe('HUD Stamina ring', () => {
  const at = (value: number, exhausted = false) => ({ value, max: 100, exhausted });
  const frames = (s: StaminaRingState, reading: ReturnType<typeof at>, seconds: number, dt = 0.1): StaminaRingState => {
    let out = s;
    for (let t = 0; t < seconds - 1e-9; t += dt) out = stepStaminaRing(out, reading, dt);
    return out;
  };

  it('is hidden while full at the start, shows below max and hides 2 s after reaching max', () => {
    expect(staminaRingView(frames(STAMINA_RING_START, at(100), 5), at(100)).visible).toBe(false);
    const low = stepStaminaRing(STAMINA_RING_START, at(99.5), DT);
    expect(staminaRingView(low, at(99.5))).toEqual({ visible: true, fill: 0.995, alarm: false });
    const refilled = frames(low, at(100), 1.9);
    expect(staminaRingView(refilled, at(100)).visible).toBe(true);
    expect(staminaRingView(frames(refilled, at(100), 0.1), at(100)).visible).toBe(false);
    // Dropping below max again restarts the 2 s.
    expect(staminaRingView(frames(stepStaminaRing(refilled, at(90), DT), at(100), 1.9), at(100)).visible).toBe(true);
  });

  it('turns red on the exhausted event and back once Exhausted clears', () => {
    const red = stepStaminaRing(STAMINA_RING_START, at(0, true), DT, true);
    expect(red.alarm).toBe(true);
    expect(frames(red, at(29, true), 1).alarm).toBe(true);
    expect(stepStaminaRing(red, at(30), DT).alarm).toBe(false);
    expect(stepStaminaRing(STAMINA_RING_START, at(0, true), DT).alarm).toBe(false); // no event, no alarm
  });
});
