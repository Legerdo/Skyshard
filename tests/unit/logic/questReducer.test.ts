import { describe, expect, it } from 'vitest';
import { acceptSideQuest, currentObjective, initialQuestState, questReducer, setTracked } from '../../../src/logic/quest/questReducer';
import type { ObjectiveDef, ObjectiveTrigger, QuestDef, QuestEffect, QuestEvent, QuestState, StageDef } from '../../../src/logic/quest/types';

/** Stage whose objectives are `<id>_0`, `<id>_1`, ... */
function stage(id: string, name: string, triggers: ObjectiveTrigger[], onStart: QuestEffect[], onComplete: QuestEffect[]): StageDef {
  const objectives = triggers.map((trigger, i): ObjectiveDef => ({ id: `${id}_${i}`, text: name, trigger, category: 'interact', marker: { kind: 'none' } }));
  return { id, name, objectives, onStart, onComplete };
}
const ORE_REWARD = { glim: 50, items: [{ id: 'mat_starmote', count: 2 }] } as const;
const KITE_REWARD = { items: [{ id: 'rlc_bloom', count: 1 }] } as const;

// Synthetic 3-stage Main_Quest and one Side_Quest; both have a 'defeat raid' objective.
const MAIN: QuestDef = {
  id: 'main', kind: 'main', stages: [
    stage('ms1', 'Arrival', [{ kind: 'talk', npc: 'maren' }, { kind: 'defeat', groupId: 'raid' }], [],
      [{ kind: 'grant', reward: { xp: 100 } }, { kind: 'joinParty', character: 'isla' }]),
    stage('ms2', 'Resonance', [{ kind: 'collect', itemId: 'mat_ore', count: 3 }, { kind: 'skyshard', index: 1 }],
      [{ kind: 'spawnGroup', groupId: 'pack' }], [{ kind: 'grant', reward: ORE_REWARD }, { kind: 'setFlag', flag: 'mill_lit' }]),
    stage('ms3', 'Dawn', [{ kind: 'cinematic', cinematicId: 'cin_end' }, { kind: 'reach', areaId: 'square' }],
      [{ kind: 'startCinematic', id: 'cin_end' }], [{ kind: 'grant', reward: { xp: 10 } }]),
  ],
};
const SIDE: QuestDef = {
  id: 'sq_hobb', kind: 'side', stages: [
    stage('hobb1', 'Thorns', [{ kind: 'defeat', groupId: 'raid' }, { kind: 'talk', npc: 'hobb' }], [],
      [{ kind: 'grant', reward: KITE_REWARD }, { kind: 'setFlag', flag: 'hobb_flowers' }]),
  ],
};
const DEFS = [MAIN, SIDE];
const ev = (kind: QuestEvent['kind'], id: string, count?: number): QuestEvent => ({ kind, id, count });
const ROUTE = [ev('talk', 'maren'), ev('defeat', 'raid'), ev('collect', 'mat_ore', 3), ev('skyshard', '1'), ev('cinematic', 'cin_end'),
  ev('reach', 'square')];

/** Feeds events in order; returns the final state and all effects. */
function run(events: readonly QuestEvent[], start: QuestState = initialQuestState(DEFS)): { state: QuestState; effects: QuestEffect[] } {
  let state = start;
  const effects: QuestEffect[] = [];
  for (const e of events) {
    const r = questReducer(state, DEFS, e);
    effects.push(...r.effects);
    state = r.state;
  }
  return { state, effects };
}

describe('questReducer', () => {
  it('starts at the first objective and completes objectives strictly in order', () => {
    const s0 = initialQuestState(DEFS);
    const fresh = { stage: 0, objective: 0 };
    expect(s0).toEqual({
      main: { ...fresh, done: false }, tracked: 'main', flags: {},
      side: { sq_tamsin: { status: 'locked', ...fresh }, sq_hobb: { status: 'available', ...fresh }, sq_durga: { status: 'locked', ...fresh } },
    });
    expect(currentObjective(s0, DEFS, 'main')?.id).toBe('ms1_0');
    expect(questReducer(s0, DEFS, ev('defeat', 'raid')).state).toBe(s0); // skipping ahead does not match
    const r = questReducer(s0, DEFS, ev('talk', 'maren'));
    expect(r.state.main).toEqual({ stage: 0, objective: 1, done: false });
    expect(r.effects).toEqual([{ kind: 'hud:objective' }, { kind: 'save', reason: 'objective' }]);
    expect(currentObjective(r.state, DEFS, 'main')?.id).toBe('ms1_1');
    expect(s0.main).toEqual({ stage: 0, objective: 0, done: false });
    expect(questReducer(r.state, DEFS, ev('talk', 'maren')).state).toBe(r.state); // no repeat or rewind
  });

  it('emits stage completion effects in design order and records setFlag in flags', () => {
    const r1 = questReducer(run(ROUTE.slice(0, 1)).state, DEFS, ROUTE[1]);
    expect(r1.state.main).toEqual({ stage: 1, objective: 0, done: false });
    expect(r1.effects).toEqual([
      { kind: 'hud:stageComplete', stage: 'Arrival', rewards: [{ xp: 100 }] }, // banner
      { kind: 'grant', reward: { xp: 100 } }, { kind: 'joinParty', character: 'isla' }, // onComplete
      { kind: 'save', reason: 'stage' }, { kind: 'spawnGroup', groupId: 'pack' }, { kind: 'hud:objective' }, // save, next onStart, HUD
    ]);
    const r2 = questReducer(run(ROUTE.slice(0, 3)).state, DEFS, ROUTE[3]);
    expect(r2.effects).toEqual([
      { kind: 'hud:stageComplete', stage: 'Resonance', rewards: [ORE_REWARD] },
      { kind: 'grant', reward: ORE_REWARD }, { kind: 'setFlag', flag: 'mill_lit' },
      { kind: 'save', reason: 'stage' }, { kind: 'startCinematic', id: 'cin_end' }, { kind: 'hud:objective' },
    ]);
    expect(r2.state.flags).toEqual({ mill_lit: true });
  });

  it('returns the same state object and exactly one log for non-matching events', () => {
    const s0 = initialQuestState(DEFS);
    const broken: QuestState = { ...s0, main: { stage: 7, objective: -1, done: false } };
    const cases: [QuestState, QuestEvent][] = [
      [s0, ev('talk', 'pip')], [s0, ev('reach', 'maren')], [s0, ev('skyshard', '1')],
      [s0, ev('talk', 'hobb')], // side quest not accepted yet
      [broken, ev('talk', 'maren')], // out-of-range indices
    ];
    for (const [state, e] of cases) {
      const r = questReducer(state, DEFS, e);
      expect(r.state).toBe(state);
      expect(r.effects).toEqual([{ kind: 'log', message: expect.any(String) }]);
    }
  });

  it('progresses side quests independently, main first when one event matches both', () => {
    const s0 = initialQuestState(DEFS);
    expect(acceptSideQuest(s0, 'sq_tamsin')).toBe(s0); // locked: no definition
    expect(setTracked(s0, 'sq_hobb')).toBe(s0); // not active yet
    const accepted = setTracked(acceptSideQuest(s0, 'sq_hobb'), 'sq_hobb');
    expect([accepted.side.sq_hobb.status, accepted.tracked]).toEqual(['active', 'sq_hobb']);
    const atRaid = run([ev('talk', 'maren')], accepted).state;
    expect(atRaid.side).toBe(accepted.side);
    const both = questReducer(atRaid, DEFS, ev('defeat', 'raid'));
    const mainOnly = questReducer(atRaid, [MAIN], ev('defeat', 'raid'));
    expect(both.state.main).toEqual(mainOnly.state.main);
    expect(both.state.side.sq_hobb).toEqual({ status: 'active', stage: 0, objective: 1 });
    expect(both.effects).toEqual([...mainOnly.effects, { kind: 'hud:objective' }, { kind: 'save', reason: 'objective' }]);
    const done = questReducer(both.state, DEFS, ev('talk', 'hobb'));
    const sideDone = { ...both.state.side, sq_hobb: { status: 'done', stage: 0, objective: 1 } };
    expect(done.state).toEqual({ main: both.state.main, side: sideDone, tracked: 'main', flags: { hobb_flowers: true } });
    expect(done.effects).toEqual([
      { kind: 'hud:stageComplete', stage: 'Thorns', rewards: [KITE_REWARD] },
      { kind: 'grant', reward: KITE_REWARD }, { kind: 'setFlag', flag: 'hobb_flowers' },
      { kind: 'save', reason: 'sideQuest' }, { kind: 'hud:objective' },
    ]);
    expect(currentObjective(done.state, DEFS, 'sq_hobb')).toBeNull();
  });

  it('sets done after the last stage and stops matching main events', () => {
    const { state, effects } = run(ROUTE);
    expect(state.main).toEqual({ stage: 2, objective: 1, done: true });
    expect(effects.slice(-4)).toEqual([
      { kind: 'hud:stageComplete', stage: 'Dawn', rewards: [{ xp: 10 }] }, { kind: 'grant', reward: { xp: 10 } },
      { kind: 'save', reason: 'stage' }, { kind: 'hud:objective' }, // no next stage, so no onStart
    ]);
    expect(currentObjective(state, DEFS, 'main')).toBeNull();
    for (const e of ROUTE) expect(questReducer(state, DEFS, e).state).toBe(state);
  });

  it('matches collect only once the held count reaches the threshold', () => {
    const { state } = run(ROUTE.slice(0, 2));
    expect(currentObjective(state, DEFS, 'main')?.id).toBe('ms2_0');
    for (const e of [ev('collect', 'mat_ore'), ev('collect', 'mat_ore', 2), ev('collect', 'mat_other', 9)]) expect(questReducer(state, DEFS, e).state).toBe(state);
    expect(questReducer(state, DEFS, ev('collect', 'mat_ore', 3)).state.main.objective).toBe(1);
    expect(questReducer(state, DEFS, ev('collect', 'mat_ore', 8)).state.main.objective).toBe(1);
  });
});
