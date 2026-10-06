// Feature: skyshard-echoes-of-the-wild, Property 14: 퀘스트 단계 전이 규칙
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SIDE_QUEST_IDS } from '../../src/data/ids';
import { MAIN_QUEST } from '../../src/data/quests';
import { acceptSideQuest, initialQuestState, questReducer } from '../../src/logic/quest/questReducer';
import type { ObjectiveDef, ObjectiveTrigger, QuestDef, QuestEvent, QuestId, QuestState, StageDef } from '../../src/logic/quest/types';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const stage = (id: string, triggers: ObjectiveTrigger[]): StageDef => ({
  id,
  name: id,
  objectives: triggers.map((trigger, i): ObjectiveDef => ({ id: `${id}_${i}`, text: id, trigger, category: 'interact', marker: { kind: 'none' } })),
  onStart: [{ kind: 'spawnGroup', groupId: id }],
  onComplete: [{ kind: 'grant', reward: { xp: 10 } }, { kind: 'setFlag', flag: `${id}_done` }],
});

/** Synthetic main quest: adds `collect` thresholds and `flag` triggers, which table D does not use. */
const SYNTH_MAIN: QuestDef = {
  id: 'main',
  kind: 'main',
  stages: [
    stage('ms1', [{ kind: 'talk', npc: 'maren' }, { kind: 'defeat', groupId: 'raid' }]),
    stage('ms2', [{ kind: 'reach', areaId: 'mill' }, { kind: 'collect', itemId: 'mat_ore', count: 3 }, { kind: 'skyshard', index: 1 }]),
    stage('ms3', [{ kind: 'cinematic', cinematicId: 'cin_end' }, { kind: 'flag', flag: 'dawn' }]),
  ],
};
/** Side quest sharing `talk maren` / `solve pz_hollowroot_1` with table D and `defeat raid` with SYNTH_MAIN, so one event can advance both. */
const SIDE: QuestDef = {
  id: 'sq_hobb',
  kind: 'side',
  stages: [
    stage('hobb1', [{ kind: 'interact', targetId: 'kite' }, { kind: 'talk', npc: 'maren' }]),
    stage('hobb2', [{ kind: 'solve', puzzleId: 'pz_hollowroot_1' }, { kind: 'defeat', groupId: 'raid' }]),
  ],
};
/** Real Main_Quest content (cloned so freezing never touches the shared module) and the synthetic one. */
const DEF_SETS: readonly (readonly QuestDef[])[] = deepFreeze([[structuredClone(MAIN_QUEST), SIDE], [SYNTH_MAIN, SIDE]]);

// Independent restatement of the matching rule.
const TARGET = {
  talk: 'npc', reach: 'areaId', defeat: 'groupId', interact: 'targetId', solve: 'puzzleId',
  skyshard: 'index', cinematic: 'cinematicId', collect: 'itemId', flag: 'flag',
} as const satisfies Record<QuestEvent['kind'], string>;
const KINDS = Object.keys(TARGET) as QuestEvent['kind'][];
const targetOf = (t: ObjectiveTrigger): string => String((t as Record<string, unknown>)[TARGET[t.kind]]);
const hits = (t: ObjectiveTrigger, e: QuestEvent): boolean =>
  e.kind === t.kind && e.id === targetOf(t) && (t.kind !== 'collect' || (e.count ?? -Infinity) >= t.count);
const eventFor = (t: ObjectiveTrigger): QuestEvent => (t.kind === 'collect' ? { kind: t.kind, id: t.itemId, count: t.count } : { kind: t.kind, id: targetOf(t) });
const routeOf = (def: QuestDef): QuestEvent[] => def.stages.flatMap((s) => s.objectives.map((o) => eventFor(o.trigger)));

interface Position { stage: number; objective: number }
/** Objectives the rules allow to match: main unless done, a side quest only while 'active'. */
function activeObjectives(defs: readonly QuestDef[], s: QuestState): { quest: QuestId; trigger: ObjectiveTrigger }[] {
  return defs.flatMap((def) => {
    const side = def.id === 'main' ? null : s.side[def.id];
    const pos: Position | null = def.id === 'main' ? (s.main.done ? null : s.main) : side?.status === 'active' ? side : null;
    const o = pos && def.stages[pos.stage]?.objectives[pos.objective];
    return o ? [{ quest: def.id, trigger: o.trigger }] : [];
  });
}

/** Position after completing the current objective: next objective, else next stage's first, else done. */
function stepped(def: QuestDef, p: Position): Position & { done: boolean } {
  if (p.objective + 1 < def.stages[p.stage].objectives.length) return { stage: p.stage, objective: p.objective + 1, done: false };
  if (p.stage + 1 < def.stages.length) return { stage: p.stage + 1, objective: 0, done: false };
  return { stage: p.stage, objective: p.objective, done: true };
}

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

const arbPicks = fc.array(fc.boolean(), { maxLength: 100 });
const arbPrefix = (route: readonly QuestEvent[]): fc.Arbitrary<QuestEvent[]> =>
  fc.oneof(fc.constant(route.length), fc.integer({ min: 0, max: route.length })).map((k) => route.slice(0, k));

/**
 * arbQuestEvents: a prefix of the main route with a prefix of the side route and noise inserted at random
 * positions. Noise is any objective's event (skips, rewinds, repeats) or a random kind with a known or random
 * id and an optional count (wrong kind, near-miss collect counts, unknown ids).
 */
function arbQuestEvents(defs: readonly QuestDef[]): fc.Arbitrary<QuestEvent[]> {
  const pool = defs.flatMap(routeOf);
  const arbNoise: fc.Arbitrary<QuestEvent> = fc.oneof(
    fc.constantFrom(...pool),
    fc.record({
      kind: fc.constantFrom(...KINDS),
      id: fc.oneof(fc.constantFrom(...pool.map((e) => e.id)), fc.string({ maxLength: 4 })),
      count: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
    }),
  );
  return fc
    .tuple(arbPrefix(routeOf(defs[0])), arbPrefix(routeOf(SIDE)), fc.array(arbNoise, { maxLength: 20 }), arbPicks, arbPicks)
    .map(([main, side, noise, p1, p2]) => merge(merge(main, side, p1), noise, p2));
}

const arbScenario = fc.constantFrom(...DEF_SETS).chain((defs) =>
  fc.record({
    defs: fc.constant(defs),
    events: arbQuestEvents(defs),
    /** Index before which sq_hobb is accepted; null keeps it 'available' throughout. */
    acceptAt: fc.option(fc.oneof(fc.constant(0), fc.nat({ max: 20 })), { nil: null }),
  }),
);

describe('Property 14: quest stage transition rules', () => {
  it('the generator routes are the real trigger sequences (both quests complete when replayed)', () => {
    for (const defs of DEF_SETS) {
      let s = acceptSideQuest(initialQuestState(defs), 'sq_hobb');
      for (const e of merge(routeOf(defs[0]), routeOf(SIDE), [true, false, true, false, true, true])) s = questReducer(s, defs, e).state;
      expect(s.main.done).toBe(true);
      expect(s.side.sq_hobb.status).toBe('done');
    }
  });

  it('state changes only on a match with an active objective, activating the next one and moving main.stage by 0 or +1', () => {
    fc.assert(
      fc.property(arbScenario, ({ defs, events, acceptAt }) => {
        let s = deepFreeze(initialQuestState(defs));
        events.forEach((e, i) => {
          if (i === acceptAt) s = deepFreeze(acceptSideQuest(s, 'sq_hobb'));
          const matched = new Set(activeObjectives(defs, s).filter((a) => hits(a.trigger, e)).map((a) => a.quest));
          const r = questReducer(s, defs, e);
          expect(questReducer(s, defs, e)).toEqual(r); // deterministic; frozen inputs prove no mutation

          if (matched.size === 0) {
            // Rule 4 / Req 3.2: same state object and exactly one log effect.
            expect(r.state).toBe(s);
            expect(r.effects).toEqual([{ kind: 'log', message: expect.any(String) }]);
          } else {
            // Rules 1–2 / Req 3.1, 3.4: each matched quest completes its objective and activates the next in this call.
            expect(r.state).not.toBe(s);
            expect(r.effects.some((x) => x.kind === 'log')).toBe(false);
            expect(r.effects.filter((x) => x.kind === 'hud:objective')).toHaveLength(matched.size);
            const nowActive = new Set(activeObjectives(defs, r.state).map((a) => a.quest));
            for (const q of matched) {
              const def = defs.find((d) => d.id === q)!;
              const next = stepped(def, q === 'main' ? s.main : s.side[q]);
              expect(nowActive.has(q)).toBe(!next.done);
            }
          }

          const main = matched.has('main') ? stepped(defs[0], s.main) : s.main;
          expect(r.state.main).toEqual(main);
          for (const id of SIDE_QUEST_IDS) {
            const cur = s.side[id];
            const def = defs.find((d) => d.id === id);
            const next = def && matched.has(id) ? stepped(def, cur) : null;
            expect(r.state.side[id]).toEqual(next ? { status: next.done ? 'done' : 'active', stage: next.stage, objective: next.objective } : cur);
            expect([0, 1]).toContain(r.state.side[id].stage - cur.stage);
          }
          // Rule 7: one event never lowers main.stage and raises it by at most 1.
          expect([0, 1]).toContain(r.state.main.stage - s.main.stage);
          s = deepFreeze(r.state);
        });
      }),
      { numRuns: 200 },
    );
  });
});
