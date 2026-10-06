import { describe, expect, it } from 'vitest';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CHEST_TOTAL, PLACE_TOTAL } from '../../../src/data/pois';
import { THISTLEWICK_HEARTH } from '../../../src/data/worldLayout';
import { InputState } from '../../../src/input/inputState';
import { dialogueBucket } from '../../../src/logic/dialogue';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { sanitizeGameState } from '../../../src/logic/save/sanitize';
import { validateGameState } from '../../../src/logic/save/validate';
import { villageStage } from '../../../src/logic/village';
import { blightStrength, completeGame, victoryRecord } from '../../../src/logic/worldChange';
import { progressTimeOfDay } from '../../../src/data/timeOfDay';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain } from '../../../src/world/terrain';

// Task 21.3 (Req 4.4, 4.7, 7.5, 7.6, 8.10, 14.8): world changes derived from GameState, and the game completion.

const SEED = 20240601;
const terrain = buildTerrain(SEED);

describe('Blight strength', () => {
  it('each Skyshard purifies its Region; the crater and Sanctum clear with the ending', () => {
    const at = (skyshards: 0 | 1 | 2 | 3, gameCompleted = false) => ({ skyshards, gameCompleted });
    expect(['verdant', 'ember', 'azure', 'crater', 'sanctum'].map((r) => blightStrength(r as never, at(0)))).toEqual([1, 1, 1, 1, 1]);
    expect(blightStrength('verdant', at(1))).toBe(0);
    expect(blightStrength('ember', at(1))).toBe(1);
    expect(blightStrength('ember', at(2))).toBe(0);
    expect(blightStrength('azure', at(3))).toBe(0);
    expect(blightStrength('crater', at(3))).toBe(1);
    for (const r of ['verdant', 'ember', 'azure', 'crater', 'sanctum'] as const) expect(blightStrength(r, at(3, true))).toBe(0);
  });

  it('the other progress looks follow the same fields', () => {
    const gs = createNewGameState(SEED);
    gs.skyshards = 2;
    expect([villageStage(gs), dialogueBucket(gs), progressTimeOfDay(gs)]).toEqual([2, 2, 'afternoon']);
    gs.gameCompleted = true;
    expect([villageStage(gs), dialogueBucket(gs), progressTimeOfDay(gs)]).toEqual(['post', 'post', 'sunrise']);
  });
});

describe('game completion', () => {
  it('records the Victory statistics once and the record survives a save', () => {
    const gs = createNewGameState(SEED);
    gs.stats.enemiesDefeated = 42;
    gs.discovery.landmarks = ['lm_elderbough', 'lm_breezewatch'];
    gs.world.chests = ['chest_verdant_1'];
    gs.party.upgrades.kairen = { skill: 2, burst: 1 };
    gs.quests.main.done = true;
    expect(completeGame(gs, { playTimeSec: 1500.5, placesTotal: 40, chestsTotal: 20 })).toBe(true);
    expect(gs.gameCompleted).toBe(true);
    expect(gs.victory).toEqual({
      playTimeSec: 1500.5, enemiesDefeated: 42, places: [2, 40], quests: 1, chests: [1, 20], level: 1,
      upgrades: { kairen: 3, isla: 0, wren: 0, talus: 0 },
    });
    const first = gs.victory;
    expect(completeGame(gs, { playTimeSec: 9999, placesTotal: 40, chestsTotal: 20 })).toBe(false);
    expect(gs.victory).toBe(first);
    expect(validateGameState(sanitizeGameState(JSON.parse(JSON.stringify(gs))).state)).toEqual([]);
    expect(victoryRecord(gs, { playTimeSec: -1, placesTotal: 1, chestsTotal: 0 }).places).toEqual([1, 1]);
  });

  it('cin_ending completes the game before the Victory Screen, saves it, and "탐험 계속" goes to Thistlewick', () => {
    const gameState = createNewGameState(SEED);
    const commands = new UiCommandQueue();
    const seen: string[] = [];
    const sim = new PlaySim({
      gameState, terrain, input: new InputState(), commands, playTimeSec: () => 1234,
      sinks: {
        partyWipe: () => {},
        ending: () => seen.push(`ending completed=${gameState.gameCompleted} time=${gameState.victory?.playTimeSec}`),
      },
    });
    const saves: string[] = [];
    sim.bus.on('save:request', (p) => saves.push(p.reason));
    sim.bus.emit('cinematic:ended', { cinematicId: 'cin_ending', skipped: true });
    sim.bus.dispatch();
    sim.bus.dispatch();
    expect(seen).toEqual(['ending completed=true time=1234']);
    expect(saves).toContain('gameComplete');
    expect(gameState.victory?.places[1]).toBe(PLACE_TOTAL);
    expect(gameState.victory?.chests[1]).toBe(CHEST_TOTAL);
    commands.push({ kind: 'continueExploring' });
    const { teleported } = sim.tick(1 / 60, 0);
    expect(teleported).toBe(true);
    expect(Math.hypot(sim.player.state.pos.x - THISTLEWICK_HEARTH.x, sim.player.state.pos.z - THISTLEWICK_HEARTH.z)).toBeLessThan(1);
    sim.dispose();
  });
});
