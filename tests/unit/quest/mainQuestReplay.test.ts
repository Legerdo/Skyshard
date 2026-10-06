import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { MAIN_STAGE_IDS, MAIN_STAGE_NAMES, type CharacterId, type MainStageId, type NpcId } from '../../../src/data/ids';
import { XP_SOURCES } from '../../../src/data/progression';
import { QUESTS } from '../../../src/data/quests';
import { initialQuestState, questReducer } from '../../../src/logic/questReducer';
import type { QuestDef, QuestEffect, QuestEvent, QuestState } from '../../../src/logic/questReducer';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { QUEST_INPUT_EVENTS, QuestSystem, toQuestEvent, type ObjectiveView } from '../../../src/quest/questSystem';

const ev = (kind: QuestEvent['kind'], id: string): QuestEvent => ({ kind, id });

/** Table D triggers, restated independently of the data, stage by stage. */
const TABLE_D: Readonly<Record<MainStageId, readonly QuestEvent[]>> = {
  ms1: [ev('talk', 'maren'), ev('talk', 'isla'), ev('defeat', 'village_raid'), ev('talk', 'maren')],
  ms2: [ev('reach', 'breezewatch_base'), ev('reach', 'vista_verdant'), ev('talk', 'wren'), ev('reach', 'lm_elderbough')],
  ms3: [ev('talk', 'talus'), ev('solve', 'pz_hollowroot_1'), ev('solve', 'pz_hollowroot_2'), ev('solve', 'pz_hollowroot_3'),
    ev('defeat', 'hollowroot_room'), ev('defeat', 'rootboundWarden'), ev('skyshard', '1')],
  ms4: [ev('reach', 'gate_ember'), ev('reach', 'bridge_far_side'), ev('talk', 'durga'), ev('defeat', 'ember_pass_pack'),
    ev('reach', 'cinderspire_base')],
  ms5: [ev('reach', 'cp_cinderspire_1'), ev('reach', 'cp_cinderspire_2'), ev('solve', 'pz_cinderspire_1'), ev('defeat', 'cinderAlpha'),
    ev('skyshard', '2')],
  ms6: [ev('reach', 'gate_azure'), ev('talk', 'oriel'), ev('reach', 'wind_ridge_end'), ev('defeat', 'azure_ridge_pack')],
  ms7: [ev('reach', 'observatory_hall'), ev('solve', 'pz_observatory_1'), ev('defeat', 'observatory_waves'), ev('defeat', 'sentinelPrime'),
    ev('skyshard', '3')],
  ms8: [ev('reach', 'resonance_altar'), ev('interact', 'resonance_altar'), ev('reach', 'sanctum_gate')],
  ms9: [ev('interact', 'sanctum_mural'), ev('reach', 'sanctum_arena'), ev('defeat', 'caelith')],
  ms10: [ev('cinematic', 'cin_ending'), ev('reach', 'thistlewick'), ev('talk', 'maren')],
};
const ROUTE = MAIN_STAGE_IDS.flatMap((id) => TABLE_D[id]);
const same = (a: QuestEvent, b: QuestEvent): boolean => a.kind === b.kind && a.id === b.id;

/** Encounter groups each stage's onStart activates (ms1's runs at New Game). */
const SPAWNS: Readonly<Partial<Record<MainStageId, string>>> = { ms1: 'village_raid', ms4: 'ember_pass_pack', ms6: 'azure_ridge_pack' };
const onStartOf = (id: MainStageId | undefined): QuestEffect[] => {
  const group = id && SPAWNS[id];
  return group ? [{ kind: 'spawnGroup', groupId: group }] : [];
};

/** Design rule 3: banner → onComplete (the XP grant) → stage save → next onStart → HUD objective. */
function stageEffects(id: MainStageId, next: MainStageId | undefined): QuestEffect[] {
  const xp = XP_SOURCES.stage[id as keyof typeof XP_SOURCES.stage];
  const rewards = xp === undefined ? [] : [{ xp }];
  return [
    { kind: 'hud:stageComplete', stage: MAIN_STAGE_NAMES[id], rewards },
    ...rewards.map((reward): QuestEffect => ({ kind: 'grant', reward })),
    { kind: 'save', reason: 'stage' },
    ...onStartOf(next),
    { kind: 'hud:objective' },
  ];
}

describe('Main_Quest full-route replay (questReducer + QUESTS)', () => {
  it('advances one Objective per table D trigger, ends with main.done and emits each stage’s effects in order', () => {
    let state: QuestState = initialQuestState(QUESTS);
    let xp = 0;
    MAIN_STAGE_IDS.forEach((stageId, si) => {
      TABLE_D[stageId].forEach((trigger, oi) => {
        expect(state.main, `${stageId} #${oi}`).toEqual({ stage: si, objective: oi, done: false });
        // Skipping ahead, rewinding or repeating finished steps changes nothing and only logs (Req 3.2).
        for (const other of ROUTE.filter((e) => !same(e, trigger))) {
          const r = questReducer(state, QUESTS, other);
          expect(r.state).toBe(state);
          expect(r.effects).toEqual([{ kind: 'log', message: expect.any(String) }]);
        }
        const { state: next, effects } = questReducer(state, QUESTS, trigger);
        const last = oi === TABLE_D[stageId].length - 1;
        expect(effects, `${stageId} #${oi}`).toEqual(
          last ? stageEffects(stageId, MAIN_STAGE_IDS[si + 1]) : [{ kind: 'hud:objective' }, { kind: 'save', reason: 'objective' }],
        );
        expect(next.side).toBe(state.side); // main progress never touches side quests
        for (const e of effects) if (e.kind === 'grant') xp += e.reward.xp ?? 0;
        state = next;
      });
    });
    expect(state.main).toEqual({ stage: 9, objective: 2, done: true });
    expect(xp).toBe(660); // ms1–ms8 stage XP (design "메인 진행만의 레벨 검증")
    for (const e of ROUTE) expect(questReducer(state, QUESTS, e).state).toBe(state);
  });
});

/** Bus events that publish each table D trigger (the altar publishes a raw interact and its activation). */
function publish(bus: ReturnType<typeof createGameEventBus>, e: QuestEvent): void {
  switch (e.kind) {
    case 'talk': bus.emit('dialogue:ended', { npcId: e.id as NpcId | CharacterId, dialogueId: `dlg_${e.id}` }); break;
    case 'reach': bus.emit('area:entered', { regionId: 'verdant', areaId: e.id, first: true }); break;
    case 'defeat':
      if (e.id === 'caelith') bus.emit('boss:defeated', { bossId: 'caelith' });
      else {
        bus.emit('enemy:defeated', { entityId: `${e.id}#1`, kind: 'bramblekin', campId: e.id }); // not quest input
        bus.emit('camp:cleared', { campId: e.id, regionId: 'verdant' });
      }
      break;
    case 'solve': bus.emit('puzzle:solved', { puzzleId: e.id, regionId: 'verdant' }); break;
    case 'skyshard': bus.emit('skyshard:acquired', { index: Number(e.id) as 1 | 2 | 3, regionId: 'verdant' }); break;
    case 'interact':
      if (e.id === 'resonance_altar') {
        bus.emit('interact', { targetKind: 'altar', targetId: e.id });
        bus.emit('altar:activated', {});
      } else bus.emit('interact', { targetKind: 'mural', targetId: e.id });
      break;
    case 'cinematic': bus.emit('cinematic:ended', { cinematicId: e.id, skipped: false }); break;
    default: throw new Error(`no publisher for ${e.kind}`);
  }
}

describe('QuestSystem adapter', () => {
  it('replays the whole route from EventBus events in emit order and applies the reducer effects in order', () => {
    const gs = createNewGameState(7);
    const bus = createGameEventBus();
    const applied: QuestEffect[] = [];
    const views: (string | null)[] = [];
    const spawned: string[] = [];
    const published: [GameEventName, unknown][] = [];
    bus.onAny((type, payload) => published.push([type, payload]));
    const system = new QuestSystem({
      bus, state: gs, defs: QUESTS,
      sinks: {
        effect: (e) => applied.push(e),
        objective: (v: ObjectiveView | null) => views.push(v && v.objective.id),
        spawnGroup: (g) => spawned.push(g),
      },
    });

    system.startNewGame();
    expect(applied).toEqual([{ kind: 'spawnGroup', groupId: 'village_raid' }, { kind: 'hud:objective' }]);
    expect(views).toEqual(['ms1_maren']);

    // Noise first: not a current Objective, so the state stays and one log follows.
    bus.emit('item:granted', { itemId: 'mat_starmote', count: 1, source: 'chest' });
    for (const e of ROUTE) publish(bus, e);
    bus.dispatch(); // one EventDispatch: every event, plus the quest events they cause, in FIFO order

    expect(gs.quests.main).toEqual({ stage: 9, objective: 2, done: true });
    // The adapter applied exactly the pure reducer's effects for the same QuestEvent sequence.
    let expected: QuestEffect[] = [];
    let s = initialQuestState(QUESTS);
    for (const e of [{ kind: 'collect', id: 'mat_starmote', count: 0 } as QuestEvent, ...ROUTE]) {
      const r = questReducer(s, QUESTS, e);
      expected = [...expected, ...r.effects];
      s = r.state;
    }
    expect(applied.slice(2)).toEqual(expected);
    expect(spawned).toEqual(['village_raid', 'ember_pass_pack', 'azure_ridge_pack']);
    expect(views.at(-1)).toBeNull(); // no tracked objective once main is done
    expect(views).toContain('ms3_warden');

    const names = published.map(([t]) => t);
    const stages = published.filter(([t]) => t === 'quest:stageCompleted').map(([, p]) => p);
    expect(stages).toEqual(MAIN_STAGE_IDS.map((stageId) => ({ questId: 'main', stageId, questDone: stageId === 'ms10' })));
    const saves = published.filter(([t]) => t === 'save:request').map(([, p]) => (p as { reason: string }).reason);
    expect(saves.filter((r) => r === 'stage')).toHaveLength(10);
    expect(saves.filter((r) => r === 'objective')).toHaveLength(ROUTE.length - 10);
    expect(names.filter((t) => t === 'quest:objectiveCompleted')).toHaveLength(ROUTE.length);
    // Completion events precede the Milestone save they cause.
    const ms1Done = published.findIndex(([t, p]) => t === 'quest:stageCompleted' && (p as { stageId: string }).stageId === 'ms1');
    expect(published.slice(ms1Done - 1, ms1Done + 2)).toEqual([
      ['quest:objectiveCompleted', { questId: 'main', stageId: 'ms1', objectiveId: 'ms1_report' }],
      ['quest:stageCompleted', { questId: 'main', stageId: 'ms1', questDone: false }],
      ['save:request', { reason: 'stage' }],
    ]);
    system.dispose();
  });

  it('maps bus events to quest events: held count for collect, altar interacts left to altar:activated', () => {
    expect(QUEST_INPUT_EVENTS).not.toContain('enemy:defeated');
    expect(toQuestEvent('item:granted', { itemId: 'mat_ore', count: 1, source: 'chest' }, () => 3)).toEqual({ kind: 'collect', id: 'mat_ore', count: 3 });
    expect(toQuestEvent('interact', { targetKind: 'altar', targetId: 'resonance_altar' }, () => 0)).toBeNull();
    expect(toQuestEvent('altar:activated', {}, () => 0)).toEqual({ kind: 'interact', id: 'resonance_altar' });
    expect(toQuestEvent('skyshard:acquired', { index: 2, regionId: 'ember' }, () => 0)).toEqual({ kind: 'skyshard', id: '2' });
    expect(toQuestEvent('boss:defeated', { bossId: 'caelith' }, () => 0)).toEqual({ kind: 'defeat', id: 'caelith' });
  });

  it('turns setFlag effects into world flags and a flag event that runs after the current effects', () => {
    const DEFS: QuestDef[] = [{
      id: 'main', kind: 'main', stages: [
        { id: 'ms1', name: 'Bell', onStart: [], onComplete: [{ kind: 'setFlag', flag: 'bell_rung' }],
          objectives: [{ id: 'ms1_bell', text: '종', trigger: { kind: 'interact', targetId: 'bell' }, category: 'interact', marker: { kind: 'none' } }] },
        { id: 'ms2', name: 'Echo', onStart: [], onComplete: [],
          objectives: [
            { id: 'ms2_echo', text: '메아리', trigger: { kind: 'flag', flag: 'bell_rung' }, category: 'explore', marker: { kind: 'none' } },
            { id: 'ms2_end', text: '광장', trigger: { kind: 'reach', areaId: 'plaza' }, category: 'explore', marker: { kind: 'none' } },
          ] },
      ],
    }];
    const gs = createNewGameState(1, { quests: DEFS });
    const bus = createGameEventBus();
    const applied: QuestEffect['kind'][] = [];
    const system = new QuestSystem({ bus, state: gs, defs: DEFS, sinks: { effect: (e) => applied.push(e.kind) } });
    bus.emit('interact', { targetKind: 'puzzle', targetId: 'bell' });
    bus.dispatch();
    expect(gs.world.flags).toEqual({ bell_rung: true });
    expect(gs.quests.flags).toEqual({ bell_rung: true });
    expect(gs.quests.main).toEqual({ stage: 1, objective: 1, done: false });
    expect(applied).toEqual(['hud:stageComplete', 'setFlag', 'save', 'hud:objective', 'hud:objective', 'save']);
    system.raiseFlag('bell_rung'); // already on: no second flag event
    expect(gs.quests.main).toEqual({ stage: 1, objective: 1, done: false });
    system.dispose();
  });
});
