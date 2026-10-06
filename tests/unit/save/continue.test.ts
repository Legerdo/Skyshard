import { describe, expect, it } from 'vitest';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { MAIN_QUEST, QUESTS } from '../../../src/data/quests';
import { InputState } from '../../../src/input/inputState';
import { questReducer } from '../../../src/logic/quest/questReducer';
import type { ObjectiveTrigger, QuestEvent } from '../../../src/logic/quest/types';
import { serializeSave } from '../../../src/logic/save/envelope';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { MemoryStore } from '../../../src/logic/save/keyValueStore';
import { loadSave } from '../../../src/logic/save/load';
import { skyshardsForQuest } from '../../../src/logic/save/sanitize';
import { SAVE_KEYS } from '../../../src/logic/save/saveKeys';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain } from '../../../src/world/terrain';

// Continue (task 15.6, Req 36.8, 2.7): at the start of every Main_Quest stage the game is saved and loaded into a new
// session, whose world follows GameState and whose next Objective still completes.

const SEED = 20240601;
const terrain = buildTerrain(SEED);

function eventFor(t: ObjectiveTrigger): QuestEvent {
  switch (t.kind) {
    case 'talk': return { kind: 'talk', id: t.npc };
    case 'reach': return { kind: 'reach', id: t.areaId };
    case 'defeat': return { kind: 'defeat', id: t.groupId };
    case 'interact': return { kind: 'interact', id: t.targetId };
    case 'solve': return { kind: 'solve', id: t.puzzleId };
    case 'skyshard': return { kind: 'skyshard', id: String(t.index) };
    case 'cinematic': return { kind: 'cinematic', id: t.cinematicId };
    case 'collect': return { kind: 'collect', id: t.itemId, count: t.count };
    case 'flag': return { kind: 'flag', id: t.flag };
  }
}

/** A New Game advanced through every Objective before stage `k` (party joins and the altar follow the story). */
function stateAtStage(k: number): GameState {
  const gs = createNewGameState(SEED);
  for (let s = 0; s < k; s++) {
    for (const o of MAIN_QUEST.stages[s].objectives) {
      gs.quests = questReducer(gs.quests, QUESTS, eventFor(o.trigger)).state;
      if (o.trigger.kind === 'talk' && ['isla', 'wren', 'talus'].includes(o.trigger.npc)) {
        const c = o.trigger.npc as 'isla' | 'wren' | 'talus';
        if (!gs.party.joined.includes(c)) gs.party.joined.push(c);
      }
      if (o.trigger.kind === 'interact' && o.trigger.targetId.includes('altar')) gs.altarActivated = true;
    }
  }
  gs.skyshards = skyshardsForQuest(gs.quests.main);
  return gs;
}

function loadInto(gs: GameState): { sim: PlaySim; loaded: GameState } {
  const store = new MemoryStore();
  store.setItem(SAVE_KEYS.main, serializeSave(gs, 60));
  const result = loadSave(store);
  if (result.kind !== 'ok') throw new Error(`load failed: ${result.kind}`);
  expect(result.repairs).toEqual([]);
  const sim = new PlaySim({
    gameState: result.state, terrain, input: new InputState(), commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {} },
  });
  return { sim, loaded: result.state };
}

describe('Continue', () => {
  it.each(MAIN_QUEST.stages.map((s, i) => [s.id, i] as const))('saved at the start of %s: loads, rebuilds the world and the next Objective completes', (_id, k) => {
    const saved = stateAtStage(k);
    const { sim, loaded } = loadInto(saved);
    sim.resume();
    const first = MAIN_QUEST.stages[k].objectives[0];
    expect(sim.quests.objectiveView('main')?.objective.id).toBe(first.id);
    expect(loaded.skyshards).toBe(saved.skyshards);
    expect(loaded.party.joined).toEqual([...saved.party.joined].sort());
    // Barriers follow the Skyshard count, the Starlit_Stair the altar flag (Req 2.7).
    sim.tick(1 / 60, 0);
    const open = sim.gates.views().filter((b) => b.phase === 'open').map((b) => b.id);
    if (saved.skyshards >= 1) expect(open).toEqual(expect.arrayContaining(['gate_ember']));
    else expect(open).not.toContain('gate_ember');
    expect(sim.stair.active).toBe(saved.altarActivated);
    // The next Objective is still achievable.
    sim.quests.handle(eventFor(first.trigger));
    const after = loaded.quests.main;
    expect(after.stage * 100 + after.objective).toBeGreaterThan(k * 100);
    sim.dispose();
  });

  it('the recorded Safe_Position is the Challenge_Area checkpoint while inside one, else the newest Safe_Position', () => {
    const { sim, loaded } = loadInto(stateAtStage(2));
    sim.resume();
    sim.recovery.setCheckpointOverride('hollowroot', { x: 10, y: -5, z: 20 }, 1.25);
    sim.recordSafePosition();
    expect(loaded.lastSafe).toEqual({ pos: [10, -5, 20], yaw: 1.25 });
    sim.recovery.setCheckpointOverride(null);
    sim.recordSafePosition();
    expect(loaded.lastSafe).not.toEqual({ pos: [10, -5, 20], yaw: 1.25 });
    sim.dispose();
  });

  it('a loaded session starts at the saved Safe_Position', () => {
    const gs = stateAtStage(1);
    gs.lastSafe = { pos: [-150, 30, 260], yaw: 0.3 };
    const { sim } = loadInto(gs);
    expect(sim.player.state.pos).toMatchObject({ x: -150, z: 260 });
    sim.dispose();
  });
});
