/*
 * Text and menu models of the Title, HUD, Defeat and Victory screens. Pure, so the wording and the choice
 * rules are unit-tested without a DOM; the screen classes only turn these into elements. Screen text is
 * Korean; proper nouns (Skyshard, Caelith, Waystone, character names, ...) stay in English (Req 35.4).
 */
import type { DefeatChoice } from '../core/uiCommands';
import { CHARACTER_IDS, CHARACTER_NAMES } from '../data/ids';
import type { ObjectiveView } from '../quest/questSystem';
import type { VictoryView } from './victoryView';

/** A menu entry; a non-null `disabledReason` shows the button disabled with that reason. */
export interface MenuItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly disabledReason: string | null;
}

// ── Title ───────────────────────────────────────────────────────────────────

export const TITLE_TEXT = {
  name: 'SKYSHARD',
  tagline: 'ECHOES OF THE WILD',
  /** Shown until the first input (Req 37.6: that input also starts the audio). */
  prompt: '클릭하거나 아무 키나 눌러 시작',
  menuLabel: '메인 메뉴',
} as const;

export type TitleMenuId = 'newGame' | 'continue' | 'settings' | 'credits';

/**
 * New Game, then Continue, which is disabled without save data (Req 31.3), then the optional entries the Title
 * offers (task 14.4: 'settings' → "설정"; task 14.2: 'credits' → "크레딧").
 */
export function titleMenuItems(hasSave: boolean, extras: readonly Exclude<TitleMenuId, 'newGame' | 'continue'>[] = []): MenuItem<TitleMenuId>[] {
  const items: MenuItem<TitleMenuId>[] = [
    { id: 'newGame', label: '새로 시작', disabledReason: null },
    { id: 'continue', label: '이어하기', disabledReason: hasSave ? null : '저장 데이터 없음' },
  ];
  if (extras.includes('settings')) items.push({ id: 'settings', label: '설정', disabledReason: null });
  if (extras.includes('credits')) items.push({ id: 'credits', label: '크레딧', disabledReason: null });
  return items;
}

// ── HUD ─────────────────────────────────────────────────────────────────────

/** Skyshards in the game (Req 4.3). */
export const SKYSHARD_TOTAL = 3;

/** Held Skyshards clamped to 0–3 (a non-finite value reads as 0). */
export function clampSkyshards(n: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(n)) return 0;
  return Math.min(SKYSHARD_TOTAL, Math.max(0, Math.floor(n))) as 0 | 1 | 2 | 3;
}

/** HUD Skyshard progress, e.g. "Skyshard 1/3". */
export function formatSkyshards(n: number): string {
  return `Skyshard ${clampSkyshards(n)}/${SKYSHARD_TOTAL}`;
}

export interface ObjectiveLines {
  /** Stage name above the objective (Main_Quest stage, e.g. "방랑자의 도착"). */
  readonly stage: string;
  readonly text: string;
}

/** Objective panel lines for the tracked quest's objective; null hides the panel (nothing left to track). */
export function objectiveLines(view: ObjectiveView | null): ObjectiveLines | null {
  return view === null ? null : { stage: view.stageName, text: view.objective.text };
}

// ── Defeat ──────────────────────────────────────────────────────────────────

export const DEFEAT_TITLE = '파티 전멸';

/** Defeat Screen text: `bossPhase` is the `'party:wipe'` payload (null outside the Caelith fight). */
export function defeatText(bossPhase: 1 | 2 | 3 | null): string {
  return bossPhase === null ? '모든 동료가 쓰러졌습니다.' : `Caelith 전투 Phase ${bossPhase}에서 모든 동료가 쓰러졌습니다.`;
}

/** One choice after a normal wipe (Req 27.3), two in the Caelith fight (Req 6.13). */
export function defeatOptions(bossPhase: 1 | 2 | 3 | null): MenuItem<DefeatChoice>[] {
  if (bossPhase === null) return [{ id: 'respawn', label: '마지막 부활 지점에서 다시 시작', disabledReason: null }];
  return [
    { id: 'retryPhase', label: '현재 Phase부터 재도전', disabledReason: null },
    { id: 'returnToWaystone', label: 'Waystone으로 돌아가기', disabledReason: null },
  ];
}

// ── Victory ─────────────────────────────────────────────────────────────────

export const VICTORY_TEXT = {
  title: '모험의 끝',
  subtitle: 'Astral Sanctum 너머로 새벽이 밝았습니다.',
  debugUsed: '디버그 사용됨',
  ranksHeading: '능력 강화 단계',
} as const;

export type VictoryMenuId = 'continueExploring' | 'mainMenu';

/** Req 7.4. */
export function victoryMenuItems(): MenuItem<VictoryMenuId>[] {
  return [
    { id: 'continueExploring', label: '탐험 계속', disabledReason: null },
    { id: 'mainMenu', label: '메인 메뉴', disabledReason: null },
  ];
}

/** Play time as "1시간 2분 3초", "25분 7초" or "42초" (whole seconds). */
export function formatPlayTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분 ${s}초`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

export interface StatRow {
  readonly label: string;
  readonly value: string;
}

/** Victory statistics in display order (Req 7.3). */
export function victoryStatRows(view: VictoryView): StatRow[] {
  return [
    { label: '플레이 시간', value: formatPlayTime(view.playTimeSec) },
    { label: '처치한 적', value: String(view.enemiesDefeated) },
    { label: '발견한 장소', value: `${view.places.found}/${view.places.total}` },
    { label: '완료한 퀘스트', value: String(view.questsCompleted) },
    { label: '발견한 Chest', value: `${view.chests.found}/${view.chests.total}` },
    { label: '최종 파티 레벨', value: `Lv. ${view.partyLevel}` },
  ];
}

/** Skill and Burst rank of every character, in party slot order. */
export function victoryRankRows(view: VictoryView): StatRow[] {
  return CHARACTER_IDS.map((id) => {
    const { skill, burst } = view.abilityRanks[id];
    return { label: CHARACTER_NAMES[id], value: `Skill ${skill}단계 · Burst ${burst}단계` };
  });
}
