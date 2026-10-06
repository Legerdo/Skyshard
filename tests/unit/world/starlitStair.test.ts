import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import { STARLIT_STAIR } from '../../../src/data/starlitStair';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { RecoverySystem, type RecoveryTeleport } from '../../../src/player/recovery';
import { StarlitStair } from '../../../src/world/starlitStair';
import { VolumeIndex } from '../../../src/world/volumeIndex';

// Starlit_Stair platforms, Updrafts and the fall return (task 4.5; Req 5.5, 5.6), on flat ground at y 0.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const L2 = 5; // tier 2 landing, top y 90
const l2 = STARLIT_STAIR.platforms[L2];

function setup() {
  const world = createCollisionWorld({ ...flatHeightfield(0), waterDepthAt: () => 0 });
  const volumes = new VolumeIndex();
  const stair = new StarlitStair({ world, volumes, ids: new ColliderIdSource() });
  return { world, volumes, stair };
}

describe('StarlitStair', () => {
  it('builds walkable platform colliders and the starlit Updrafts only while active', () => {
    const { world, volumes, stair } = setup();
    const onTop = v(l2.x, l2.topY, l2.z);
    expect(world.groundProbe(onTop, 0.3)?.colliderId ?? null).toBeNull(); // nothing to stand on yet
    expect(volumes.at(v(20, 50, -42), 'updraft')).toEqual([]);

    stair.setActive(true);
    const ground = world.groundProbe(onTop, 0.3);
    expect(ground?.walkable).toBe(true);
    expect(ground?.dynamic).toBe(true); // never a Safe_Position
    expect(stair.platformOf(ground?.colliderId ?? null)).toBe(L2);
    expect(volumes.at(v(20, 50, -42), 'updraft').map((u) => u.id)).toEqual(['updraft_starlit_1']);

    stair.setActive(false);
    expect(world.groundProbe(onTop, 0.3)?.colliderId ?? null).toBeNull();
    expect(volumes.size).toBe(0);
  });

  it('returns a fall of 10 m below the last platform to its top, facing the next platform', () => {
    const { stair } = setup();
    stair.setActive(true);
    expect(stair.track({ pos: v(l2.x, l2.topY, l2.z), grounded: true })).toBeNull();
    expect(stair.lastPlatform).toBe(L2);
    expect(stair.track({ pos: v(l2.x, l2.topY + 4, l2.z), grounded: false })).toBeNull(); // jumping
    expect(stair.track({ pos: v(l2.x, l2.topY - 9.9, l2.z), grounded: false })).toBeNull();
    const spot = stair.track({ pos: v(l2.x, l2.topY - 10, l2.z), grounded: false });
    expect(spot?.pos).toEqual(v(l2.x, l2.topY, l2.z));
    expect(spot?.yaw).toBeCloseTo(-Math.PI / 2, 10); // the next step lies to the west (−x)
  });

  it('forgets the stair on other ground, so walking off the lowest steps only lands', () => {
    const { stair } = setup();
    stair.setActive(true);
    const p0 = STARLIT_STAIR.platforms[0];
    stair.track({ pos: v(p0.x, p0.topY, p0.z), grounded: true });
    stair.track({ pos: v(0, 0, 0), grounded: true }); // on the crater floor
    expect(stair.lastPlatform).toBeNull();
    expect(stair.track({ pos: v(0, -20, 0), grounded: false })).toBeNull();
  });

  it('does nothing while inactive', () => {
    const { stair } = setup();
    expect(stair.track({ pos: v(l2.x, l2.topY, l2.z), grounded: true })).toBeNull();
    expect(stair.lastPlatform).toBeNull();
  });

  it('puts the character back on the platform through the recovery fade within 1 s', () => {
    const { world, stair } = setup();
    stair.setActive(true);
    const recovery = new RecoverySystem({ world, fallback: () => ({ pos: v(0, 0, 0), yaw: 0 }) });
    stair.track({ pos: v(l2.x, l2.topY, l2.z), grounded: true });
    const spot = stair.track({ pos: v(l2.x, 70, l2.z), grounded: false });
    expect(spot).not.toBeNull();
    if (spot === null) return;
    expect(recovery.restorePlayer('stairFall', spot)).toBe(true);
    const body = { pos: v(l2.x, 70, l2.z), yaw: 0, mode: 'fall' as const, grounded: false, wading: false };
    let teleport: RecoveryTeleport | null = null;
    let ticks = 0;
    do {
      const result = recovery.tick({ body, dt: DT });
      teleport ??= result.teleport;
      ticks++;
    } while (recovery.active && ticks < 120);
    expect(teleport).toMatchObject({ reason: 'stairFall', source: 'target', pos: v(l2.x, l2.topY, l2.z) });
    expect(ticks * DT).toBeLessThanOrEqual(1);
  });
});
