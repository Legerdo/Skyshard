/*
 * Quest progression (design.md "questReducer 규칙" 1–7). Pure, total and deterministic: inputs are
 * never mutated, and an event matching no active objective returns the same state object.
 */
import { SIDE_QUEST_IDS, type SideQuestId } from '../../data/ids';
import type {
  ObjectiveDef, ObjectiveTrigger, QuestDef, QuestEffect, QuestEvent, QuestId, QuestResult, QuestState, SideQuestProgress, StageDef,
} from './types';

/** Matching and effect order for one event: main first, then side quests in registry order (rule 5). */
const QUEST_ORDER: readonly QuestId[] = ['main', ...SIDE_QUEST_IDS];

interface Position {
  stage: number;
  objective: number;
}

interface Step extends Position {
  done: boolean;
  effects: QuestEffect[];
}

/** Trigger target compared with `ev.id`. */
function targetOf(t: ObjectiveTrigger): string {
  switch (t.kind) {
    case 'talk': return t.npc;
    case 'reach': return t.areaId;
    case 'defeat': return t.groupId;
    case 'interact': return t.targetId;
    case 'solve': return t.puzzleId;
    case 'skyshard': return String(t.index);
    case 'cinematic': return t.cinematicId;
    case 'collect': return t.itemId;
    case 'flag': return t.flag;
  }
}

/** Same kind and target; `collect` also needs `ev.count >= count` (a missing count never matches). */
export function matchesTrigger(t: ObjectiveTrigger, ev: QuestEvent): boolean {
  if (ev.kind !== t.kind || ev.id !== targetOf(t)) return false;
  return t.kind !== 'collect' || (typeof ev.count === 'number' && ev.count >= t.count);
}

const findDef = (defs: readonly QuestDef[], id: QuestId): QuestDef | undefined => defs.find((d) => d.id === id);

/** Main until done; a side quest only while 'active'. Main never reads `side` (rule 5). */
function positionOf(state: QuestState, id: QuestId): Position | null {
  if (id === 'main') return state.main.done ? null : state.main;
  const side = state.side[id];
  return side?.status === 'active' ? side : null;
}

/** The objective a quest waits on; null when done, not active, undefined or out of range. */
export function currentObjective(state: QuestState, defs: readonly QuestDef[], id: QuestId): ObjectiveDef | null {
  const pos = positionOf(state, id);
  if (pos === null) return null;
  return findDef(defs, id)?.stages[pos.stage]?.objectives[pos.objective] ?? null;
}

/** Completes the objective at `pos` and activates the next one in the same call (rules 2, 3). */
function advance(def: QuestDef, pos: Position, stageSave: 'stage' | 'sideQuest'): Step {
  const stage = def.stages[pos.stage];
  if (pos.objective + 1 < stage.objectives.length) {
    const effects: QuestEffect[] = [{ kind: 'hud:objective' }, { kind: 'save', reason: 'objective' }];
    return { stage: pos.stage, objective: pos.objective + 1, done: false, effects };
  }
  const next: StageDef | undefined = def.stages[pos.stage + 1];
  const rewards = stage.onComplete.flatMap((e) => (e.kind === 'grant' ? [e.reward] : []));
  const effects: QuestEffect[] = [
    { kind: 'hud:stageComplete', stage: stage.name, rewards },
    ...stage.onComplete,
    { kind: 'save', reason: stageSave }, // replaces the objective save
    ...(next?.onStart ?? []),
    { kind: 'hud:objective' },
  ];
  return next
    ? { stage: pos.stage + 1, objective: 0, done: false, effects }
    : { stage: pos.stage, objective: pos.objective, done: true, effects };
}

/** Writes a step into the state; emitted `setFlag`s are recorded in `flags` too. */
function applyStep(s: QuestState, id: QuestId, step: Step): QuestState {
  let flags = s.flags;
  for (const e of step.effects) if (e.kind === 'setFlag') flags = { ...flags, [e.flag]: true };
  const { stage, objective, done } = step;
  if (id === 'main') return { ...s, flags, main: { stage, objective, done } };
  const side: SideQuestProgress = { status: done ? 'done' : 'active', stage, objective };
  // A finished side quest cannot stay tracked.
  const tracked: QuestId = done && s.tracked === id ? 'main' : s.tracked;
  return { ...s, flags, tracked, side: { ...s.side, [id]: side } };
}

export function questReducer(state: QuestState, defs: readonly QuestDef[], ev: QuestEvent): QuestResult {
  let next = state;
  const effects: QuestEffect[] = [];
  for (const id of QUEST_ORDER) {
    // Quests without a definition never match, whatever their state (rule 6).
    const def = findDef(defs, id);
    const pos = positionOf(state, id);
    const objective = pos && def?.stages[pos.stage]?.objectives[pos.objective];
    if (!def || !pos || !objective || !matchesTrigger(objective.trigger, ev)) continue;
    const step = advance(def, pos, id === 'main' ? 'stage' : 'sideQuest');
    next = applyStep(next, id, step);
    effects.push(...step.effects);
  }
  if (next === state) {
    return { state, effects: [{ kind: 'log', message: `quest: no active objective for ${String(ev.kind)}:${String(ev.id)}` }] };
  }
  return { state: next, effects };
}

/** Fresh progress: main at its first objective; defined side quests 'available', the rest 'locked'. */
export function initialQuestState(defs: readonly QuestDef[]): QuestState {
  const entry = (id: SideQuestId): SideQuestProgress => ({
    status: findDef(defs, id) ? 'available' : 'locked',
    stage: 0,
    objective: 0,
  });
  return {
    main: { stage: 0, objective: 0, done: false },
    side: { sq_tamsin: entry('sq_tamsin'), sq_hobb: entry('sq_hobb'), sq_durga: entry('sq_durga') },
    tracked: 'main',
    flags: {},
  };
}

/** 'available' → 'active'; any other status returns the same state. */
export function acceptSideQuest(state: QuestState, id: SideQuestId): QuestState {
  const cur = state.side[id];
  if (cur?.status !== 'available') return state;
  const accepted: SideQuestProgress = { ...cur, status: 'active' };
  return { ...state, side: { ...state.side, [id]: accepted } };
}

/** Tracks main or an 'active' side quest; anything else returns the same state. */
export function setTracked(state: QuestState, id: QuestId): QuestState {
  if (state.tracked === id) return state;
  if (id !== 'main' && state.side[id]?.status !== 'active') return state;
  return { ...state, tracked: id };
}
