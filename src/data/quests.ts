/*
 * Quest content (design.md "Main_Quest 단계", table D; "Objective 표시와 탐색 구역"). Read-only data:
 * only the progress (`QuestState`) is saved. The Side_Quests (sq_tamsin, sq_hobb, sq_durga) join
 * `QUESTS` in task 13.3.
 *
 * - Every Main_Quest stage has at least 3 Objectives over at least two categories (Req 3.3), and
 *   every Objective text names a Landmark or an environment element as a direction cue (Req 3.7).
 * - Trigger targets are the ids the World, Puzzle, Combat and Cinematic systems publish:
 *   `reach` = `'area:entered'` areaId, `defeat` = encounter group / Elite / boss id of
 *   `'camp:cleared'` or `'boss:defeated'`, `solve` = puzzleId, `interact` = interact targetId
 *   (`resonance_altar` comes from `'altar:activated'`), `cinematic` = cinematicId.
 * - ms3 ⑤ ("defeat hollowroot_room + rootboundWarden" in table D) is split into two Objectives,
 *   one per trigger, so each group completes its own step.
 * - Companion joins (Isla ms1 ②, Wren ms2 ③, Talus ms3 ①) are not stage effects: the companion's
 *   dialogue applies `joinParty` through its `onEnd` (DialogueDef, same effect path as the reducer)
 *   before `'dialogue:ended'` completes the `talk` Objective. The join cinematics follow
 *   `'party:joined'`, the Skyshard, altar, boss-intro and ending cinematics follow their own events,
 *   so no stage starts them itself.
 * - Stage effects: `onComplete` grants the stage XP (ms1–ms8, `XP_SOURCES.stage`; ms9 and ms10
 *   grant none); `onStart` spawns the stage's open-world encounter groups. Groups inside
 *   Challenge_Areas (Hollowroot room, Observatory waves, guardian Elites) are activated by the area.
 * - Markers: `zone` (r 60, centre offset from the goal, goal inside) for the three search Objectives
 *   of table D (ms2 ①, ms4 ③, ms6 ②), `none` for the ending cinematic, `exact` otherwise. Points
 *   inside Challenge_Areas come from the area data (src/data/challengeAreas.ts: checkpoint runes, the Observatory's
 *   hall, ring corridor and dome); points on routes are approximate.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */
import type { Vec3 } from '../core/types';
import type {
  ObjectiveCategory, ObjectiveDef, ObjectiveMarker, ObjectiveTrigger, QuestDef, QuestEffect, RewardRef, StageDef,
} from '../logic/quest/types';
import { OBSERVATORY_SPOTS, checkpointById } from './challengeAreas';
import { SIDE_QUEST_FLAGS } from './dialogue';
import { MAIN_STAGE_NAMES, SIDE_QUEST_NAMES, type MainStageId, type SideQuestId } from './ids';
import { XP_SOURCES } from './progression';
import { DURGA_BRAZIERS_PUZZLE, HOBB_NEST_CAMP, HOBB_NEST_POS, KITE_POS, KITE_TARGET_ID } from './sideQuests';
import { LOCATIONS, type LocationId } from './worldLayout';

// ── Places ──────────────────────────────────────────────────────────────────

/** Key location standing point: (x, z) and the walkable height from the layout table. */
const at = (id: LocationId): Vec3 => ({ x: LOCATIONS[id].x, y: LOCATIONS[id].groundY, z: LOCATIONS[id].z });

/** A Challenge_Area checkpoint rune's centre (src/data/challengeAreas.ts). */
function checkpointSpot(id: string): Vec3 {
  const found = checkpointById(id);
  if (found === null) throw new Error(`quests: no checkpoint ${id}`);
  return { ...found.checkpoint.spot.pos };
}

/**
 * Objective points not in the layout table. Thistlewick spots are offsets from the village centre
 * (−250, 300) in the design's Thistlewick section; the rest lie between the table's locations.
 */
export const QUEST_SPOTS = {
  /** Plaza centre, where Elder Maren stands. */
  plaza: { x: -250, y: 18, z: 300 },
  /** Foot of the 10 m watchtower, (+30, +32) from the centre. */
  watchtower: { x: -220, y: 18, z: 332 },
  /** Hobb's east field, (+50, +20) from the centre: where the village raid attacks. */
  eastField: { x: -200, y: 18, z: 320 },
  /** Hollowroot sinkhole floor (y −10) under the root arch: rooms R1–R6. */
  hollowrootShrine: { x: -228, y: -10, z: 128 },
  /** East rim of the 30 m broken-bridge chasm, toward camp_durga. */
  bridgeFarSide: { x: 188, y: 12, z: 253 },
  /** Canyon pass between ws_ember and cinderspire_base. */
  emberPass: { x: 290, y: 8, z: 160 },
  /** Rest ledge L2 (y 32) on spire A: the cp_cinderspire_1 rune. */
  cinderspireLedge1: checkpointSpot('cp_cinderspire_1'),
  /** Rest ledge L4 on spire B (y 64), above the Heat_Crystal wall: the cp_cinderspire_2 rune. */
  cinderspireLedge2: checkpointSpot('cp_cinderspire_2'),
  /** End of the Wind_Zone glide on the ridge toward the Observatory. */
  windRidgeEnd: { x: 110, y: 120, z: -318 },
  /** Ridge path between the ridge end and the Observatory entrance. */
  azureRidge: { x: 125, y: 125, z: -340 },
  /** Observatory great hall (floor y 132) behind the entrance stair (y 130): its centre between the four pedestals. */
  observatoryHall: { ...OBSERVATORY_SPOTS.hall },
  /** Observatory ring corridor (y 140) on the hall's roof, by the ring lift's landing. */
  observatoryRing: { ...OBSERVATORY_SPOTS.ring },
  /** Observatory dome (y 150): Sentinel Prime's arena and Skyshard 3. */
  observatoryDome: { ...OBSERVATORY_SPOTS.dome },
} as const satisfies Readonly<Record<string, Vec3>>;

const S = QUEST_SPOTS;

/** Radius of the search zones (Req 3.6: at least 60 m). */
export const SEARCH_ZONE_RADIUS = 60;

// ── Builders ────────────────────────────────────────────────────────────────

const exact = (pos: Vec3): ObjectiveMarker => ({ kind: 'exact', pos: { ...pos } });
/** Search zone whose centre is deliberately off the goal (the goal stays inside). */
const zone = (center: Vec3): ObjectiveMarker => ({ kind: 'zone', center: { ...center }, radius: SEARCH_ZONE_RADIUS });
const NO_MARKER: ObjectiveMarker = { kind: 'none' };

const talk = (npc: Extract<ObjectiveTrigger, { kind: 'talk' }>['npc']): ObjectiveTrigger => ({ kind: 'talk', npc });
const reach = (areaId: string): ObjectiveTrigger => ({ kind: 'reach', areaId });
const defeat = (groupId: string): ObjectiveTrigger => ({ kind: 'defeat', groupId });
const interact = (targetId: string): ObjectiveTrigger => ({ kind: 'interact', targetId });
const solve = (puzzleId: string): ObjectiveTrigger => ({ kind: 'solve', puzzleId });
const skyshard = (index: 1 | 2 | 3): ObjectiveTrigger => ({ kind: 'skyshard', index });
const cinematic = (cinematicId: string): ObjectiveTrigger => ({ kind: 'cinematic', cinematicId });

function objective(id: string, text: string, trigger: ObjectiveTrigger, category: ObjectiveCategory, marker: ObjectiveMarker): ObjectiveDef {
  return { id, text, trigger, category, marker };
}

/** Main stage named from the registry; completion grants the stage XP when it has any. */
function mainStage(id: MainStageId, objectives: readonly ObjectiveDef[], onStart: readonly QuestEffect[] = []): StageDef {
  const xp = XP_SOURCES.stage[id];
  const onComplete: QuestEffect[] = xp === undefined ? [] : [{ kind: 'grant', reward: { xp } }];
  return { id, name: MAIN_STAGE_NAMES[id], objectives, onStart, onComplete };
}

// ── Main_Quest (table D) ────────────────────────────────────────────────────

export const MAIN_QUEST: QuestDef = {
  id: 'main',
  kind: 'main',
  stages: [
    mainStage('ms1', [
      objective('ms1_maren', '광장의 Elder Maren과 이야기하기', talk('maren'), 'interact', exact(S.plaza)),
      objective('ms1_isla', '망루 아래에서 궁수 Isla 만나기', talk('isla'), 'interact', exact(S.watchtower)),
      objective('ms1_raid', '동쪽 밭을 습격한 가시 정령 물리치기', defeat('village_raid'), 'combat', exact(S.eastField)),
      objective('ms1_report', '광장의 Elder Maren에게 보고하기', talk('maren'), 'interact', exact(S.plaza)),
    ], [{ kind: 'spawnGroup', groupId: 'village_raid' }]),

    mainStage('ms2', [
      // Zone centre 31 m south-west of the cliff foot, toward the village; resonance light drifts to the windmill.
      objective('ms2_breezewatch', '공명 빛을 따라 북동쪽 절벽 위 풍차 Breezewatch 찾기', reach('breezewatch_base'), 'explore',
        zone({ x: -152, y: 22, z: 272 })),
      objective('ms2_windmill_top', '절벽을 올라 풍차 꼭대기에 서기', reach('vista_verdant'), 'explore', exact(at('vista_verdant'))),
      objective('ms2_wren', '풍차 꼭대기에서 풍차지기 Wren과 이야기하기', talk('wren'), 'interact', exact(at('vista_verdant'))),
      objective('ms2_elderbough', '풍차에서 활강해 거대 고목 Elderbough로 가기', reach('lm_elderbough'), 'explore', exact(at('lm_elderbough'))),
    ]),

    mainStage('ms3', [
      objective('ms3_talus', '뿌리 아치 앞에서 Talus 만나기', talk('talus'), 'interact', exact(at('hollowroot_entrance'))),
      objective('ms3_bramble', '불꽃 문양이 새겨진 가시 덤불 관문 태우기', solve('pz_hollowroot_1'), 'interact', exact(S.hollowrootShrine)),
      objective('ms3_wind_wheel', '바람개비를 돌려 뿌리 승강기 올리기', solve('pz_hollowroot_2'), 'interact', exact(S.hollowrootShrine)),
      objective('ms3_pressure_plate', '돌기둥으로 압력판을 누르고 금 간 바위 부수기', solve('pz_hollowroot_3'), 'interact', exact(S.hollowrootShrine)),
      objective('ms3_root_room', '뿌리 전투 방의 가시 정령 무리 돌파하기', defeat('hollowroot_room'), 'combat', exact(S.hollowrootShrine)),
      objective('ms3_warden', '등 뒤 발광 뿌리가 약점인 Rootbound Warden 처치하기', defeat('rootboundWarden'), 'combat', exact(S.hollowrootShrine)),
      objective('ms3_skyshard', '뿌리 성소 안쪽에서 Skyshard 얻기', skyshard(1), 'interact', exact(S.hollowrootShrine)),
    ]),

    mainStage('ms4', [
      objective('ms4_ashgate', '동쪽 Ashgate 고개 넘기', reach('gate_ember'), 'explore', exact(at('gate_ember'))),
      objective('ms4_bridge', '협곡 바닥의 상승 기류를 타고 무너진 다리 건너기', reach('bridge_far_side'), 'explore', exact(S.bridgeFarSide)),
      // Zone centre 27 m west of the camp; its smoke column rises inside the zone.
      objective('ms4_durga', '연기가 오르는 광부 야영지에서 Durga 찾기', talk('durga'), 'interact', zone({ x: 212, y: 10, z: 250 })),
      objective('ms4_pack', 'Cinderspire로 가는 협곡 길목의 Cinder Hound 무리 소탕하기', defeat('ember_pass_pack'), 'combat', exact(S.emberPass)),
      objective('ms4_cinderspire', '수정 첨탑 Cinderspire 기슭에 도착하기', reach('cinderspire_base'), 'explore', exact(at('cinderspire_base'))),
    ], [{ kind: 'spawnGroup', groupId: 'ember_pass_pack' }]),

    mainStage('ms5', [
      objective('ms5_ledge_1', '첨탑 벽을 올라 첫 번째 휴식 발판에 닿기', reach('cp_cinderspire_1'), 'explore', exact(S.cinderspireLedge1)),
      objective('ms5_ledge_2', '열기 분출구를 타고 두 번째 첨탑으로 활강하기', reach('cp_cinderspire_2'), 'explore', exact(S.cinderspireLedge2)),
      objective('ms5_heat_crystal', 'Tide로 과열 수정을 식히고 첨탑 위로 오르기', solve('pz_cinderspire_1'), 'interact', exact(S.cinderspireLedge2)),
      objective('ms5_alpha', '첨탑 정상을 지키는 Cinder Alpha 처치하기', defeat('cinderAlpha'), 'combat', exact(at('cinderspire_summit'))),
      objective('ms5_skyshard', 'Cinderspire 정상에서 Skyshard 얻기', skyshard(2), 'interact', exact(at('cinderspire_summit'))),
    ]),

    mainStage('ms6', [
      objective('ms6_pass', '크레이터 북쪽 고개 넘기', reach('gate_azure'), 'explore', exact(at('gate_azure'))),
      // Zone centre 30 m south-west of the camp; the telescope's glint shows inside the zone.
      objective('ms6_oriel', '망원경이 반짝이는 야영지에서 Oriel과 이야기하기', talk('oriel'), 'interact', zone({ x: 22, y: 80, z: -196 })),
      objective('ms6_wind_ridge', '강풍을 타고 관측소 능선으로 활강하기', reach('wind_ridge_end'), 'explore', exact(S.windRidgeEnd)),
      objective('ms6_pack', '관측소 길목을 지키는 Windcutter 무리 돌파하기', defeat('azure_ridge_pack'), 'combat', exact(S.azureRidge)),
    ], [{ kind: 'spawnGroup', groupId: 'azure_ridge_pack' }]),

    mainStage('ms7', [
      objective('ms7_hall', '절벽 위 Starfall Observatory 대전당에 들어가기', reach('observatory_hall'), 'explore', exact(S.observatoryHall)),
      objective('ms7_constellation', '천장 별자리 순서대로 받침대에 속성 새기기', solve('pz_observatory_1'), 'interact', exact(S.observatoryHall)),
      objective('ms7_waves', '링 회랑의 방어막 파수꾼 두 웨이브 격퇴하기', defeat('observatory_waves'), 'combat', exact(S.observatoryRing)),
      objective('ms7_prime', '관측소 돔의 수호자 Sentinel Prime 처치하기', defeat('sentinelPrime'), 'combat', exact(S.observatoryDome)),
      objective('ms7_skyshard', '관측소 돔 안쪽에서 Skyshard 얻기', skyshard(3), 'interact', exact(S.observatoryDome)),
    ]),

    mainStage('ms8', [
      objective('ms8_light_pillar', '크레이터 중앙의 빛기둥으로 가기', reach('resonance_altar'), 'explore', exact(at('resonance_altar'))),
      objective('ms8_altar', '빛기둥 아래 Resonance Altar에 Skyshard 바치기', interact('resonance_altar'), 'interact', exact(at('resonance_altar'))),
      objective('ms8_stair', 'Starlit Stair를 올라 Astral Sanctum 관문 앞에 서기', reach('sanctum_gate'), 'explore', exact(at('sanctum_gate'))),
    ]),

    mainStage('ms9', [
      objective('ms9_mural', '벽화가 있는 연결 전당 살펴보기', interact('sanctum_mural'), 'interact', exact(at('sanctum_hall'))),
      objective('ms9_arena', 'Astral Sanctum 중심으로 가기', reach('sanctum_arena'), 'explore', exact(at('sanctum_arena'))),
      objective('ms9_caelith', 'Astral Sanctum 중심에서 Caelith 처치하기', defeat('caelith'), 'combat', exact(at('sanctum_arena'))),
    ]),

    mainStage('ms10', [
      objective('ms10_ending', 'Astral Sanctum에 번지는 새벽빛 지켜보기', cinematic('cin_ending'), 'interact', NO_MARKER),
      objective('ms10_return', '새벽의 Thistlewick으로 돌아가기', reach('thistlewick'), 'explore', exact(at('thistlewick'))),
      objective('ms10_maren', '광장의 Elder Maren과 이야기하기', talk('maren'), 'interact', exact(S.plaza)),
    ]),
  ],
};

// ── Side_Quests (task 13.3, design "Side_Quest") ─────────────────────────────
// Existing places, an Enemy_Camp and ElementReceivers only, each ≤ 5 min (Req 15.1, 15.2). One stage each: the
// quest giver's offer dialogue accepts it ('acceptQuest'), the last Objective is the hand-in talk, and the stage's
// `onComplete` grants the unique reward (with the Side_Quest XP) and turns on the world change (Req 15.3).

/** A Side_Quest's single stage: named from the registry, `onComplete` = its reward and world-change flag. */
function sideStage(id: SideQuestId, objectives: readonly ObjectiveDef[], reward: RewardRef): StageDef {
  return {
    id: `${id}_1`, name: SIDE_QUEST_NAMES[id], objectives, onStart: [],
    onComplete: [{ kind: 'grant', reward: { xp: XP_SOURCES.sideQuest, ...reward } }, { kind: 'setFlag', flag: SIDE_QUEST_FLAGS[id] }],
  };
}

const well = { x: -259, y: 18, z: 311 };

/** 잃어버린 풍경: the kite on the Breezewatch windmill top (y 64), the glide home, Tamsin (≈ 3 min). */
export const SQ_TAMSIN: QuestDef = {
  id: 'sq_tamsin',
  kind: 'side',
  stages: [sideStage('sq_tamsin', [
    objective('sq_tamsin_kite', '절벽을 올라 Breezewatch 풍차 날개 끝에 걸린 연 되찾기', interact(KITE_TARGET_ID), 'explore', exact(KITE_POS)),
    objective('sq_tamsin_return', '풍차에서 활강해 마을 우물가의 Tamsin에게 연 돌려주기', talk('tamsin'), 'interact', exact(well)),
  ], { items: [{ id: 'chm_dewdrop', count: 1 }] })],
};

/** 들판 가시 소탕: clearing the thorn nest camp_verdant_1 beyond Hobb's field, then Hobb (≈ 3 min). */
export const SQ_HOBB: QuestDef = {
  id: 'sq_hobb',
  kind: 'side',
  stages: [sideStage('sq_hobb', [
    objective('sq_hobb_nest', '밭 너머 덤불 언덕의 가시 둥지 적 모두 물리치기', defeat(HOBB_NEST_CAMP), 'combat',
      exact({ x: HOBB_NEST_POS.x, y: 19, z: HOBB_NEST_POS.z })),
    objective('sq_hobb_report', '동쪽 밭의 Hobb에게 알리기', talk('hobb'), 'interact', exact(S.eastField)),
  ], { items: [{ id: 'rlc_wanderers_compass', count: 1 }] })],
};

/** 식어버린 용광로: the three braziers round camp_durga lit with Ember (any order, no time limit), then Durga (≈ 4 min). */
export const SQ_DURGA: QuestDef = {
  id: 'sq_durga',
  kind: 'side',
  stages: [sideStage('sq_durga', [
    objective('sq_durga_braziers', '광부 야영지 둘레의 화로 세 개에 Ember 불 붙이기', solve(DURGA_BRAZIERS_PUZZLE), 'interact', exact(at('camp_durga'))),
    objective('sq_durga_report', '다시 불을 기다리는 용광로 옆 Durga에게 알리기', talk('durga'), 'interact', exact(at('camp_durga'))),
  ], { items: [{ id: 'mat_starmote', count: 5 }, { id: 'chm_stone_heart', count: 1 }] })],
};

/** The Side_Quests in registry order (Req 15.1). */
export const SIDE_QUESTS: readonly QuestDef[] = [SQ_TAMSIN, SQ_HOBB, SQ_DURGA];

/** All quest definitions, Main_Quest first. */
export const QUESTS: readonly QuestDef[] = [MAIN_QUEST, ...SIDE_QUESTS];
