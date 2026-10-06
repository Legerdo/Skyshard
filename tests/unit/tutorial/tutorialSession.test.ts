import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CHARACTERS } from '../../../src/data/characters';
import { TUTORIAL_ANCHORS } from '../../../src/data/tutorials';
import { cinematicDef } from '../../../src/data/cinematics';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Tutorial_System inside the headless play session (task 13.4 wiring): ticked by PlaySim, reading this tick's
// InputState, the world's positions and the built-in signal judges, and recording GameState.tutorials.

const SEED = 20240601;
const DT = 1 / 60;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

function setup(done: string[] = []) {
  const gameState = createNewGameState(SEED);
  gameState.tutorials.push(...done);
  const input = new InputState();
  const sim = new PlaySim({ gameState, terrain, input, commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {} } });
  const events: { type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ type, payload }));
  const step = (raw: RawInput[] = []): void => {
    input.beginTick(raw, DT);
    sim.tick(DT, 0);
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) step();
  };
  const shown = (): string[] =>
    events.filter((e) => e.type === 'hint:shown').map((e) => (e.payload as { hintId: string }).hintId);
  return { sim, gameState, input, step, run, shown, events };
}

describe('Tutorial_System in the play session', () => {
  it('opens a New Game with the move hint and records it when the character moves', () => {
    const { sim, gameState, step, run, shown } = setup();
    sim.begin();
    step();
    step();
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_move');
    expect(shown()).toEqual(['tut_move']);
    step([{ kind: 'down', code: 'KeyW', time: 0 }]);
    expect(gameState.tutorials).toEqual(['tut_move']);
    run(0.5);
    step([{ kind: 'up', code: 'KeyW', time: 0 }]);
    // The camera hint comes 3 s in, then closes by itself after 8 s without camera input.
    run(3);
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_camera');
    run(8.1);
    expect(gameState.tutorials).toEqual(['tut_move', 'tut_camera']);
  });

  it("shows the jump hint at the plaza step and the interact hint at Elder Maren, closed by F in the talk's tick", () => {
    const { sim, gameState, step, run, events } = setup(['tut_move', 'tut_camera']);
    sim.begin();
    const stepAt = TUTORIAL_ANCHORS.plaza_step;
    sim.player.teleport({ x: stepAt.x, y: terrain.heightAt(stepAt.x, stepAt.z), z: stepAt.z }, 0);
    run(0.2);
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_jump');
    step([{ kind: 'down', code: 'Space', time: 0 }, { kind: 'up', code: 'Space', time: 0 }]);
    expect(gameState.tutorials).toContain('tut_jump');
    const maren = sim.npcs.position('maren');
    if (maren === null) throw new Error('no maren');
    sim.player.teleport({ x: maren.x + 1.2, y: maren.y, z: maren.z }, 0);
    run(1);
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_interact');
    step([{ kind: 'down', code: 'KeyF', time: 0 }, { kind: 'up', code: 'KeyF', time: 0 }]);
    expect(gameState.tutorials).toContain('tut_interact');
    expect(events.some((e) => e.type === 'dialogue:ended' || e.type === 'interact')).toBe(true);
  });

  it('judges the signal hints from the session: full Energy queues the Burst hint', () => {
    const { sim, gameState, run, shown, events } = setup(['tut_move', 'tut_camera']);
    sim.begin();
    run(0.2);
    expect(sim.tutorial.visibleHint()).toBeNull();
    sim.runtime.energy.kairen = CHARACTERS.kairen.burst.energyCost;
    run(0.2);
    expect(events.filter((e) => e.type === 'tutorial:trigger').map((e) => (e.payload as { hintId: string }).hintId)).toContain('tut_burst');
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_burst');
    expect(shown()).toEqual(['tut_burst']);
    expect(gameState.tutorials).not.toContain('tut_burst');
  });

  it('hides the hint while a cinematic plays', () => {
    const { sim, run } = setup();
    sim.begin();
    run(0.1);
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_move');
    sim.cinematics.play('cin_skyshard_1');
    run(0.5);
    expect(sim.tutorial.visibleHint()).toBeNull();
    expect(sim.tutorial.current).toBe('tut_move');
    run(cinematicDef('cin_skyshard_1')?.duration ?? 0); // task 21.2: the full 6 s acquisition cinematic
    expect(sim.cinematics.playing).toBeNull();
    expect(sim.tutorial.visibleHint()?.id).toBe('tut_move');
  });
});
