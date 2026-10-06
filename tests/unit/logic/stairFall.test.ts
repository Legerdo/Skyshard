import { describe, expect, it } from 'vitest';
import { INITIAL_STAIR_FALL_STATE, STAIR_FALL_DISTANCE, stepStairFall, type StairFallState } from '../../../src/logic/stairFall';

// Starlit_Stair fall rule (task 4.5; Req 5.6).
const TOPS = [13, 90];
const topY = (i: number): number => TOPS[i] ?? Number.NaN;
const onPlatform = (i: number) => ({ grounded: true, platform: i });
const air = { grounded: false, platform: null };

describe('stepStairFall', () => {
  it('remembers the last platform stood on and keeps it while airborne', () => {
    let s: StairFallState = INITIAL_STAIR_FALL_STATE;
    s = stepStairFall(s, onPlatform(0), 13, topY).state;
    expect(s.last).toBe(0);
    s = stepStairFall(s, air, 40, topY).state; // riding the Updraft
    expect(s.last).toBe(0);
    s = stepStairFall(s, onPlatform(1), 90, topY).state;
    expect(s.last).toBe(1);
  });

  it('reports a fall at 10 m below the last platform, not before', () => {
    expect(STAIR_FALL_DISTANCE).toBe(10);
    const s: StairFallState = { last: 1 };
    expect(stepStairFall(s, air, 90 - 9.99, topY)).toEqual({ state: s, fell: null });
    expect(stepStairFall(s, air, 80, topY)).toEqual({ state: INITIAL_STAIR_FALL_STATE, fell: 1 });
    expect(stepStairFall(s, air, 40, topY).fell).toBe(1);
  });

  it('forgets the platform on other ground, so a short drop to the crater floor only lands', () => {
    const s = stepStairFall({ last: 0 }, { grounded: true, platform: null }, 4, topY).state;
    expect(s.last).toBeNull();
    expect(stepStairFall(s, air, -20, topY).fell).toBeNull();
  });

  it('ignores a non-finite height', () => {
    expect(stepStairFall({ last: 1 }, air, Number.NaN, topY).fell).toBeNull();
  });
});
