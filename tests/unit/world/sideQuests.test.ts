import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEventName, GameEvents } from '../../../src/core/gameEvents';
import { UiCommandQueue, type UiCommand } from '../../../src/core/uiCommands';
import { dialogueDefsFor, SIDE_QUEST_DIALOGUES, SIDE_QUEST_FLAGS, type Speaker } from '../../../src/data/dialogue';
import type { ElementId } from '../../../src/data/ids';
import { XP_SOURCES } from '../../../src/data/progression';
import { MAIN_QUEST, QUESTS, SQ_DURGA, SQ_HOBB, SQ_TAMSIN } from '../../../src/data/quests';
import { DURGA_BRAZIERS, DURGA_BRAZIERS_PUZZLE, HOBB_NEST_CAMP, KITE_POS, KITE_TARGET_ID, tamsinReturnGlide } from '../../../src/data/sideQuests';
import { InputState } from '../../../src/input/inputState';
import type { ObjectiveView } from '../../../src/quest/questSystem';
import type { QuestDef } from '../../../src/logic/quest/types';
import { serializeSave } from '../../../src/logic/save/envelope';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { readSaveDocument } from '../../../src/logic/save/load';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// The three Side_Quests in the play session (task 13.3; Req 15.1–15.5): accepted through their givers' dialogues,
// their Objectives from the world's events, the unique rewards and world-change flags, the acceptance re-send of
// progress made before, the tracked Objective, and dropping one Side_Quest.

const SEED = 20240601;
const DT = 1 / 60;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

function session(options: { defs?: readonly QuestDef[]; prep?: (gs: GameState) => void; state?: GameState } = {}) {
  const defs = options.defs ?? QUESTS;
  const gs = options.state ?? createNewGameState(SEED, { quests: defs });
  options.prep?.(gs);
  const input = new InputState();
  const commands = new UiCommandQueue();
  const objectives: (ObjectiveView | null)[] = [];
  const sim = new PlaySim({
    gameState: gs, terrain, input, commands, questDefs: defs,
    sinks: { partyWipe: () => {}, ending: () => {}, objective: (v) => objectives.push(v) },
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ type, payload }));
  const step = (): void => {
    input.beginTick([], DT);
    sim.tick(DT, 0);
  };
  const send = (command: UiCommand): void => {
    commands.push(command);
    step();
  };
  /** A talk read to its end: interact on `npc`, every window advanced, then the EventDispatch of its end. */
  const talk = (npc: Speaker): string | null => {
    sim.bus.emit('interact', { targetKind: 'npc', targetId: npc });
    step();
    const id = sim.dialogue.playing;
    for (let i = 0; sim.dialogue.open; i++) {
      if (i > 40) throw new Error(`${npc}: dialogue does not end`);
      sim.dialogue.advanceNow();
    }
    step();
    return id;
  };
  const of = <K extends GameEventName>(type: K): GameEvents[K][] => events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const side = (id: 'sq_tamsin' | 'sq_hobb' | 'sq_durga') => gs.quests.side[id];
  const objective = (id: 'sq_tamsin' | 'sq_hobb' | 'sq_durga' | 'main') => sim.quests.objectiveView(id)?.objective.id ?? null;
  return { gs, sim, input, commands, step, send, talk, of, side, objective, objectives, events };
}

/** An Ember hit on a placed device part, through its hit receiver. */
function ignite(sim: PlaySim, partId: string, element: ElementId = 'ember'): void {
  for (const r of sim.devices.hitTargets()) {
    if (r.id !== partId) continue;
    r.receive({
      attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 50, crit: false, element,
      stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
  }
}

describe('Side_Quest data (Req 15.1–15.3)', () => {
  it('three one-stage Side_Quests on existing places: their Objectives, the unique rewards and the world-change flags', () => {
    expect([SQ_TAMSIN, SQ_HOBB, SQ_DURGA].map((q) => [q.id, q.kind, q.stages.length])).toEqual([
      ['sq_tamsin', 'side', 1], ['sq_hobb', 'side', 1], ['sq_durga', 'side', 1],
    ]);
    const triggers = (q: QuestDef) => q.stages.flatMap((s) => s.objectives.map((o) => o.trigger));
    expect(triggers(SQ_TAMSIN)).toEqual([{ kind: 'interact', targetId: KITE_TARGET_ID }, { kind: 'talk', npc: 'tamsin' }]);
    expect(triggers(SQ_HOBB)).toEqual([{ kind: 'defeat', groupId: 'camp_verdant_1' }, { kind: 'talk', npc: 'hobb' }]);
    expect(triggers(SQ_DURGA)).toEqual([{ kind: 'solve', puzzleId: DURGA_BRAZIERS_PUZZLE }, { kind: 'talk', npc: 'durga' }]);
    const rewards = (q: QuestDef) => q.stages.at(-1)?.onComplete.flatMap((e) => (e.kind === 'grant' ? e.reward.items ?? [] : [])).map((i) => `${i.id}×${i.count}`);
    expect(rewards(SQ_TAMSIN)).toEqual(['chm_dewdrop×1']);
    expect(rewards(SQ_HOBB)).toEqual(['rlc_wanderers_compass×1']);
    expect(rewards(SQ_DURGA)).toEqual(['mat_starmote×5', 'chm_stone_heart×1']);
    for (const q of [SQ_TAMSIN, SQ_HOBB, SQ_DURGA]) {
      const done = q.stages.at(-1)?.onComplete ?? [];
      expect(done.some((e) => e.kind === 'grant' && e.reward.xp === XP_SOURCES.sideQuest), q.id).toBe(true);
      expect(done.filter((e) => e.kind === 'setFlag').map((e) => (e.kind === 'setFlag' ? e.flag : '')), q.id).toEqual([SIDE_QUEST_FLAGS[q.id as 'sq_hobb']]);
      for (const o of q.stages.flatMap((s) => s.objectives)) expect(o.marker.kind, o.id).toBe('exact');
    }
  });
});

describe('sq_tamsin 잃어버린 풍경: the kite on the windmill (Req 15.1–15.4)', () => {
  it('is accepted from Tamsin, the kite is taken only while it is active, and the hand-in grants the Charm, XP and the kite in the sky', () => {
    const s = session();
    const kite = s.sim.sideQuests.interactTargets()[0];
    expect(kite?.kind).toBe('questItem');
    expect(kite?.id).toBe(KITE_TARGET_ID);
    expect(kite?.a).toEqual(KITE_POS);
    expect(kite?.available()).toBe(false); // not accepted yet: nothing to take
    expect(s.sim.sideQuests.kiteState()).toBe('hanging');
    // An interact on the kite before acceptance changes nothing.
    s.sim.bus.emit('interact', { targetKind: 'questItem', targetId: KITE_TARGET_ID });
    s.step();
    expect(s.side('sq_tamsin').status).toBe('available');

    expect(s.talk('tamsin')).toBe('dlg_tamsin_sq_tamsin_offer');
    expect(s.side('sq_tamsin')).toEqual({ status: 'active', stage: 0, objective: 0 });
    expect(s.objective('sq_tamsin')).toBe('sq_tamsin_kite');
    expect(kite?.available()).toBe(true);
    expect(s.talk('tamsin')).toBe('dlg_tamsin_sq_tamsin_kite'); // the reminder, no progress
    expect(s.objective('sq_tamsin')).toBe('sq_tamsin_kite');

    s.sim.bus.emit('interact', { targetKind: 'questItem', targetId: KITE_TARGET_ID });
    s.step();
    expect(s.objective('sq_tamsin')).toBe('sq_tamsin_return');
    expect(kite?.available()).toBe(false);
    expect(s.sim.sideQuests.kiteState()).toBe('carried');

    const xp = s.gs.party.xp;
    expect(s.talk('tamsin')).toBe('dlg_tamsin_sq_tamsin_return');
    expect(s.side('sq_tamsin').status).toBe('done');
    expect(s.sim.inventory.count('chm_dewdrop')).toBe(1);
    expect(s.gs.party.xp).toBe(xp + XP_SOURCES.sideQuest);
    expect(s.gs.world.flags[SIDE_QUEST_FLAGS.sq_tamsin]).toBe(true);
    expect(s.sim.village.look().kite).toBe(true);
    expect(s.sim.sideQuests.kiteState()).toBe('flying');
    expect(s.of('quest:stageCompleted')).toContainEqual({ questId: 'sq_tamsin', stageId: 'sq_tamsin_1', questDone: true });
    expect(s.of('save:request')).toContainEqual({ reason: 'sideQuest' });
    // Tamsin's one-shot reaction, then her bucket talk.
    expect(s.talk('tamsin')).toBe('dlg_tamsin_react_village_kite');
    expect(s.talk('tamsin')).toBe('dlg_tamsin_b0');
  });

  it('the glide home: 130 m at glide ratio 3.6 needs 36 m of the 46 m drop and 14.4 s of the 16.7 s base Stamina', () => {
    const g = tamsinReturnGlide();
    expect(g.horizontal).toBeCloseTo(130, 6);
    expect(g.dropNeeded).toBeCloseTo(36.1, 1);
    expect(g.dropAvailable).toBe(46);
    expect(g.dropNeeded).toBeLessThanOrEqual(g.dropAvailable);
    expect(g.seconds).toBeCloseTo(14.4, 1);
    expect(g.staminaSeconds).toBeCloseTo(16.7, 1);
    expect(g.seconds).toBeLessThanOrEqual(g.staminaSeconds);
    expect(KITE_POS.y).toBe(64);
  });
});

describe('sq_hobb 들판 가시 소탕: the thorn nest camp_verdant_1', () => {
  it('clearing the camp then reporting to Hobb grants the Relic and the flowers in the field', () => {
    const s = session();
    expect(s.talk('hobb')).toBe('dlg_hobb_sq_hobb_offer');
    expect(s.objective('sq_hobb')).toBe('sq_hobb_nest');
    s.sim.bus.emit('camp:cleared', { campId: HOBB_NEST_CAMP, regionId: 'verdant' });
    s.step();
    expect(s.objective('sq_hobb')).toBe('sq_hobb_report');
    expect(s.talk('hobb')).toBe('dlg_hobb_sq_hobb_report');
    expect(s.side('sq_hobb').status).toBe('done');
    expect(s.sim.inventory.count('rlc_wanderers_compass')).toBe(1);
    expect(s.sim.village.look().fieldFlowers).toBe(true);
  });

  it('a camp cleared before acceptance is re-sent right after the offer: the report is next, the offer talk is not the hand-in', () => {
    const s = session({ prep: (gs) => gs.world.camps.push(HOBB_NEST_CAMP) });
    expect(s.talk('hobb')).toBe('dlg_hobb_sq_hobb_offer');
    expect(s.side('sq_hobb')).toEqual({ status: 'active', stage: 0, objective: 1 });
    expect(s.objective('sq_hobb')).toBe('sq_hobb_report');
    expect(s.talk('hobb')).toBe('dlg_hobb_sq_hobb_report');
    expect(s.side('sq_hobb').status).toBe('done');
  });

  it('an acceptance without a talk gets the same re-send on the tick after next', () => {
    const s = session({ prep: (gs) => gs.world.camps.push(HOBB_NEST_CAMP) });
    s.sim.quests.applyEffects([{ kind: 'acceptQuest', quest: 'sq_hobb' }]);
    expect(s.objective('sq_hobb')).toBe('sq_hobb_nest');
    s.step();
    expect(s.objective('sq_hobb')).toBe('sq_hobb_nest');
    s.step();
    expect(s.objective('sq_hobb')).toBe('sq_hobb_report');
  });
});

describe('sq_durga 식어버린 용광로: three braziers round camp_durga', () => {
  it('places three Ember braziers as one allOf puzzle with no order or time limit', () => {
    expect(DURGA_BRAZIERS.kind).toBe('allOf');
    expect(DURGA_BRAZIERS.parts.map((p) => p.device)).toEqual(['brazier', 'brazier', 'brazier']);
    expect('timeLimitSec' in DURGA_BRAZIERS).toBe(false);
    const s = session();
    const view = s.sim.puzzles.views().find((v) => v.id === DURGA_BRAZIERS_PUZZLE);
    expect(view?.parts).toHaveLength(3);
  });

  it('lit in any order with Ember, then Durga: Starmote ×5, the Charm and the forge alight', () => {
    const s = session();
    expect(s.talk('durga')).toBe('dlg_durga_sq_durga_offer');
    expect(s.objective('sq_durga')).toBe('sq_durga_braziers');
    const parts = [...DURGA_BRAZIERS.parts].reverse();
    ignite(s.sim, parts[0]?.id ?? '', 'tide'); // the wrong Element lights nothing
    for (let i = 0; i < 5; i++) s.step();
    expect(s.sim.puzzles.isSolved(DURGA_BRAZIERS_PUZZLE)).toBe(false);
    for (const p of parts) {
      ignite(s.sim, p.id);
      for (let i = 0; i < 5; i++) s.step();
    }
    expect(s.sim.puzzles.isSolved(DURGA_BRAZIERS_PUZZLE)).toBe(true);
    expect(s.objective('sq_durga')).toBe('sq_durga_report');
    const starmote = s.sim.inventory.count('mat_starmote');
    expect(s.talk('durga')).toBe('dlg_durga_sq_durga_report');
    expect(s.side('sq_durga').status).toBe('done');
    expect(s.sim.inventory.count('mat_starmote')).toBe(starmote + 5);
    expect(s.sim.inventory.count('chm_stone_heart')).toBe(1);
    expect(s.sim.village.look().forgeLit).toBe(true);
  });

  it('braziers lit before acceptance complete the Objective as soon as the offer is accepted', () => {
    const s = session({ prep: (gs) => gs.world.puzzles.push(DURGA_BRAZIERS_PUZZLE) });
    s.talk('durga');
    expect(s.objective('sq_durga')).toBe('sq_durga_report');
  });
});

describe('world changes restored from GameState (Req 15.3)', () => {
  it('a loaded save with the three Side_Quests done shows the kite, the flowers and the lit forge at once', () => {
    const gs = createNewGameState(SEED);
    for (const id of ['sq_tamsin', 'sq_hobb', 'sq_durga'] as const) {
      gs.quests.side[id] = { status: 'done', stage: 0, objective: 1 };
      gs.world.flags[SIDE_QUEST_FLAGS[id]] = true;
      gs.quests.flags[SIDE_QUEST_FLAGS[id]] = true;
    }
    const read = readSaveDocument(serializeSave(gs, 0, '2026-01-01T00:00:00.000Z'));
    if (!read.ok) throw new Error(read.error);
    const s = session({ state: read.state });
    expect(s.sim.village.look()).toMatchObject({ kite: true, fieldFlowers: true, forgeLit: true });
    expect(s.sim.sideQuests.kiteState()).toBe('flying');
    expect(s.sim.sideQuests.interactTargets()[0]?.available()).toBe(false);
  });
});

describe('the tracked Side_Quest (Req 15.4)', () => {
  it('trackQuest tracks an active Side_Quest only; the HUD, Compass and map get its Objective; null goes back to main', () => {
    const s = session();
    s.send({ kind: 'trackQuest', questId: 'sq_hobb' }); // not accepted: refused
    expect(s.gs.quests.tracked).toBe('main');
    expect(s.sim.quests.trackedSideObjective()).toBeNull();
    s.talk('hobb');
    const before = s.objectives.length;
    s.send({ kind: 'trackQuest', questId: 'sq_hobb' });
    expect(s.gs.quests.tracked).toBe('sq_hobb');
    const tracked = s.sim.quests.trackedSideObjective();
    expect(tracked?.objective.id).toBe('sq_hobb_nest');
    expect(tracked?.objective.marker.kind).toBe('exact');
    expect(s.objectives.slice(before).at(-1)?.questId).toBe('sq_hobb');
    s.send({ kind: 'trackQuest', questId: null });
    expect(s.gs.quests.tracked).toBe('main');
    expect(s.objectives.at(-1)?.questId).toBe('main');
  });
});

describe('dropping a Side_Quest (Req 15.5)', () => {
  it('without sq_hobb: Hobb only chats, the other two Side_Quests and the Main_Quest still run', () => {
    const defs = QUESTS.filter((q) => q !== SQ_HOBB);
    const s = session({ defs });
    expect(s.side('sq_hobb').status).toBe('locked');
    expect(dialogueDefsFor(defs).some((d) => SIDE_QUEST_DIALOGUES.sq_hobb.includes(d))).toBe(false);
    expect(s.talk('hobb')).toBe('dlg_hobb_b0');
    expect(s.side('sq_hobb').status).toBe('locked');
    // The other Side_Quests.
    expect(s.talk('tamsin')).toBe('dlg_tamsin_sq_tamsin_offer');
    s.sim.bus.emit('interact', { targetKind: 'questItem', targetId: KITE_TARGET_ID });
    s.step();
    s.talk('tamsin');
    expect(s.side('sq_tamsin').status).toBe('done');
    expect(s.sim.puzzles.views().some((v) => v.id === DURGA_BRAZIERS_PUZZLE)).toBe(true);
    // The Main_Quest: Elder Maren's first talk.
    expect(s.objective('main')).toBe(MAIN_QUEST.stages[0]?.objectives[0]?.id);
    expect(s.talk('maren')).toBe('dlg_maren_ms1_maren');
    expect(s.objective('main')).toBe('ms1_isla');
  });

  it('without sq_tamsin there is no kite, without sq_durga no braziers; a save that still lists the quest does not revive it', () => {
    const noKite = session({ defs: QUESTS.filter((q) => q !== SQ_TAMSIN) });
    expect(noKite.sim.sideQuests.interactTargets()).toEqual([]);
    expect(noKite.sim.sideQuests.kiteState()).toBe('none');
    const noBraziers = session({ defs: QUESTS.filter((q) => q !== SQ_DURGA) });
    expect(noBraziers.sim.puzzles.views().some((v) => v.id === DURGA_BRAZIERS_PUZZLE)).toBe(false);
    // A state made with every quest ('available') played with sq_hobb's definition gone: nothing to accept.
    const stale = session({ defs: QUESTS.filter((q) => q !== SQ_HOBB), state: createNewGameState(SEED) });
    expect(stale.side('sq_hobb').status).toBe('available');
    expect(stale.talk('hobb')).toBe('dlg_hobb_b0');
    stale.sim.quests.applyEffects([{ kind: 'acceptQuest', quest: 'sq_hobb' }]);
    expect(stale.side('sq_hobb').status).toBe('available');
    expect(stale.sim.quests.objectiveView('sq_hobb')).toBeNull();
  });
});
