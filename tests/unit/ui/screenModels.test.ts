import { describe, expect, it } from 'vitest';
import { titleCameraRig } from '../../../src/camera/titleOrbit';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import type { ObjectiveView } from '../../../src/quest/questSystem';
import {
  clampSkyshards,
  defeatOptions,
  defeatText,
  formatPlayTime,
  formatSkyshards,
  objectiveLines,
  titleMenuItems,
  victoryMenuItems,
  victoryRankRows,
  victoryStatRows,
} from '../../../src/ui/screenModels';
import { buildVictoryView, completedQuestCount } from '../../../src/ui/victoryView';

const HANGUL = /[\uac00-\ud7a3]/;

describe('Title menu', () => {
  it('offers 새로 시작 and 이어하기, with Continue disabled and explained when there is no save (Req 31.3)', () => {
    expect(titleMenuItems(false)).toEqual([
      { id: 'newGame', label: '새로 시작', disabledReason: null },
      { id: 'continue', label: '이어하기', disabledReason: '저장 데이터 없음' },
    ]);
    expect(titleMenuItems(true).map((i) => i.disabledReason)).toEqual([null, null]);
  });
});

describe('HUD text', () => {
  it('shows the Skyshard progress as "Skyshard n/3", clamped to 0–3', () => {
    expect([0, 1, 2, 3].map(formatSkyshards)).toEqual(['Skyshard 0/3', 'Skyshard 1/3', 'Skyshard 2/3', 'Skyshard 3/3']);
    expect([clampSkyshards(5), clampSkyshards(-1), clampSkyshards(Number.NaN), clampSkyshards(2.7)]).toEqual([3, 0, 0, 2]);
  });

  it('shows the tracked objective with its stage name, and nothing once no objective is left', () => {
    const view = {
      questId: 'main',
      stageId: 'ms1',
      stageName: '방랑자의 도착',
      objective: { id: 'ms1_maren', text: '광장의 Elder Maren과 이야기하기' },
    } as ObjectiveView;
    expect(objectiveLines(view)).toEqual({ stage: '방랑자의 도착', text: '광장의 Elder Maren과 이야기하기' });
    expect(objectiveLines(null)).toBeNull();
  });
});

describe('Defeat choices', () => {
  it('offers one restart after a normal wipe (Req 27.3) and the two Caelith options in the boss fight (Req 6.13)', () => {
    expect(defeatOptions(null)).toEqual([{ id: 'respawn', label: '마지막 부활 지점에서 다시 시작', disabledReason: null }]);
    expect(defeatOptions(3).map((o) => [o.id, o.label])).toEqual([
      ['retryPhase', '현재 Phase부터 재도전'],
      ['returnToWaystone', 'Waystone으로 돌아가기'],
    ]);
    expect(defeatText(null)).toMatch(HANGUL);
    expect(defeatText(2)).toContain('Phase 2');
  });
});

describe('Victory Screen', () => {
  const played = (): GameState => {
    const gs = createNewGameState(7);
    gs.party.level = 8;
    gs.party.upgrades.kairen = { skill: 2, burst: 1 };
    gs.stats.enemiesDefeated = 41;
    gs.discovery.landmarks = ['lm_elderbough', 'lm_breezewatch'];
    gs.discovery.pois = ['poi_verdant_1'];
    gs.world.chests = ['chest_verdant_1', 'chest_ember_2'];
    gs.quests.side.sq_tamsin.status = 'done';
    return gs;
  };

  it('builds the view from the live state and content totals before the completion record exists', () => {
    const view = buildVictoryView(played(), { playTimeSec: 1507.9, placesTotal: 20, chestsTotal: 12 });
    expect(view).toEqual({
      playTimeSec: 1507,
      enemiesDefeated: 41,
      questsCompleted: 1,
      partyLevel: 8,
      places: { found: 3, total: 20 },
      chests: { found: 2, total: 12 },
      abilityRanks: {
        kairen: { skill: 2, burst: 1 },
        isla: { skill: 0, burst: 0 },
        wren: { skill: 0, burst: 0 },
        talus: { skill: 0, burst: 0 },
      },
      debugUsed: false,
    });
  });

  it('uses the saved completion record and always reports Debug_Tools use (Req 7.6, 7.7)', () => {
    const gs = played();
    gs.debugUsed = true;
    gs.victory = {
      playTimeSec: 1700,
      enemiesDefeated: 60,
      places: [9, 20],
      quests: 3,
      chests: [7, 12],
      level: 9,
      upgrades: { kairen: 3, isla: 0, wren: 0, talus: 0 },
    };
    const view = buildVictoryView(gs, { playTimeSec: 99, placesTotal: 1, chestsTotal: 1 });
    expect(view).toMatchObject({
      playTimeSec: 1700,
      enemiesDefeated: 60,
      questsCompleted: 3,
      partyLevel: 9,
      places: { found: 9, total: 20 },
      chests: { found: 7, total: 12 },
      debugUsed: true,
    });
    expect(view.abilityRanks.kairen).toEqual({ skill: 2, burst: 1 });
  });

  it('counts the Main_Quest once done plus finished Side_Quests', () => {
    const gs = played();
    expect(completedQuestCount(gs.quests)).toBe(1);
    gs.quests.main.done = true;
    expect(completedQuestCount(gs.quests)).toBe(2);
  });

  it('lists every Req 7.3 statistic in Korean with the ranks per character, and offers 탐험 계속 / 메인 메뉴', () => {
    const view = buildVictoryView(played(), { playTimeSec: 1507, placesTotal: 20, chestsTotal: 12 });
    expect(victoryStatRows(view)).toEqual([
      { label: '플레이 시간', value: '25분 7초' },
      { label: '처치한 적', value: '41' },
      { label: '발견한 장소', value: '3/20' },
      { label: '완료한 퀘스트', value: '1' },
      { label: '발견한 Chest', value: '2/12' },
      { label: '최종 파티 레벨', value: 'Lv. 8' },
    ]);
    expect(victoryRankRows(view)[0]).toEqual({ label: 'Kairen', value: 'Skill 2단계 · Burst 1단계' });
    expect(victoryRankRows(view).map((r) => r.label)).toEqual(['Kairen', 'Isla', 'Wren', 'Talus']);
    expect(victoryMenuItems().map((i) => [i.id, i.label])).toEqual([
      ['continueExploring', '탐험 계속'],
      ['mainMenu', '메인 메뉴'],
    ]);
  });

  it('formats play time in hours, minutes and seconds', () => {
    expect([0, 42, 1507, 3723, -5, Number.NaN].map(formatPlayTime)).toEqual(['0초', '42초', '25분 7초', '1시간 2분 3초', '0초', '0초']);
  });
});

describe('Title camera', () => {
  it('stays above the ground, sits beyond Thistlewick from the crater and looks toward it', () => {
    const village = LOCATIONS.thistlewick;
    for (const t of [0, 7.5, 15, 30, 45]) {
      const rig = titleCameraRig(t, () => 100);
      expect(rig.position.y).toBeGreaterThanOrEqual(112); // clearance over a high ground stand-in
      const camDist = Math.hypot(rig.position.x, rig.position.z);
      const lookDist = Math.hypot(rig.lookAt.x, rig.lookAt.z);
      expect(camDist).toBeGreaterThan(Math.hypot(village.x, village.z)); // behind the village
      expect(lookDist).toBeLessThan(Math.hypot(village.x, village.z)); // looking toward the crater
      expect(Number.isFinite(rig.position.x + rig.position.z + rig.lookAt.y)).toBe(true);
    }
    expect(titleCameraRig(0).position.y).toBe(village.groundY + 30);
  });
});
