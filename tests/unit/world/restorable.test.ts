import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import { flatHeightfield } from '../../../src/physics/heightfield';
import {
  RESTORE_AFTER_INVALID,
  RESTORE_DEADLINE,
  RestorableRegistry,
  type RestorableObject,
  type Transform,
} from '../../../src/world/restorable';
import {
  BELOW_TERRAIN_LIMIT,
  OUT_OF_BOUNDS_RADIUS,
  enemyRecoveryPosition,
  outOfWorldReason,
} from '../../../src/world/worldBounds';

// World bounds for recovery (Req 20.5, 20.7) and the RestorableObject registry (Req 2.5), at 60 Hz.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const terrain = flatHeightfield(10);

describe('outOfWorldReason', () => {
  it('flags feet 2 m or more under the terrain and anything past 490 m from the origin', () => {
    expect([BELOW_TERRAIN_LIMIT, OUT_OF_BOUNDS_RADIUS]).toEqual([2, 490]);
    expect(outOfWorldReason(terrain, v(0, 10, 0))).toBeNull();
    expect(outOfWorldReason(terrain, v(0, 8.01, 0))).toBeNull();
    expect(outOfWorldReason(terrain, v(0, 8, 0))).toBe('belowTerrain');
    expect(outOfWorldReason(terrain, v(0, -300, 0))).toBe('belowTerrain');
    expect(outOfWorldReason(terrain, v(490, 10, 0))).toBeNull(); // on the limit
    expect(outOfWorldReason(terrain, v(300, 10, 400))).toBe('outOfBounds'); // r = 500
    expect(outOfWorldReason(terrain, v(0, 400, -490.5))).toBe('outOfBounds'); // at any height
    expect(outOfWorldReason(terrain, v(Number.NaN, 10, 0))).toBe('outOfBounds');
  });
});

describe('enemyRecoveryPosition (Req 20.7)', () => {
  it('sends an enemy below the terrain or outside the boundary back to a copy of its spawn', () => {
    const spawn = v(12, 10, -4);
    expect(enemyRecoveryPosition(terrain, v(30, 10.5, 2), spawn)).toBeNull();
    const back = enemyRecoveryPosition(terrain, v(30, 7, 2), spawn);
    expect(back).toEqual(spawn);
    expect(back).not.toBe(spawn);
    expect(enemyRecoveryPosition(terrain, v(495, 10, 0), spawn)).toEqual(spawn);
  });
});

/** A quest item that can be carried off, knocked out of the world or broken; restore() resets both. */
class QuestItem implements RestorableObject {
  readonly id: string;
  readonly home: Transform;
  pos: Vec3;
  yaw: number;
  state: 'initial' | 'carried' | 'broken' = 'initial';
  readonly restoredTo: Transform[] = [];

  constructor(id: string, home: Transform) {
    this.id = id;
    this.home = home;
    this.pos = { ...home.pos };
    this.yaw = home.yaw;
  }

  position(): Vec3 {
    return this.pos;
  }

  isValid(): boolean {
    return this.state !== 'broken';
  }

  restore(home: Readonly<Transform>): void {
    this.pos = { ...home.pos };
    this.yaw = home.yaw;
    this.state = 'initial';
    this.restoredTo.push({ pos: { ...home.pos }, yaw: home.yaw });
  }
}

const HOME: Transform = { pos: v(40, 10, -20), yaw: 0.5 };

/** Ticks `registry` for `ticks` ticks; returns the tick index of each restore of `id`. */
function run(registry: RestorableRegistry, ticks: number, id: string, each?: (tick: number) => void): number[] {
  const restores: number[] = [];
  for (let i = 0; i < ticks; i++) {
    each?.(i);
    if (registry.tick(DT).includes(id)) restores.push(i);
  }
  return restores;
}

describe('RestorableRegistry (Req 2.5)', () => {
  it('restores an object out of the world for 1 s to its home position and initial state, within 5 s', () => {
    for (const lost of [v(40, 5, -20), v(495, 10, 0)]) {
      const registry = new RestorableRegistry(terrain);
      const item = new QuestItem('qi_lantern', HOME);
      registry.register(item);
      item.pos = lost;
      item.yaw = 2;
      item.state = 'carried';
      const restores = run(registry, 400, item.id);
      expect(restores).toEqual([59]); // the 60th invalid tick: 1 s
      expect((restores[0] ?? Infinity) + 1).toBeLessThanOrEqual(RESTORE_DEADLINE / DT);
      expect([item.pos, item.yaw, item.state]).toEqual([HOME.pos, HOME.yaw, 'initial']);
      expect(item.restoredTo).toEqual([HOME]);
    }
  });

  it('uses the owner validity check too, and a valid tick resets the timer', () => {
    const registry = new RestorableRegistry(terrain);
    const item = new QuestItem('pz_part', HOME);
    registry.register(item);
    // Broken for 0.75 s, fixed for one tick, broken again: restored only 1 s after the second break.
    const restores = run(registry, 300, item.id, (i) => {
      if (i === 0 || i === 46) item.state = 'broken';
      if (i === 45) item.state = 'initial';
    });
    expect(RESTORE_AFTER_INVALID).toBe(1);
    expect(restores).toEqual([46 + 59]);
    expect(item.state).toBe('initial');
  });

  it('leaves valid objects alone, replaces an entry registered again and stops after unregister', () => {
    const registry = new RestorableRegistry(terrain);
    const item = new QuestItem('npc_anchor', HOME);
    registry.register(item);
    expect(run(registry, 120, item.id)).toEqual([]);

    const moved = new QuestItem('npc_anchor', { pos: v(0, 10, 0), yaw: 0 });
    registry.register(moved);
    expect(registry.size).toBe(1);
    moved.pos = v(0, -20, 0);
    expect(run(registry, 60, moved.id)).toEqual([59]);
    expect(moved.pos).toEqual(v(0, 10, 0)); // the new home
    expect(item.restoredTo).toEqual([]);

    expect(registry.unregister(moved.id)).toBe(true);
    expect(registry.has(moved.id)).toBe(false);
    moved.state = 'broken';
    expect(run(registry, 120, moved.id)).toEqual([]);
    expect(registry.unregister(moved.id)).toBe(false);
  });

  it('keeps its own copy of the home transform', () => {
    const registry = new RestorableRegistry(terrain);
    const home: Transform = { pos: v(5, 10, 5), yaw: 0 };
    const item = new QuestItem('qi_bell', home);
    registry.register(item);
    home.pos.x = 999; // the owner's object changes after registration
    item.state = 'broken';
    run(registry, 60, item.id);
    expect(item.pos).toEqual(v(5, 10, 5));
  });
});
