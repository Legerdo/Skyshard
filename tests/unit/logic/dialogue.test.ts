import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DIALOGUES, SIDE_QUEST_FLAGS, seenFlag, type DialogueDef, type Speaker } from '../../../src/data/dialogue';
import { CHARACTER_IDS, NPC_IDS } from '../../../src/data/ids';
import { MAIN_QUEST } from '../../../src/data/quests';
import {
  advanceDialogue, dialogueBucket, dialogueCandidates, dialogueRank, fallbackDialogue, flagOn, isOneShot, questPlaces, selectDialogue,
  typingSeconds, visibleChars, type DialogueCursor,
} from '../../../src/logic/dialogue';
import { cloneGameState, createNewGameState, type GameState } from '../../../src/logic/save/gameState';

// selectDialogue and the window rules (task 13.1; Req 14.4–14.7).

/** Puts the Main_Quest at Objective `id` (as if every earlier one were done). */
function at(gs: GameState, id: string): GameState {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
  return gs;
}
const fresh = (): GameState => createNewGameState(7);
const pick = (npc: Speaker, gs: GameState): string => selectDialogue(npc, gs, DIALOGUES).id;

describe('selectDialogue: Elder Maren in ms1 (Objective branches)', () => {
  it('plays a different dialogue at each ms1 Objective: ① arrival, ② the stage-level hint, ③ the raid, ④ the report', () => {
    expect(pick('maren', at(fresh(), 'ms1_maren'))).toBe('dlg_maren_ms1_maren');
    expect(pick('maren', at(fresh(), 'ms1_isla'))).toBe('dlg_maren_ms1'); // stage id: no Objective-specific talk
    expect(pick('maren', at(fresh(), 'ms1_raid'))).toBe('dlg_maren_ms1_raid');
    expect(pick('maren', at(fresh(), 'ms1_report'))).toBe('dlg_maren_ms1_report');
  });

  it('an Objective id beats a stage id of the same rank', () => {
    const gs = at(fresh(), 'ms1_maren');
    const ranked = dialogueCandidates('maren', gs, DIALOGUES).map((d) => d.id);
    expect(ranked.slice(0, 2)).toEqual(['dlg_maren_ms1_maren', 'dlg_maren_ms1']);
    expect(ranked.at(-1)).toBe('dlg_maren_default'); // the default comes last
  });

  it('after the Main_Quest stage has no Maren talk, she falls back to her Skyshard bucket', () => {
    const gs = at(fresh(), 'ms4_ashgate');
    gs.skyshards = 1;
    expect(pick('maren', gs)).toBe('dlg_maren_b1');
  });
});

describe('selectDialogue: one-shot reactions', () => {
  it('a flag reaction plays once; with its seen_ flag on, the bucket dialogue comes back', () => {
    const gs = at(fresh(), 'ms4_ashgate');
    gs.skyshards = 1;
    gs.world.flags[SIDE_QUEST_FLAGS.sq_tamsin] = true;
    const reaction = selectDialogue('maren', gs, DIALOGUES);
    expect(reaction.id).toBe('dlg_maren_react_village_kite');
    expect(isOneShot(reaction)).toBe(true);
    gs.world.flags[seenFlag(reaction.id)] = true;
    expect(pick('maren', gs)).toBe('dlg_maren_b1');
  });

  it('a questStage dialogue outranks a flag reaction, which outranks the bucket', () => {
    const gs = at(fresh(), 'ms1_report');
    gs.world.flags[SIDE_QUEST_FLAGS.sq_tamsin] = true;
    expect(pick('maren', gs)).toBe('dlg_maren_ms1_report');
    at(gs, 'ms4_ashgate');
    expect(pick('maren', gs)).toBe('dlg_maren_react_village_kite');
  });

  it('flags from the quest state count too', () => {
    const gs = fresh();
    expect(flagOn(gs, 'x')).toBe(false);
    gs.quests.flags.x = true;
    expect(flagOn(gs, 'x')).toBe(true);
  });
});

describe('selectDialogue: buckets, Side_Quest offers and totality', () => {
  it('the bucket is the Skyshards held, "post" once the game is completed', () => {
    const gs = fresh();
    for (const n of [0, 1, 2, 3] as const) {
      gs.skyshards = n;
      expect(dialogueBucket(gs)).toBe(n);
      expect(pick('pip', gs)).toBe(`dlg_pip_b${n}`);
    }
    gs.gameCompleted = true;
    expect(dialogueBucket(gs)).toBe('post');
    expect(pick('oriel', gs)).toBe('dlg_oriel_post');
  });

  it('a quest giver offers its Side_Quest while available, reminds while active, and goes back to its bucket once done', () => {
    const gs = fresh();
    expect(gs.quests.side.sq_hobb.status).toBe('available');
    expect(pick('hobb', gs)).toBe('dlg_hobb_sq_hobb_offer');
    gs.quests.side.sq_hobb.status = 'active';
    expect(questPlaces(gs.quests).map((p) => p.objectiveId)).toContain('sq_hobb_nest');
    expect(pick('hobb', gs)).toBe('dlg_hobb_sq_hobb_nest');
    gs.quests.side.sq_hobb = { status: 'active', stage: 0, objective: 1 };
    expect(pick('hobb', gs)).toBe('dlg_hobb_sq_hobb_report');
    gs.quests.side.sq_hobb = { status: 'done', stage: 0, objective: 1 };
    expect(pick('hobb', gs)).toBe('dlg_hobb_b0');
  });

  it('companions before joining: their Objective dialogue when current, else their default', () => {
    expect(pick('isla', at(fresh(), 'ms1_isla'))).toBe('dlg_isla_ms1_isla');
    expect(pick('isla', at(fresh(), 'ms1_maren'))).toBe('dlg_isla_default');
  });

  it('always returns one definition: a speaker without definitions gets a one-window fallback', () => {
    expect(selectDialogue('maren', fresh(), [])).toEqual(fallbackDialogue('maren'));
    expect(selectDialogue('kairen', fresh(), DIALOGUES).lines).toHaveLength(1);
  });

  it('never changes its inputs and gives the same answer for the same state', () => {
    const gs = at(fresh(), 'ms1_raid');
    const before = cloneGameState(gs);
    const defs = DIALOGUES.map((d) => ({ ...d }));
    const a = selectDialogue('maren', gs, defs);
    const b = selectDialogue('maren', gs, defs);
    expect(a).toBe(b);
    expect(gs).toEqual(before);
    expect(defs).toEqual(DIALOGUES);
  });

  it('property: the result matches its npc and conditions, and no candidate of a higher rank matches', () => {
    const objectiveIds = MAIN_QUEST.stages.flatMap((s) => s.objectives.map((o) => o.id));
    const flagNames = [...Object.values(SIDE_QUEST_FLAGS), 'none'];
    const speakers: Speaker[] = [...NPC_IDS, ...CHARACTER_IDS];
    fc.assert(
      fc.property(
        fc.constantFrom(...speakers), fc.constantFrom(...objectiveIds), fc.integer({ min: 0, max: 3 }), fc.boolean(),
        fc.subarray(flagNames), fc.subarray(DIALOGUES.map((d) => d.id)), fc.constantFrom('available', 'active', 'done'),
        (npc, objective, shards, completed, flags, seen, hobb) => {
          const gs = at(fresh(), objective);
          gs.skyshards = shards as 0 | 1 | 2 | 3;
          gs.gameCompleted = completed;
          for (const f of flags) gs.world.flags[f] = true;
          for (const id of seen) gs.world.flags[seenFlag(id)] = true;
          gs.quests.side.sq_hobb = { status: hobb as 'available' | 'active' | 'done', stage: 0, objective: 0 };
          const snapshot = cloneGameState(gs);
          const got = selectDialogue(npc, gs, DIALOGUES);
          expect(gs).toEqual(snapshot);
          const candidates = dialogueCandidates(npc, gs, DIALOGUES);
          if (candidates.length === 0) {
            expect(got.id).toBe(fallbackDialogue(npc).id);
            return;
          }
          expect(got.npc).toBe(npc);
          expect(candidates[0]).toBe(got);
          // Independent check of the conditions it claims.
          const w = got.when;
          if (w.bucket !== undefined) expect(w.bucket).toBe(completed ? 'post' : shards);
          if (w.flag !== undefined) expect(flagOn(gs, w.flag)).toBe(true);
          if (isOneShot(got)) expect(flagOn(gs, seenFlag(got.id))).toBe(false);
          const others = DIALOGUES.filter((d: DialogueDef) => d.npc === npc && dialogueRank(d) > dialogueRank(got));
          for (const d of others) expect(candidates.includes(d), d.id).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('window typing and advancing (Req 14.6)', () => {
  it('types 45 characters per second', () => {
    const text = '가'.repeat(90);
    expect(visibleChars(text, 0)).toBe(0);
    expect(visibleChars(text, 1)).toBe(45);
    expect(visibleChars(text, 1.5)).toBe(67);
    expect(visibleChars(text, 5)).toBe(90);
    expect(typingSeconds(text)).toBeCloseTo(2, 12);
  });

  it('an advance while typing completes the window; the next one moves on; after the last it ends', () => {
    const lines = [{ text: '가나다라마바사' }, { text: '아자차' }];
    let cursor: DialogueCursor = { line: 0, elapsed: 0.05, completed: false };
    const first = advanceDialogue(lines, cursor);
    expect(first).toEqual({ kind: 'complete', cursor: { line: 0, elapsed: 0.05, completed: true } });
    if (first.kind === 'end') throw new Error('ended');
    cursor = first.cursor;
    const second = advanceDialogue(lines, cursor);
    expect(second).toEqual({ kind: 'next', cursor: { line: 1, elapsed: 0, completed: false } });
    // Fully typed by time: the next press moves on (here, past the last window: the end).
    expect(advanceDialogue(lines, { line: 1, elapsed: 1, completed: false })).toEqual({ kind: 'end' });
  });

  it('every window types out within 90 / 45 = 2 s', () => {
    for (const d of DIALOGUES) for (const l of d.lines) expect(typingSeconds(l.text)).toBeLessThanOrEqual(2);
  });
});
