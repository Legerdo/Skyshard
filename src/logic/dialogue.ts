/*
 * Dialogue selection and window rules (design.md "Dialogue_System", task 13.1; Req 14.4–14.7). Pure, total and
 * deterministic: GameState and the definitions in, one DialogueDef out; inputs are never changed and neither time nor
 * randomness is read.
 *
 * Candidates are the definitions for `npc` whose `when` fields all hold:
 * - `questStage`: equals the current stage id or current Objective id of the Main_Quest (until it is done) or of an
 *   'active' Side_Quest;
 * - `sideQuest`: that Side_Quest has the given status;
 * - `flag`: the progress flag is on (GameState.world.flags, or the quest state's own flag record);
 * - `bucket`: the progress band, 'post' once the game is completed, else the Skyshards held (0–3);
 * - a one-shot reaction (`flag` without `questStage` / `sideQuest`) whose `seen_<id>` flag is on is no candidate.
 * Ranking: questStage / sideQuest > flag > bucket > the default (`when` empty). Within a rank an Objective-id match
 * beats a stage-id match, which beats a status-only match; then more condition fields first; then array order.
 * When no definition matches (an NPC without a default), a one-window fallback keeps the function total.
 *
 * Pure: imports only src/data, src/logic and core types (src/logic layering rule).
 */
import {
  DIALOGUE_RULES, seenFlag, type DialogueBucket, type DialogueDef, type Speaker,
} from '../data/dialogue';
import { SIDE_QUEST_IDS, isMainStageId } from '../data/ids';
import { QUESTS } from '../data/quests';
import type { QuestDef, QuestId, QuestState } from './quest/types';
import type { DeepReadonly, GameState } from './save/gameState';

/** What selection reads from GameState. */
export type DialogueState = DeepReadonly<Pick<GameState, 'skyshards' | 'gameCompleted' | 'quests' | 'world'>>;

/** The progress band: 'post' once the game is completed (Req 7.6), else the Skyshards held. */
export function dialogueBucket(gs: Pick<DialogueState, 'skyshards' | 'gameCompleted'>): DialogueBucket {
  return gs.gameCompleted ? 'post' : gs.skyshards;
}

/** Where a quest in progress stands: its current stage and Objective ids. */
export interface QuestPlace {
  readonly questId: QuestId;
  readonly stageId: string;
  readonly objectiveId: string;
}

/** The Main_Quest (until done) and every 'active' Side_Quest at their current stage and Objective. */
export function questPlaces(q: DeepReadonly<QuestState>, quests: readonly QuestDef[] = QUESTS): QuestPlace[] {
  const out: QuestPlace[] = [];
  const add = (questId: QuestId, stage: number, objective: number): void => {
    const s = quests.find((d) => d.id === questId)?.stages[stage];
    const o = s?.objectives[objective];
    if (s !== undefined && o !== undefined) out.push({ questId, stageId: s.id, objectiveId: o.id });
  };
  if (!q.main.done) add('main', q.main.stage, q.main.objective);
  for (const id of SIDE_QUEST_IDS) {
    const side = q.side[id];
    if (side?.status === 'active') add(id, side.stage, side.objective);
  }
  return out;
}

/** Whether progress flag `flag` is on. */
export function flagOn(gs: Pick<DialogueState, 'world' | 'quests'>, flag: string): boolean {
  return gs.world.flags[flag] === true || gs.quests.flags[flag] === true;
}

/** A one-shot reaction: `flag` without `questStage` or `sideQuest`; it retires with `seen_<id>`. */
export function isOneShot(def: Pick<DialogueDef, 'when'>): boolean {
  const w = def.when;
  return w.flag !== undefined && w.questStage === undefined && w.sideQuest === undefined;
}

/** Selection rank: 3 quest (questStage / sideQuest), 2 flag, 1 bucket, 0 default. */
export function dialogueRank(def: Pick<DialogueDef, 'when'>): 0 | 1 | 2 | 3 {
  const w = def.when;
  if (w.questStage !== undefined || w.sideQuest !== undefined) return 3;
  if (w.flag !== undefined) return 2;
  if (w.bucket !== undefined) return 1;
  return 0;
}

/** Number of condition fields given. */
function fieldCount(def: Pick<DialogueDef, 'when'>): number {
  const w = def.when;
  return Number(w.bucket !== undefined) + Number(w.questStage !== undefined) + Number(w.flag !== undefined) + Number(w.sideQuest !== undefined);
}

interface Match {
  readonly rank: number;
  /** Within the quest rank: 2 Objective id, 1 stage id, 0 status only (or none). */
  readonly precision: number;
  readonly fields: number;
  readonly index: number;
}

function matchOf(def: DialogueDef, index: number, gs: DialogueState, places: readonly QuestPlace[], bucket: DialogueBucket): Match | null {
  const w = def.when;
  let precision = 0;
  if (w.questStage !== undefined) {
    if (places.some((p) => p.objectiveId === w.questStage)) precision = 2;
    else if (places.some((p) => p.stageId === w.questStage)) precision = 1;
    else return null;
  }
  if (w.sideQuest !== undefined && gs.quests.side[w.sideQuest.id]?.status !== w.sideQuest.status) return null;
  if (w.flag !== undefined && !flagOn(gs, w.flag)) return null;
  if (w.bucket !== undefined && w.bucket !== bucket) return null;
  if (isOneShot(def) && flagOn(gs, seenFlag(def.id))) return null;
  return { rank: dialogueRank(def), precision, fields: fieldCount(def), index };
}

/** Negative when `a` goes first. */
function compare(a: Match, b: Match): number {
  return b.rank - a.rank || b.precision - a.precision || b.fields - a.fields || a.index - b.index;
}

/** Every candidate for `npc` now, best first (the first is what selectDialogue returns). */
export function dialogueCandidates(
  npc: Speaker, gs: DialogueState, defs: readonly DialogueDef[], quests: readonly QuestDef[] = QUESTS,
): DialogueDef[] {
  const places = questPlaces(gs.quests, quests);
  const bucket = dialogueBucket(gs);
  const found: { def: DialogueDef; m: Match }[] = [];
  defs.forEach((def, index) => {
    if (def.npc !== npc) return;
    const m = matchOf(def, index, gs, places, bucket);
    if (m !== null) found.push({ def, m });
  });
  return found.sort((a, b) => compare(a.m, b.m)).map((f) => f.def);
}

/** The fallback when `npc` has no matching definition at all. */
export function fallbackDialogue(npc: Speaker): DialogueDef {
  return { id: `dlg_${npc}_fallback`, npc, when: {}, lines: [{ speaker: npc, text: '……' }] };
}

/**
 * The dialogue `npc` plays now (design `selectDialogue`). `quests` resolves the current stage and Objective ids
 * (default: the game's quest data).
 */
export function selectDialogue(
  npc: Speaker, gs: DialogueState, defs: readonly DialogueDef[], quests: readonly QuestDef[] = QUESTS,
): DialogueDef {
  return dialogueCandidates(npc, gs, defs, quests)[0] ?? fallbackDialogue(npc);
}

/** Whether `def` is a main-story dialogue: its `questStage` names a Main_Quest stage or Objective (≤ 10 windows). */
export function isMainStoryDialogue(def: Pick<DialogueDef, 'when'>, quests: readonly QuestDef[] = QUESTS): boolean {
  const stage = def.when.questStage;
  if (stage === undefined) return false;
  if (isMainStageId(stage)) return true;
  const main = quests.find((q) => q.id === 'main');
  return main?.stages.some((s) => s.objectives.some((o) => o.id === stage)) ?? false;
}

/** Window cap of a dialogue: 10 for main-story dialogues, else 6 (Req 14.5). */
export function windowLimit(def: Pick<DialogueDef, 'when'>, quests: readonly QuestDef[] = QUESTS): number {
  return isMainStoryDialogue(def, quests) ? DIALOGUE_RULES.maxStoryWindows : DIALOGUE_RULES.maxWindows;
}

/** Characters of `text` shown after `elapsed` s of typing at 45 characters per second (Req 14.6). */
export function visibleChars(text: string, elapsed: number): number {
  if (!(elapsed > 0)) return 0;
  return Math.min(text.length, Math.floor(elapsed * DIALOGUE_RULES.charsPerSecond + 1e-9));
}

/** Seconds a window takes to type out in full. */
export function typingSeconds(text: string): number {
  return text.length / DIALOGUE_RULES.charsPerSecond;
}

/** Where a playing dialogue stands. */
export interface DialogueCursor {
  /** Window index. */
  readonly line: number;
  /** Seconds this window has been typing. */
  readonly elapsed: number;
  /** The window was completed early by an advance press. */
  readonly completed: boolean;
}

/** The result of one advance press (F / Space / left click, Req 14.6). */
export type AdvanceResult =
  | { readonly kind: 'complete'; readonly cursor: DialogueCursor }
  | { readonly kind: 'next'; readonly cursor: DialogueCursor }
  | { readonly kind: 'end' };

/** Whether the cursor's window is fully shown. */
export function windowComplete(lines: readonly { readonly text: string }[], cursor: DialogueCursor): boolean {
  const line = lines[cursor.line];
  return line === undefined || cursor.completed || visibleChars(line.text, cursor.elapsed) >= line.text.length;
}

/** An advance press: a window still typing is completed at once; a complete one moves on to the next or ends. */
export function advanceDialogue(lines: readonly { readonly text: string }[], cursor: DialogueCursor): AdvanceResult {
  if (!windowComplete(lines, cursor)) return { kind: 'complete', cursor: { ...cursor, completed: true } };
  if (cursor.line + 1 < lines.length) return { kind: 'next', cursor: { line: cursor.line + 1, elapsed: 0, completed: false } };
  return { kind: 'end' };
}
