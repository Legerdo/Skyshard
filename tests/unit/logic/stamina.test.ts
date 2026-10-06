import { describe, expect, it } from 'vitest';
import type { CharacterId } from '../../../src/data/ids';
import {
  STAMINA_RULES,
  canStart,
  createStaminaState,
  newStamina,
  spendOneShot,
  completedTabletSets,
  staminaMax,
  stepStamina,
} from '../../../src/logic/stamina';
import type { StaminaActivity, StaminaState } from '../../../src/logic/stamina';
import * as moveConstants from '../../../src/player/core/constants';

/** Applies `activity` for `steps` ticks of `dt`. */
function run(s: StaminaState, activity: StaminaActivity, steps: number, dt: number, who: CharacterId = 'isla'): StaminaState {
  let out = s;
  for (let i = 0; i < steps; i++) out = stepStamina(out, activity, who, dt);
  return out;
}

describe('max and rules', () => {
  it('max is 100 + 15 per completed tablet set and a new state starts full', () => {
    expect([staminaMax(0), staminaMax(3)]).toEqual([100, 145]);
    expect(newStamina(145)).toEqual({ value: 145, max: 145, exhausted: false, idleTimer: 0 });
    expect(STAMINA_RULES).toMatchObject({ regenPerSecond: 25, regenDelay: 1, exhaustClearRatio: 0.3 });
  });

  it('counts a Region set only when all three of its Echo_Tablets are collected', () => {
    const set = (region: string): string[] => [1, 2, 3].map((n) => `tab_${region}_${n}`);
    expect(completedTabletSets([])).toBe(0);
    expect(completedTabletSets(['tab_verdant_1', 'tab_verdant_2', 'tab_ember_3', 'tab_verdant_4'])).toBe(0);
    expect(completedTabletSets([...set('ember'), 'tab_ember_1', 'tab_azure_1'])).toBe(1);
    expect(completedTabletSets([...set('azure'), ...set('verdant'), ...set('ember'), ...set('crater')])).toBe(3);
  });

  it('createStaminaState defaults to a full 100 and the controller constants re-export the rates', () => {
    expect(createStaminaState()).toEqual(newStamina(100));
    expect(createStaminaState(130)).toEqual(newStamina(130));
    expect(moveConstants).toMatchObject({
      SPRINT_STAMINA_PER_SEC: STAMINA_RULES.drainPerSecond.sprint,
      CLIMB_MOVE_STAMINA_PER_SEC: STAMINA_RULES.drainPerSecond.climbMove,
      CLIMB_IDLE_STAMINA_PER_SEC: STAMINA_RULES.drainPerSecond.climbIdle,
      GLIDE_STAMINA_PER_SEC: STAMINA_RULES.drainPerSecond.glide,
      SWIM_STAMINA_PER_SEC: STAMINA_RULES.drainPerSecond.swim,
      DODGE_STAMINA_COST: STAMINA_RULES.oneShotCost.dodge,
      CLIMB_LEAP_STAMINA_COST: STAMINA_RULES.oneShotCost.climbLeap,
    });
  });
});

describe('drain', () => {
  it.each([
    ['sprint', 'isla', 18], ['sprint', 'kairen', 14.4],
    ['climbMove', 'wren', 10], ['climbMove', 'talus', 7.5],
    ['climbIdle', 'kairen', 2], ['climbIdle', 'talus', 1.5],
    ['glide', 'talus', 6], ['glide', 'wren', 4.2],
    ['swim', 'kairen', 6], ['swim', 'isla', 3.6],
  ] as const)('%s as %s drains %d per second', (activity, who, rate) => {
    expect(stepStamina(newStamina(100), activity, who, 1).value).toBeCloseTo(100 - rate, 9);
    expect(run(newStamina(100), activity, 60, 1 / 60, who).value).toBeCloseTo(100 - rate, 9);
  });

  it('one-shots cost a flat amount regardless of dt, and only Talus discounts climbLeap', () => {
    const full = newStamina(100);
    expect(spendOneShot(full, 'dodge', 'talus').value).toBe(80);
    expect(spendOneShot(full, 'climbLeap', 'kairen').value).toBe(80);
    expect(spendOneShot(full, 'climbLeap', 'talus').value).toBe(85);
    expect(stepStamina(full, 'dodge', 'wren', 1 / 60).value).toBe(80);
    expect(stepStamina(full, 'dodge', 'wren', 0.5).value).toBe(80);
    expect(stepStamina({ ...full, idleTimer: 3 }, 'climbLeap', 'talus', 0).idleTimer).toBe(0);
  });

  it('never drops below 0 and leaves its input untouched', () => {
    const full = newStamina(100);
    expect(run(full, 'sprint', 20, 1, 'kairen').value).toBe(0);
    expect(spendOneShot({ ...full, value: 5 }, 'dodge', 'isla').value).toBe(0);
    expect(full).toEqual(newStamina(100));
  });
});

describe('regen', () => {
  const drained = stepStamina(newStamina(100), 'sprint', 'isla', 1); // 82

  it('regenerates 25/s only after 1 s without drain, however dt is split', () => {
    const waited = run(drained, 'none', 4, 0.25);
    expect(waited).toMatchObject({ value: 82, idleTimer: 1 });
    expect(stepStamina(waited, 'none', 'isla', 0.25).value).toBe(88.25);
    expect(run(drained, 'none', 6, 0.25).value).toBe(94.5);
    expect(stepStamina(drained, 'none', 'isla', 1.5).value).toBe(94.5);
    expect(run(drained, 'none', 10, 1).value).toBe(100);
  });

  it('any drain restarts the 1 s delay', () => {
    const tick = stepStamina(run(drained, 'none', 3, 0.25), 'climbIdle', 'isla', 0.25); // 81.5
    expect(tick).toMatchObject({ value: 81.5, idleTimer: 0 });
    expect(run(tick, 'none', 4, 0.25).value).toBe(81.5);
    expect(run(tick, 'none', 5, 0.25).value).toBe(87.75);
  });
});

describe('exhausted hysteresis', () => {
  it('turns on at 0 and clears only once value reaches 30% of max', () => {
    const empty = run(newStamina(100), 'sprint', 6, 1);
    expect(empty).toMatchObject({ value: 0, exhausted: true });
    const low = run(empty, 'none', 2, 1);
    expect(low).toMatchObject({ value: 25, exhausted: true });
    const almost = stepStamina(low, 'none', 'isla', 0.1875);
    expect(almost).toMatchObject({ value: 29.6875, exhausted: true });
    expect(stepStamina(almost, 'none', 'isla', 0.0625)).toMatchObject({ value: 31.25, exhausted: false });

    const big = stepStamina({ value: 47.5, max: 200, exhausted: true, idleTimer: 1 }, 'none', 'isla', 0.25);
    expect(big).toMatchObject({ value: 53.75, exhausted: true });
    expect(stepStamina(big, 'none', 'isla', 0.25)).toMatchObject({ value: 60, exhausted: false });
  });

  it('is not set above 0 and stays set while draining at 0', () => {
    const low = run(newStamina(100), 'sprint', 5, 1);
    expect(low).toMatchObject({ value: 10, exhausted: false });
    const empty = spendOneShot(low, 'dodge', 'isla');
    expect(empty).toMatchObject({ value: 0, exhausted: true });
    expect(stepStamina(empty, 'swim', 'isla', 1)).toMatchObject({ value: 0, exhausted: true });
  });
});

describe('canStart', () => {
  it('refuses all but swim and none while exhausted', () => {
    const s: StaminaState = { value: 50, max: 200, exhausted: true, idleTimer: 0 };
    const all: StaminaActivity[] = ['sprint', 'dodge', 'climbMove', 'climbIdle', 'climbLeap', 'glide', 'swim', 'none'];
    expect(all.map((activity) => canStart(s, activity))).toEqual([false, false, false, false, false, false, true, true]);
  });

  it('needs the one-shot cost for dodge and climbLeap', () => {
    const s = { ...newStamina(100), value: 19.9 };
    expect([canStart(s, 'dodge'), canStart(s, 'climbLeap'), canStart(s, 'sprint')]).toEqual([false, false, true]);
    expect([canStart({ ...s, value: 20 }, 'dodge'), canStart({ ...s, value: 20 }, 'climbLeap')]).toEqual([true, true]);
  });
});
