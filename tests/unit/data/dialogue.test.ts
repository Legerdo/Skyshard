import { describe, expect, it } from 'vitest';
import {
  BASE_DIALOGUES, DIALOGUE_BUCKETS, DIALOGUE_RULES, DIALOGUES, SIDE_QUEST_DIALOGUES, SPEAKER_VOICE_HZ, STAGE_BRIEFINGS, STAGE_DIALOGUES,
  dialogueDefsFor, speakerName, type DialogueDef,
} from '../../../src/data/dialogue';
import { CHARACTER_IDS, MAIN_STAGE_IDS, NPC_IDS, SIDE_QUEST_IDS } from '../../../src/data/ids';
import { MAIN_QUEST, QUESTS, SQ_HOBB } from '../../../src/data/quests';
import { isMainStoryDialogue, windowLimit } from '../../../src/logic/dialogue';

// Dialogue content (task 13.1; Req 3.8, 14.5, 14.7, 35.4, 37.7).

const HANGUL = /[\uAC00-\uD7A3]/;
const textOf = (d: DialogueDef): string => d.lines.map((l) => l.text).join('\n');
const allLines = [...DIALOGUES.flatMap((d) => d.lines), ...STAGE_DIALOGUES.flatMap((d) => d.lines)];

describe('named NPC dialogues (Req 14.7)', () => {
  it.each(NPC_IDS)('%s has a default dialogue and one per bucket 0, 1, 2, 3 and post, all different', (npc) => {
    const mine = DIALOGUES.filter((d) => d.npc === npc);
    const plain = mine.filter((d) => Object.keys(d.when).length === 0);
    expect(plain, 'one default').toHaveLength(1);
    const buckets = DIALOGUE_BUCKETS.map((bucket) => mine.filter((d) => d.when.bucket === bucket && Object.keys(d.when).length === 1));
    for (const [i, list] of buckets.entries()) expect(list, `bucket ${String(DIALOGUE_BUCKETS[i])}`).toHaveLength(1);
    const texts = [plain[0], ...buckets.map((l) => l[0])].map((d) => (d === undefined ? '' : textOf(d)));
    expect(new Set(texts).size).toBe(6);
  });

  it('are the seven named NPCs of the design', () => {
    expect([...NPC_IDS]).toEqual(['maren', 'pip', 'bram', 'tamsin', 'hobb', 'durga', 'oriel']);
  });
});

describe('dialogue limits (Req 14.4, 14.5)', () => {
  it('every window text fits the three-line window: 1–90 characters', () => {
    for (const line of allLines) {
      expect(line.text.length, line.text).toBeGreaterThan(0);
      expect(line.text.length, line.text).toBeLessThanOrEqual(DIALOGUE_RULES.maxTextLength);
    }
  });

  it('ordinary dialogues have at most 6 windows, main-story ones (questStage of a Main_Quest stage or Objective) at most 10', () => {
    for (const d of DIALOGUES) {
      expect(d.lines.length, d.id).toBeGreaterThan(0);
      expect(d.lines.length, d.id).toBeLessThanOrEqual(windowLimit(d));
      if (!isMainStoryDialogue(d)) expect(d.lines.length, d.id).toBeLessThanOrEqual(6);
    }
    expect(windowLimit({ when: { questStage: 'ms1_maren' } })).toBe(10);
    expect(windowLimit({ when: { questStage: 'ms4' } })).toBe(10);
    expect(windowLimit({ when: { questStage: 'sq_tamsin_kite' } })).toBe(6);
    expect(windowLimit({ when: { bucket: 2 } })).toBe(6);
    // Stage briefings brief a Main_Quest stage: the story cap.
    for (const d of STAGE_DIALOGUES) expect(d.lines.length, d.id).toBeLessThanOrEqual(DIALOGUE_RULES.maxStoryWindows);
  });

  it('ids are unique and every speaker is a named NPC or a companion with a display name', () => {
    const ids = [...DIALOGUES.map((d) => d.id), ...STAGE_DIALOGUES.map((d) => d.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const speakers = new Set<string>([...NPC_IDS, ...CHARACTER_IDS]);
    for (const d of DIALOGUES) expect(speakers.has(d.npc), d.id).toBe(true);
    for (const line of allLines) {
      expect(speakers.has(line.speaker), line.text).toBe(true);
      expect(speakerName(line.speaker).length).toBeGreaterThan(0);
    }
  });

  it('is written in Korean with English proper nouns (Req 35.4)', () => {
    for (const line of allLines) expect(HANGUL.test(line.text), line.text).toBe(true);
    const text = allLines.map((l) => l.text).join(' ');
    for (const name of ['Skyshard', 'Breezewatch', 'Elderbough', 'Cinderspire', 'Ember', 'Gale', 'Terra', 'Maren', 'Isla']) expect(text).toContain(name);
    for (const translated of ['스카이샤드', '브리즈워치', '엠버', '이슬라']) expect(text).not.toContain(translated);
  });
});

describe('quest dialogues (Req 3.8)', () => {
  const stageAndObjectiveIds = new Set(QUESTS.flatMap((q) => q.stages.flatMap((s) => [s.id, ...s.objectives.map((o) => o.id)])));

  it('every questStage names a quest stage or Objective id', () => {
    for (const d of DIALOGUES) if (d.when.questStage !== undefined) expect(stageAndObjectiveIds.has(d.when.questStage), d.id).toBe(true);
  });

  it('every Main_Quest stage is briefed: a stage-start dialogue, or (ms2) Elder Maren\'s ms1 report', () => {
    expect(Object.keys(STAGE_BRIEFINGS).sort()).toEqual([...MAIN_STAGE_IDS].sort());
    const known = new Set([...DIALOGUES.map((d) => d.id), ...STAGE_DIALOGUES.map((d) => d.id)]);
    for (const stage of MAIN_STAGE_IDS) expect(known.has(STAGE_BRIEFINGS[stage]), stage).toBe(true);
    for (const d of STAGE_DIALOGUES) expect(STAGE_BRIEFINGS[d.stage]).toBe(d.id);
    expect(STAGE_BRIEFINGS.ms2).toBe('dlg_maren_ms1_report');
  });

  it('every Main_Quest talk Objective has its NPC\'s dialogue for that Objective', () => {
    for (const stage of MAIN_QUEST.stages) {
      for (const o of stage.objectives) {
        if (o.trigger.kind !== 'talk') continue;
        const npc = o.trigger.npc;
        expect(DIALOGUES.some((d) => d.npc === npc && d.when.questStage === o.id), o.id).toBe(true);
      }
    }
  });

  it('companions join through their talk dialogue\'s onEnd', () => {
    for (const c of ['isla', 'wren', 'talus'] as const) {
      const join = DIALOGUES.filter((d) => d.onEnd?.some((e) => e.kind === 'joinParty' && e.character === c));
      expect(join.map((d) => d.npc), c).toEqual([c]);
    }
  });

  it('each Side_Quest has an accepting offer, its Objective reminders and a hand-in, and none leaks into the base set', () => {
    for (const id of SIDE_QUEST_IDS) {
      const branch = SIDE_QUEST_DIALOGUES[id];
      const offers = branch.filter((d) => d.onEnd?.some((e) => e.kind === 'acceptQuest' && e.quest === id));
      expect(offers, id).toHaveLength(1);
      expect(offers[0]?.when.sideQuest).toEqual({ id, status: 'available' });
      const def = QUESTS.find((q) => q.id === id);
      for (const o of def?.stages.flatMap((s) => s.objectives) ?? []) {
        expect(branch.some((d) => d.when.questStage === o.id), o.id).toBe(true);
      }
      for (const d of branch) expect(BASE_DIALOGUES.includes(d)).toBe(false);
    }
    // Dropping a Side_Quest's definition drops its dialogue branches (Req 15.5).
    const withoutHobb = dialogueDefsFor(QUESTS.filter((q) => q !== SQ_HOBB));
    expect(withoutHobb.some((d) => SIDE_QUEST_DIALOGUES.sq_hobb.includes(d))).toBe(false);
    expect(SIDE_QUEST_DIALOGUES.sq_tamsin.every((d) => withoutHobb.includes(d))).toBe(true);
  });
});

describe('voice blips (Req 37.7)', () => {
  it('gives the 7 named NPCs and 4 companions 11 different pitches', () => {
    const speakers = [...NPC_IDS, ...CHARACTER_IDS];
    expect(speakers).toHaveLength(11);
    const pitches = speakers.map((s) => SPEAKER_VOICE_HZ[s]);
    for (const hz of pitches) expect(hz).toBeGreaterThan(60);
    expect(new Set(pitches).size).toBe(11);
  });
});
