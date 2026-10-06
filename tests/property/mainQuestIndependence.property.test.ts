// Feature: skyshard-echoes-of-the-wild, Property 15: Side_Quest와 무관한 메인 진행
//
// For the real Main_Quest (table D) and synthetic Side_Quests under every registered SideQuestId:
// inserting Side_Quest events (plus accepts and tracking changes) anywhere between the main events
// leaves the final `main` equal to processing the main events alone, and equal to processing with
// all or some Side_Quest definitions removed from `defs` (Req 3.9, 15.5).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SIDE_QUEST_IDS, type SideQuestId } from '../../src/data/ids';
import { MAIN_QUEST } from '../../src/data/quests';
import { acceptSideQuest, initialQuestState, questReducer, setTracked } from '../../src/logic/quest/questReducer';
import type { ObjectiveDef, ObjectiveTrigger, QuestDef, QuestEvent, QuestId, QuestState, StageDef } from '../../src/logic/quest/types';

// Independent restatement of the trigger target (design "questReducer 규칙").
const TARGET = {
  talk: 'npc', reach: 'areaId', defeat: 'groupId', interact: 'targetId', solve: 'puzzleId',
  skyshard: 'index', cinematic: 'cinematicId', collect: 'itemId', flag: 'flag',
} as const satisfies Record<QuestEvent['kind'], string>;
const KINDS = Object.keys(TARGET) as QuestEvent['kind'][];
const targetOf = (t: ObjectiveTrigger): string => String((t as Record<string, unknown>)[TARGET[t.kind]]);
const eventFor = (t: ObjectiveTrigger): QuestEvent =>
  t.kind === 'collect' ? { kind: t.kind, id: targetOf(t), count: t.count } : { kind: t.kind, id: targetOf(t) };
const key = (e: QuestEvent): string => `${e.kind}:${e.id}`;

const MAIN_ROUTE: QuestEvent[] = MAIN_QUEST.stages.flatMap((s) => s.objectives.map((o) => eventFor(o.trigger)));
/** kind:target of every main Objective. An event outside this set matches none of them (whatever its count). */
const MAIN_KEYS = new Set(MAIN_ROUTE.map(key));
const hitsMain = (e: QuestEvent): boolean => MAIN_KEYS.has(key(e));

const stage = (id: string, triggers: readonly ObjectiveTrigger[]): StageDef => ({
  id,
  name: id,
  objectives: triggers.map((trigger, i): ObjectiveDef => ({ id: `${id}_${i}`, text: id, trigger, category: 'interact', marker: { kind: 'none' } })),
  onStart: [{ kind: 'spawnGroup', groupId: `${id}_group` }],
  onComplete: [{ kind: 'grant', reward: { xp: 20 } }, { kind: 'setFlag', flag: `${id}_done` }],
});

// Synthetic Side_Quests (the real ones arrive in task 13.3). Near misses reuse a main target under
// another kind (interact lm_elderbough, reach village_raid, interact durga, solve resonance_altar),
// and sq_tamsin / sq_hobb share one objective so a single event can advance both.
const SIDE_TRIGGERS: Readonly<Record<SideQuestId, readonly (readonly ObjectiveTrigger[])[]>> = {
  sq_tamsin: [
    [{ kind: 'talk', npc: 'tamsin' }, { kind: 'interact', targetId: 'lm_elderbough' }],
    [{ kind: 'reach', areaId: 'sq_shared_ridge' }, { kind: 'collect', itemId: 'mat_sq_kite', count: 1 }],
  ],
  sq_hobb: [
    [{ kind: 'talk', npc: 'hobb' }, { kind: 'reach', areaId: 'village_raid' }],
    [{ kind: 'reach', areaId: 'sq_shared_ridge' }, { kind: 'defeat', groupId: 'camp_verdant_1' }, { kind: 'flag', flag: 'sq_hobb_field' }],
  ],
  sq_durga: [
    [{ kind: 'interact', targetId: 'durga' }, { kind: 'cinematic', cinematicId: 'cin_sq_durga' }],
    [{ kind: 'solve', puzzleId: 'resonance_altar' }, { kind: 'solve', puzzleId: 'pz_ember_1' }, { kind: 'collect', itemId: 'mat_sq_ore', count: 3 }],
  ],
};
const SIDE_DEFS: QuestDef[] = SIDE_QUEST_IDS.map((id) => ({
  id,
  kind: 'side',
  stages: SIDE_TRIGGERS[id].map((triggers, i) => stage(`${id}_${i + 1}`, triggers)),
}));
const FULL: QuestDef[] = [MAIN_QUEST, ...SIDE_DEFS];
const MAIN_ONLY: QuestDef[] = [MAIN_QUEST];

type Op = { t: 'ev'; ev: QuestEvent } | { t: 'accept'; id: SideQuestId } | { t: 'track'; id: QuestId };
const evOp = (ev: QuestEvent): Op => ({ t: 'ev', ev });
const SIDE_EVENTS: QuestEvent[] = SIDE_QUEST_IDS.flatMap((id) => SIDE_TRIGGERS[id].flat().map(eventFor));
/** Accept, then every objective of the quest in order. */
const planOf = (id: SideQuestId): Op[] => [{ t: 'accept', id }, ...SIDE_TRIGGERS[id].flat().map((t) => evOp(eventFor(t)))];
const SIDE_PLANS: Readonly<Record<SideQuestId, readonly Op[]>> = {
  sq_tamsin: planOf('sq_tamsin'), sq_hobb: planOf('sq_hobb'), sq_durga: planOf('sq_durga'),
};

/** Order-preserving merge: while both remain, `picks[i]` takes the next item from `b`, otherwise from `a`. */
function merge<T>(a: readonly T[], b: readonly T[], picks: readonly boolean[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  for (const pick of picks) {
    if (pick && j < b.length) out.push(b[j++]);
    else if (i < a.length) out.push(a[i++]);
  }
  return [...out, ...a.slice(i), ...b.slice(j)];
}

function run(ops: readonly Op[], defs: readonly QuestDef[], start: QuestState): QuestState {
  let s = start;
  for (const op of ops) {
    if (op.t === 'accept') s = acceptSideQuest(s, op.id);
    else if (op.t === 'track') s = setTracked(s, op.id);
    else s = questReducer(s, defs, op.ev).state;
  }
  return s;
}

// arbQuestEvents + Side_Quest interleaving (design "속성 기반 테스트" generator table).
const ALL_IDS = [...new Set([...MAIN_ROUTE, ...SIDE_EVENTS].map((e) => e.id))];
const arbCount = fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined });
const arbPicks = fc.array(fc.boolean(), { maxLength: 80 });
const arbAnyEvent: fc.Arbitrary<QuestEvent> = fc.record({
  kind: fc.constantFrom(...KINDS),
  id: fc.oneof(fc.constantFrom(...ALL_IDS), fc.string({ maxLength: 4 })),
  count: arbCount,
});
/** Main sequence: a prefix of the table D route with skipped / rewound route events and random events merged in. */
const arbMainEvents: fc.Arbitrary<QuestEvent[]> = fc
  .tuple(
    fc.integer({ min: 0, max: MAIN_ROUTE.length }),
    fc.array(fc.oneof(fc.constantFrom(...MAIN_ROUTE), arbAnyEvent), { maxLength: 12 }),
    arbPicks,
  )
  .map(([k, noise, picks]) => merge(MAIN_ROUTE.slice(0, k), noise, picks));
/** Side_Quest events: side objectives in and out of order, near misses and random ids; never a main Objective. */
const arbSideEvent: fc.Arbitrary<QuestEvent> = fc.oneof(fc.constantFrom(...SIDE_EVENTS), arbAnyEvent).filter((e) => !hitsMain(e));
const arbSideNoise: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: arbSideEvent.map(evOp), weight: 3 },
  { arbitrary: fc.constantFrom(...SIDE_QUEST_IDS).map((id): Op => ({ t: 'accept', id })), weight: 1 },
  { arbitrary: fc.constantFrom<QuestId>('main', ...SIDE_QUEST_IDS).map((id): Op => ({ t: 'track', id })), weight: 1 },
);
/** A prefix of each side plan, merged with each other and with side noise. */
const arbSideOps: fc.Arbitrary<Op[]> = fc
  .tuple(
    fc.array(fc.nat(), { minLength: SIDE_QUEST_IDS.length, maxLength: SIDE_QUEST_IDS.length }),
    fc.array(arbSideNoise, { maxLength: 12 }),
    fc.array(arbPicks, { minLength: SIDE_QUEST_IDS.length, maxLength: SIDE_QUEST_IDS.length }),
  )
  .map(([cuts, noise, picks]) => {
    const parts = [...SIDE_QUEST_IDS.map((id, i) => SIDE_PLANS[id].slice(0, cuts[i] % (SIDE_PLANS[id].length + 1))), noise];
    return parts.slice(1).reduce((acc, part, i) => merge(acc, part, picks[i]), parts[0]);
  });

describe('Property 15: main progress is independent of Side_Quests', () => {
  it('synthetic Side_Quest objectives never share a main Objective, and full interleaved routes complete everything', () => {
    for (const e of SIDE_EVENTS) expect(hitsMain(e), key(e)).toBe(false);
    const side = SIDE_QUEST_IDS.map((id) => SIDE_PLANS[id]).reduce((acc, plan) => merge(acc, plan, [true, false, true]));
    const mainOps = MAIN_ROUTE.map(evOp);
    const s = run(merge(mainOps, side, Array.from({ length: 60 }, (_, i) => i % 3 === 0)), FULL, initialQuestState(FULL));
    expect(s.main).toEqual(run(mainOps, MAIN_ONLY, initialQuestState(MAIN_ONLY)).main);
    expect(s.main.done).toBe(true);
    for (const id of SIDE_QUEST_IDS) expect(s.side[id].status, id).toBe('done');
  });

  it('inserted Side_Quest events and removed Side_Quest definitions leave the final main state unchanged', () => {
    let mainAdvanced = 0;
    let sideAdvanced = 0;
    fc.assert(
      fc.property(arbMainEvents, arbSideOps, arbPicks, fc.subarray([...SIDE_QUEST_IDS]), (mainEvents, sideOps, picks, kept) => {
        for (const op of sideOps) if (op.t === 'ev') expect(hitsMain(op.ev)).toBe(false);
        const mainOps = mainEvents.map(evOp);
        const merged = merge(mainOps, sideOps, picks);
        const expected = run(mainOps, FULL, initialQuestState(FULL)).main;

        const withSide = run(merged, FULL, initialQuestState(FULL));
        expect(withSide.main).toEqual(expected); // side events inserted
        expect(run(mainOps, MAIN_ONLY, initialQuestState(MAIN_ONLY)).main).toEqual(expected); // side definitions removed
        // Side entries accepted from a full start but lacking a definition never take part in matching.
        expect(run(merged, MAIN_ONLY, initialQuestState(FULL)).main).toEqual(expected);
        const partial = [MAIN_QUEST, ...SIDE_DEFS.filter((d) => (kept as QuestId[]).includes(d.id))];
        expect(run(merged, partial, initialQuestState(partial)).main).toEqual(expected); // some removed (Req 15.5)

        if (expected.stage > 0 || expected.objective > 0) mainAdvanced++;
        if (SIDE_QUEST_IDS.some((id) => withSide.side[id].stage > 0 || withSide.side[id].status === 'done')) sideAdvanced++;
      }),
      { numRuns: 200, seed: 1515 },
    );
    // Guard against a vacuous pass: main and side quests both progress in a good share of the runs.
    expect(mainAdvanced).toBeGreaterThanOrEqual(50);
    expect(sideAdvanced).toBeGreaterThanOrEqual(50);
  });
});
