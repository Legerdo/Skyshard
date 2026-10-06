import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { STARLIT_STAIR } from '../../../src/data/starlitStair';
import type { BarrierId } from '../../../src/data/ids';
import type { WorldProgress } from '../../../src/logic/gates';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { BARRIER_SHATTER_SECONDS, GateSystem } from '../../../src/world/gateSystem';
import { StarlitStair } from '../../../src/world/starlitStair';
import { VolumeIndex } from '../../../src/world/volumeIndex';

// GateSystem (task 4.5; Req 4.5, 4.6, 4.9, 5.5, 2.7) on a flat world, so only the barrier colliders are hit.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const at = (skyshards: number, altarActivated = false): WorldProgress => ({ skyshards, altarActivated });

/** Probe points inside each barrier's colliders (a player-sized capsule). */
const INSIDE: Readonly<Partial<Record<BarrierId, Vec3>>> = {
  gate_ember: v(60, 20, 300),
  gate_azure: v(40, 26, -125),
  veil_ember: v(60, 20, 200),
  veil_azure: v(-200, 20, -125),
  seal_sanctum: v(0, 190, 0),
};

function setup(progress: WorldProgress) {
  const world = createCollisionWorld(flatHeightfield(0));
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const ids = new ColliderIdSource();
  const volumes = new VolumeIndex();
  const stair = new StarlitStair({ world, volumes, ids });
  const gates = new GateSystem({ world, bus, ids, progress, stair });
  /** Whether a capsule inside the barrier touches one of its colliders. */
  const blocked = (id: BarrierId): boolean => {
    const own = new Set(gates.colliderIds(id));
    const p = INSIDE[id];
    if (p === undefined) throw new Error(`no probe for ${id}`);
    return world.overlapCapsule(p, 0.4, 1.75).some((c) => c.colliderId !== null && own.has(c.colliderId));
  };
  const run = (seconds: number, p: WorldProgress): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      gates.tick(DT, p);
      bus.dispatch();
    }
  };
  return { world, bus, events, volumes, stair, gates, blocked, run };
}

describe('GateSystem', () => {
  it('starts a New Game with every barrier closed and solid', () => {
    const { gates, blocked, stair } = setup(at(0));
    for (const id of ['gate_ember', 'gate_azure', 'veil_ember', 'veil_azure', 'seal_sanctum'] as const) {
      expect(gates.phase(id)).toBe('closed');
      expect(blocked(id)).toBe(true);
    }
    expect(stair.active).toBe(false);
  });

  it('removes barriers already open on load at once, without barrier:opened or VFX', () => {
    const { gates, bus, events, blocked, stair, volumes } = setup(at(3, true));
    bus.dispatch();
    expect(events).toEqual([]);
    for (const view of gates.views()) expect(view).toMatchObject({ phase: 'open', progress: 1 });
    expect(blocked('gate_ember')).toBe(false);
    expect(blocked('veil_azure')).toBe(false);
    expect(blocked('seal_sanctum')).toBe(false);
    expect(stair.active).toBe(true);
    expect(volumes.has('updraft', STARLIT_STAIR.updrafts[0].id)).toBe(true);
  });

  it('opens gate_ember and veil_ember on Skyshard 1: barrier:opened first, colliders only after the shatter', () => {
    const { gates, events, blocked, run } = setup(at(0));
    run(DT, at(1));
    const opened = events.filter((e) => e.type === 'barrier:opened').map((e) => e.payload as GameEvents['barrier:opened']);
    expect(opened).toEqual([
      { barrierId: 'gate_ember', regionId: 'ember' },
      { barrierId: 'veil_ember', regionId: 'ember' },
    ]);
    expect(gates.phase('gate_ember')).toBe('shattering');
    expect(blocked('gate_ember')).toBe(true); // still solid while the VFX plays
    expect(gates.phase('gate_azure')).toBe('closed');

    run(BARRIER_SHATTER_SECONDS.gate - 2 * DT, at(1));
    expect(blocked('gate_ember')).toBe(true);
    run(2 * DT, at(1));
    expect(gates.phase('gate_ember')).toBe('open');
    expect(blocked('gate_ember')).toBe(false);
    expect(blocked('veil_ember')).toBe(true); // the veil dissolves for longer
    run(BARRIER_SHATTER_SECONDS.veil - BARRIER_SHATTER_SECONDS.gate, at(1));
    expect(blocked('veil_ember')).toBe(false);
    expect(blocked('gate_azure')).toBe(true);
    expect(events.filter((e) => e.type === 'barrier:opened')).toHaveLength(2); // once each
  });

  it('lifts the seal after the altar is activated and raises the Starlit_Stair when the seal is gone', () => {
    const { gates, events, blocked, stair, run } = setup(at(3));
    expect(blocked('seal_sanctum')).toBe(true);
    run(1, at(3));
    expect(events).toEqual([]); // three Skyshards alone do not lift the seal
    run(DT, at(3, true));
    expect(events.map((e) => e.type)).toEqual(['barrier:opened']);
    expect(stair.active).toBe(false);
    run(BARRIER_SHATTER_SECONDS.seal, at(3, true));
    expect(gates.phase('seal_sanctum')).toBe('open');
    expect(blocked('seal_sanctum')).toBe(false);
    expect(stair.active).toBe(true);
  });

  it('re-derives from GameState: going back to fewer Skyshards restores the barriers at once', () => {
    const { gates, blocked, stair } = setup(at(3, true));
    gates.refresh(at(1), { animate: false });
    expect(gates.phase('gate_ember')).toBe('open');
    expect(gates.phase('gate_azure')).toBe('closed');
    expect(blocked('gate_azure')).toBe(true);
    expect(blocked('veil_azure')).toBe(true);
    expect(blocked('seal_sanctum')).toBe(true);
    expect(stair.active).toBe(false);
  });

  it('offers a closed gate with "Skyshard n/필요 수" along the wall and stops once it opens', () => {
    const { gates, run } = setup(at(0));
    let progress = at(0);
    const targets = gates.gateTargets(() => progress);
    const ember = targets.find((t) => t.id === 'gate_ember');
    expect(ember?.kind).toBe('barrier');
    expect(ember?.detail()).toBe('Skyshard 0/1');
    expect(targets.find((t) => t.id === 'gate_azure')?.detail()).toBe('Skyshard 0/2');
    expect(ember?.available()).toBe(true);
    progress = at(1);
    run(DT, progress);
    expect(ember?.available()).toBe(false);
  });
});
