// XP data test (design "메인 진행만의 레벨 검증", Req 29.1, 29.3): the main-path XP before ms9 recomputed from the
// encounter, Elite and quest data must reach level 7, and all content must reach level 10 (3,000 XP).
import { describe, expect, it } from 'vitest';
import { ELITE_IDS, LANDMARK_IDS, SIDE_QUEST_IDS, WAYSTONE_IDS } from '../../../src/data/ids';
import { AVOIDABLE_MAIN_PATH_GROUPS, XP_SOURCES } from '../../../src/data/progression';
import { SPAWNERS } from '../../../src/data/spawns';
import { MAX_XP, levelFromXp } from '../../../src/logic/progression';
import { contentXp, groupXp, mainPathGroups, mainPathXpLines, xpSum } from '../helpers/xpBudget';

describe('main-path XP before ms9 (Req 29.3)', () => {
  const lines = mainPathXpLines();

  it('reads the encounter groups, guardian Elites and stage grants from the data', () => {
    const groups = mainPathGroups();
    for (const id of ['village_raid', 'hollowroot_room', 'rootboundWarden', 'cinderAlpha', 'sentinelPrime', ...AVOIDABLE_MAIN_PATH_GROUPS]) {
      expect(groups, id).toContain(id);
    }
    expect(groupXp('rootboundWarden') + groupXp('cinderAlpha') + groupXp('sentinelPrime')).toBe(550);
    expect(xpSum(lines.filter((l) => l.label.startsWith('단계 완료')))).toBe(660); // ms1–ms8 grants in the quest data
    expect(lines.every((l) => Number.isFinite(l.xp) && l.xp >= 0)).toBe(true);
  });

  it('reaches level 7 from the unavoidable fights and stage grants alone', () => {
    const required = xpSum(lines.filter((l) => !l.avoidable));
    expect(required).toBeGreaterThanOrEqual(1500);
    expect(levelFromXp(required)).toBeGreaterThanOrEqual(7);
  });

  it('reaches at least level 7 with the avoidable packs, route discoveries and route Chests', () => {
    const total = xpSum(lines);
    expect(levelFromXp(total)).toBeGreaterThanOrEqual(7);
    expect(total).toBeGreaterThan(xpSum(lines.filter((l) => !l.avoidable)));
  });
});

describe('all content XP reaches level 10 (Req 29.1)', () => {
  const content = contentXp();

  it('counts every placed enemy, quest grant, Landmark, Waystone, puzzle and Chest that exists', () => {
    const byLabel = new Map(content.lines.map((l) => [l.label, l.xp]));
    expect(byLabel.get('적·Elite 처치 (배치된 전부)')).toBeGreaterThanOrEqual(954); // the route and Challenge_Area fights
    expect(byLabel.get('Main_Quest 단계')).toBe(660);
    expect(byLabel.get('첫 발견: Landmark')).toBe(LANDMARK_IDS.length * 20);
    expect(byLabel.get('첫 발견: Waystone')).toBe(WAYSTONE_IDS.length * 15);
    expect(content.total).toBe(xpSum(content.lines));
  });

  it('the design content plan (minimum POI table) is worth at least 3,000 XP', () => {
    // Content still arriving is counted at the design minimum: 3 Side_Quests, the 3 hidden Elites, 20 Chests
    // (6 camp Chests fine, one glowing high Chest per main Region, the rest common), 9 Echo_Tablets, 3 Vista_Points,
    // 3 hidden places and 11 lore stones (design "Region별 최소 수량").
    const { chest, discovery, elite, sideQuest } = XP_SOURCES;
    const placedElites = new Set(SPAWNERS.map((s) => s.kind));
    const hiddenElites = ELITE_IDS.filter((id) => !placedElites.has(id)).reduce((t, id) => t + elite[id], 0);
    const content2 = contentXp();
    const existing = xpSum(content2.lines.filter((l) => !l.label.startsWith('Side_Quest') && !l.label.startsWith('Chest')));
    const planned = existing
      + SIDE_QUEST_IDS.length * sideQuest
      + hiddenElites
      + 6 * chest.fine + 3 * chest.glowing + 11 * chest.common
      + (content2.poisLoaded ? 0 : 9 * discovery.tablet + 3 * discovery.vista + 3 * discovery.hidden + 11 * discovery.lore);
    expect(planned).toBeGreaterThanOrEqual(MAX_XP);
  });

  // Runs once src/data/pois.ts exists (POI content, task 13): the content that exists must reach level 10.
  it.runIf(content.poisLoaded)('with the POI content in place, the XP of all content is at least 3,000', () => {
    expect(content.total).toBeGreaterThanOrEqual(MAX_XP);
    expect(levelFromXp(content.total)).toBe(10);
  });
});
