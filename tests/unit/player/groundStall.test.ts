import { describe, expect, it } from 'vitest';
import { createStaminaState } from '../../../src/logic/stamina';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { stepController } from '../../../src/player/core/stepController';
import { createControllerState, type ControllerInput } from '../../../src/player/core/types';
import { buildTerrain } from '../../../src/world/terrain';

// Regression (found by the task 4.9 route walk): on gentle bilinear terrain a grounded run could stop dead
// for good where the ground ahead rose inside the 0.01 m skin gap, every slide iteration moving 0 m.
describe('stepController on gently rising terrain', () => {
  it('keeps running where walkable ground ahead is within the skin gap (Thistlewick, seed 20240601)', () => {
    const terrain = buildTerrain(20240601);
    const world = createCollisionWorld(terrain);
    const start = {
      ...createControllerState({ x: -217.9925402494412, y: 18.10722125640648, z: 289.7141913075304 }, 2.0902568453991535),
      vel: { x: 5.2085226658188475, y: 0, z: -2.9784713595486076 },
    };
    const input: ControllerInput = { move: { x: 0.868, z: -0.4966 }, sprint: false, walk: false, jump: false, dodge: false, release: false };
    let s = start;
    let stamina = createStaminaState();
    for (let i = 0; i < 30; i++) {
      const r = stepController(s, input, world, stamina, 'kairen', 1 / 60);
      s = r.state;
      stamina = r.stamina;
      expect(s.pos.y).toBeGreaterThanOrEqual(terrain.heightAt(s.pos.x, s.pos.z) - 1e-6);
    }
    expect(Math.hypot(s.pos.x - start.pos.x, s.pos.z - start.pos.z)).toBeGreaterThan(2.5); // ≈ 6 m/s × 0.5 s
    expect(s.mode).toBe('grounded');
  });
});
