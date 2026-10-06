import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_AREA_NAMES, LANDMARK_NAMES, MAIN_STAGE_IDS, MAIN_STAGE_NAMES, REGION_NAMES, isCharacterId, isNpcId,
} from '../../../src/data/ids';
import { XP_SOURCES } from '../../../src/data/progression';
import { MAIN_QUEST, QUESTS } from '../../../src/data/quests';
import { LOCATIONS, type LocationDef } from '../../../src/data/worldLayout';
import type { ObjectiveDef } from '../../../src/logic/quest/types';

// Data rules for the Main_Quest (design "questReducer 규칙" 8–9, "Objective 표시와 탐색 구역", table D).

/** Direction cues: Landmark and place names, then environment elements named in table D. */
const PLACE_NAMES = [
  ...Object.values(LANDMARK_NAMES), ...Object.values(REGION_NAMES), ...Object.values(CHALLENGE_AREA_NAMES),
  'Thistlewick', 'Ashgate', 'Resonance Altar', 'Starlit Stair',
];
const ENVIRONMENT_CUES = [
  '광장', '망루', '밭', '절벽', '풍차', '고목', '뿌리', '덤불', '바람개비', '압력판', '바위', '고개', '협곡', '다리', '야영지', '연기',
  '첨탑', '발판', '분출구', '수정', '정상', '크레이터', '망원경', '강풍', '능선', '관측소', '대전당', '별자리', '받침대', '회랑', '돔',
  '빛기둥', '벽화', '전당',
];

const objectives = (): ObjectiveDef[] => MAIN_QUEST.stages.flatMap((s) => [...s.objectives]);

/** The three search Objectives table D marks `zone r 60`, and the goal each must contain. */
const SEARCH_GOALS: Readonly<Record<string, LocationDef>> = {
  ms2_breezewatch: LOCATIONS.breezewatch,
  ms4_durga: LOCATIONS.camp_durga,
  ms6_oriel: LOCATIONS.camp_oriel,
};

describe('Main_Quest data', () => {
  it('is the first quest and has the ten stages ms1–ms10 in order with their registry names', () => {
    expect(QUESTS[0]).toBe(MAIN_QUEST);
    expect([MAIN_QUEST.id, MAIN_QUEST.kind]).toEqual(['main', 'main']);
    expect(MAIN_QUEST.stages.map((s) => s.id)).toEqual([...MAIN_STAGE_IDS]);
    expect(MAIN_QUEST.stages).toHaveLength(10);
    expect(MAIN_QUEST.stages.map((s) => s.name)).toEqual(MAIN_STAGE_IDS.map((id) => MAIN_STAGE_NAMES[id]));
  });

  it('gives every stage at least 2 Objectives and at least 2 categories (Req 3.3)', () => {
    for (const stage of MAIN_QUEST.stages) {
      expect(stage.objectives.length, stage.id).toBeGreaterThanOrEqual(2);
      expect(new Set(stage.objectives.map((o) => o.category)).size, stage.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('names a Landmark or environment cue in every Objective text (Req 3.7)', () => {
    const cues = [...PLACE_NAMES, ...ENVIRONMENT_CUES];
    const missing = objectives().filter((o) => !cues.some((cue) => o.text.includes(cue)));
    expect(missing.map((o) => `${o.id}: ${o.text}`)).toEqual([]);
  });

  it('uses unique, stage-prefixed Objective ids and registry ids for talk targets', () => {
    const ids = objectives().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const stage of MAIN_QUEST.stages) {
      for (const o of stage.objectives) expect(o.id.startsWith(`${stage.id}_`), o.id).toBe(true);
    }
    const talks = objectives().flatMap((o) => (o.trigger.kind === 'talk' ? [o.trigger.npc] : []));
    expect(talks.filter((npc) => !isNpcId(npc) && !isCharacterId(npc))).toEqual([]);
    const shards = MAIN_QUEST.stages.flatMap((s) => s.objectives.flatMap((o) => (o.trigger.kind === 'skyshard' ? [[s.id, o.trigger.index]] : [])));
    expect(shards).toEqual([['ms3', 1], ['ms5', 2], ['ms7', 3]]);
  });

  it('marks the three search Objectives with r ≥ 60 zones that contain the goal off-centre, the rest exact or none', () => {
    const zones = objectives().filter((o) => o.marker.kind === 'zone');
    expect(zones.map((o) => o.id)).toEqual(Object.keys(SEARCH_GOALS));
    for (const o of zones) {
      if (o.marker.kind !== 'zone') continue;
      const goal = SEARCH_GOALS[o.id];
      const d = Math.hypot(goal.x - o.marker.center.x, goal.z - o.marker.center.z);
      expect(o.marker.radius).toBeGreaterThanOrEqual(60);
      expect(d, o.id).toBeGreaterThan(0);
      expect(d, o.id).toBeLessThan(o.marker.radius);
    }
    for (const o of objectives()) {
      if (o.marker.kind === 'exact') expect([o.marker.pos.x, o.marker.pos.y, o.marker.pos.z].every(Number.isFinite), o.id).toBe(true);
      if (o.marker.kind === 'none') expect(o.trigger.kind, o.id).toBe('cinematic');
    }
  });

  it('grants the stage XP on completion and nothing else from the stage effects', () => {
    for (const stage of MAIN_QUEST.stages) {
      const xp = XP_SOURCES.stage[stage.id as keyof typeof XP_SOURCES.stage];
      expect(stage.onComplete, stage.id).toEqual(xp === undefined ? [] : [{ kind: 'grant', reward: { xp } }]);
      expect(stage.onStart.every((e) => e.kind === 'spawnGroup'), stage.id).toBe(true);
    }
  });
});
