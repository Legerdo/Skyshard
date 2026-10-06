import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { MAIN_QUEST, QUESTS } from '../../../src/data/quests';
import { RESONANCE_ALTAR } from '../../../src/data/starlitStair';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { InteractionSystem } from '../../../src/player/interaction';
import { QuestSystem } from '../../../src/quest/questSystem';
import { BARRIER_SHATTER_SECONDS, GateSystem } from '../../../src/world/gateSystem';
import { ResonanceAltar } from '../../../src/world/resonanceAltar';
import { RouteStubs } from '../../../src/world/routeStubs';
import { StarlitStair } from '../../../src/world/starlitStair';
import { VolumeIndex } from '../../../src/world/volumeIndex';

// Route stubs, Skyshard pedestals and the altar activation of the minimal route (task 4.9; Req 4.1, 4.3, 4.5,
// 5.2, 5.4, 5.5), on flat ground so only the stubs, barriers and the stair matter.
const DT = 1 / 60;

/** Puts the Main_Quest at Objective `id` (as if every earlier one were done). */
function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

function setup(objectiveId: string, skyshards: GameState['skyshards'] = 0) {
  const gs = createNewGameState(1);
  gs.skyshards = skyshards;
  at(gs, objectiveId);
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const quests = new QuestSystem({
    bus, state: gs, defs: QUESTS,
    sinks: {
      joinParty: (c) => {
        gs.party.joined.push(c);
        bus.emit('party:joined', { characterId: c });
      },
    },
  });
  const world = createCollisionWorld(flatHeightfield(0));
  const ids = new ColliderIdSource();
  const volumes = new VolumeIndex();
  const stair = new StarlitStair({ world, volumes, ids });
  const gates = new GateSystem({ world, bus, ids, progress: gs, stair });
  const altar = new ResonanceAltar({ world, ids, progress: () => gs, activation: { bus, state: gs } });
  const stubs = new RouteStubs({
    bus, state: gs, world, ids, heightAt: () => 0,
    quests: { objectiveView: () => quests.objectiveView('main') },
  });
  const interaction = new InteractionSystem(bus);
  for (const t of [...stubs.interactTargets(), altar.interactTarget()]) interaction.add(t);
  /** Stands at `feet` (ground height of the stub) and presses interact once. */
  const press = (feet: Vec3): void => {
    interaction.tick(feet, true);
    bus.dispatch();
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      gates.tick(DT, gs);
      bus.dispatch();
    }
  };
  const near = (p: Vec3): Vec3 => ({ x: p.x + 1.2, y: p.y, z: p.z });
  const current = (): string | undefined => quests.objectiveView('main')?.objective.id;
  return { gs, bus, events, quests, stubs, interaction, gates, stair, press, run, near, current };
}

const types = (events: { type: GameEventName }[]): GameEventName[] => events.map((e) => e.type);

describe('Skyshard pedestals', () => {
  it('Skyshard 1: raises GameState.skyshards, publishes skyshard:acquired and opens gate_ember and its veil', () => {
    const { gs, events, stubs, press, run, near, gates, current } = setup('ms3_skyshard');
    const pedestal = stubs.pedestals[0];
    expect(pedestal.def.index).toBe(1);
    press(near(pedestal.pos));
    expect(gs.skyshards).toBe(1);
    const acquired = events.filter((e) => e.type === 'skyshard:acquired').map((e) => e.payload as GameEvents['skyshard:acquired']);
    expect(acquired).toEqual([{ index: 1, regionId: 'verdant' }]);
    expect(types(events)).toContain('save:request');
    expect(current()).toBe('ms4_ashgate'); // the quest took the 'skyshard 1' trigger
    expect(stubs.pedestalFull(pedestal.def)).toBe(false);

    run(DT); // GateSystem.tick sees the new count
    expect(events.filter((e) => e.type === 'barrier:opened').map((e) => (e.payload as GameEvents['barrier:opened']).barrierId))
      .toEqual(['gate_ember', 'veil_ember']);
    run(BARRIER_SHATTER_SECONDS.veil);
    expect([gates.phase('gate_ember'), gates.phase('veil_ember'), gates.phase('gate_azure')]).toEqual(['open', 'open', 'closed']);
  });

  it('is offered only for the next Skyshard while its Objective is current, and only once', () => {
    const early = setup('ms3_warden'); // guardian not down yet
    early.press(early.near(early.stubs.pedestals[0].pos));
    expect(early.gs.skyshards).toBe(0);

    const later = setup('ms5_skyshard', 1);
    later.press(later.near(later.stubs.pedestals[0].pos)); // Skyshard 1 again: already held
    expect(later.gs.skyshards).toBe(1);
    later.press(later.near(later.stubs.pedestals[1].pos));
    expect(later.gs.skyshards).toBe(2);
    later.press(later.near(later.stubs.pedestals[1].pos));
    expect(later.events.filter((e) => e.type === 'skyshard:acquired')).toHaveLength(1);
    later.run(DT);
    expect(later.events.filter((e) => e.type === 'barrier:opened').map((e) => (e.payload as GameEvents['barrier:opened']).barrierId))
      .toEqual(['gate_azure', 'veil_azure']);
  });
});

describe('Resonance_Altar activation', () => {
  it('with three Skyshards: altar:activated, the altar flag and the save, then the seal lifts and the Starlit_Stair appears', () => {
    const { gs, events, press, run, stair, current } = setup('ms8_altar', 3);
    const plinthSide: Vec3 = { x: RESONANCE_ALTAR.pos.x + 2, y: RESONANCE_ALTAR.pos.y, z: RESONANCE_ALTAR.pos.z };
    press(plinthSide);
    expect(gs.altarActivated).toBe(true);
    expect(types(events).filter((t) => t === 'altar:activated' || t === 'save:request')).toEqual(['altar:activated', 'save:request', 'save:request']);
    expect(events.find((e) => e.type === 'save:request')?.payload).toEqual({ reason: 'altar' });
    expect(current()).toBe('ms8_stair'); // 'interact resonance_altar' came from altar:activated
    run(DT);
    expect(stair.active).toBe(false);
    run(BARRIER_SHATTER_SECONDS.seal);
    expect(stair.active).toBe(true);
    press(plinthSide); // no longer offered
    expect(events.filter((e) => e.type === 'altar:activated')).toHaveLength(1);
  });

  it('with fewer Skyshards the altar only shows its count', () => {
    const { gs, events, press } = setup('ms7_skyshard', 2);
    press({ x: RESONANCE_ALTAR.pos.x + 2, y: RESONANCE_ALTAR.pos.y, z: RESONANCE_ALTAR.pos.z });
    expect(gs.altarActivated).toBe(false);
    expect(types(events)).not.toContain('altar:activated');
  });
});

describe('what is left of the route stubs', () => {
  it('offers only the Skyshard pedestals: the puzzles are real Puzzle_Mechanisms (tasks 9.6–9.8), the NPC talks the Dialogue_System (13.1)', () => {
    const { stubs } = setup('ms7_constellation', 2);
    expect(stubs.interactTargets().map((t) => t.kind)).toEqual(['skyshard', 'skyshard', 'skyshard']);
  });
});
