// View models of the Pause, New Game confirm, save error, Quest and reaction codex screens (design "화면 목록",
// task 14.2; Req 31.4, 31.5, 20.8, 15.4, 25.13, 36.10). Pure, no DOM: the screens only turn these into elements, and
// every change they ask for is a UiCommand the owning system checks on the next tick.
import type { UiCommand } from '../../core/uiCommands';
import { MAIN_QUEST, SIDE_QUESTS } from '../../data/quests';
import { REACTION_IDS, SIDE_QUEST_IDS, SIDE_QUEST_NAMES, type ElementId, type ReactionId, type SideQuestId } from '../../data/ids';
import { LEARNING_RULE, REACTION_DEFS, type ReactionDef } from '../../data/reactions';
import type { QuestState, SideQuestStatus } from '../../logic/quest/types';
import type { DeepReadonly } from '../../logic/save/gameState';
import type { MenuItem } from '../screenModels';

// ── Pause ───────────────────────────────────────────────────────────────────

export type PauseMenuId = 'resume' | 'map' | 'inventory' | 'quest' | 'codex' | 'settings' | 'unstuck' | 'title';

export const PAUSE_TEXT = {
  title: '일시정지',
  /** Req 31.9: shown while the pointer lock is off (the Pause screen is what a lost lock opens). */
  clickHint: '화면을 클릭하면 계속합니다',
} as const;

/** The Pause entries in order (Req 31.5): 계속, 지도, 인벤토리/장비, 퀘스트, 속성 반응 도감, 설정, 끼임 해제, Title로. */
export function pauseMenuItems(): MenuItem<PauseMenuId>[] {
  return [
    { id: 'resume', label: '계속', disabledReason: null },
    { id: 'map', label: '지도', disabledReason: null },
    { id: 'inventory', label: '인벤토리/장비', disabledReason: null },
    { id: 'quest', label: '퀘스트', disabledReason: null },
    { id: 'codex', label: '속성 반응 도감', disabledReason: null },
    { id: 'settings', label: '설정', disabledReason: null },
    { id: 'unstuck', label: '끼임 해제', disabledReason: null },
    { id: 'title', label: 'Title로', disabledReason: null },
  ];
}

// ── Confirm dialogs ─────────────────────────────────────────────────────────

export type ConfirmChoice = 'cancel' | 'confirm';

export interface ConfirmText {
  readonly title: string;
  readonly text: string;
  /** Buttons in order; the first ("취소") takes the default focus (Req 31.4). */
  readonly items: readonly MenuItem<ConfirmChoice>[];
}

/** New Game over an existing save (Req 31.4): the default focus is "취소". */
export const NEW_GAME_CONFIRM: ConfirmText = {
  title: '새로 시작',
  text: '기존 저장 데이터를 덮어씁니다. 새로 시작할까요?',
  items: [
    { id: 'cancel', label: '취소', disabledReason: null },
    { id: 'confirm', label: '새로 시작', disabledReason: null },
  ],
};

/**
 * Save and backup both unreadable (Req 36.10): the data is already kept under a quarantine key, so "새로 시작" starts
 * without the overwrite question.
 */
export const SAVE_ERROR_TEXT = {
  title: '저장 데이터 오류',
  text: '저장 데이터를 불러올 수 없습니다.',
  detail: '손상된 데이터는 따로 보관했습니다. 새로 시작하면 처음부터 진행합니다.',
  newGame: '새로 시작',
  close: '닫기',
} as const;

// ── Quest ───────────────────────────────────────────────────────────────────

export interface SideQuestRow {
  readonly id: SideQuestId;
  readonly name: string;
  readonly status: SideQuestStatus;
  /** "진행 중" / "완료". */
  readonly statusText: string;
  /** Current objective text ("" once done). */
  readonly objective: string;
  readonly tracked: boolean;
  /** "추적" toggle: track this quest, or back to the Main_Quest when it is the tracked one; null once done. */
  readonly command: UiCommand | null;
  /** "추적하기" / "추적 해제". */
  readonly buttonText: string;
}

export interface QuestView {
  readonly main: { readonly stage: string; readonly objective: string; readonly done: boolean; readonly tracked: boolean };
  /** Accepted Side_Quests (in progress, then done), registry order within each. */
  readonly sides: readonly SideQuestRow[];
}

const STATUS_TEXT: Partial<Record<SideQuestStatus, string>> = { active: '진행 중', done: '완료' };

/** The Quest screen (Req 15.4): Main_Quest stage and Objective, accepted Side_Quests and the tracking toggle. */
export function questView(q: DeepReadonly<QuestState>): QuestView {
  const stage = MAIN_QUEST.stages[q.main.stage];
  const main = {
    stage: q.main.done ? '메인 퀘스트 완료' : (stage?.name ?? ''),
    objective: q.main.done ? '모든 단계를 마쳤습니다.' : (stage?.objectives[q.main.objective]?.text ?? ''),
    done: q.main.done,
    tracked: q.tracked === 'main',
  };
  const rows: SideQuestRow[] = [];
  for (const status of ['active', 'done'] as const) {
    for (const id of SIDE_QUEST_IDS) {
      const p = q.side[id];
      if (p === undefined || p.status !== status) continue;
      const def = SIDE_QUESTS.find((d) => d.id === id);
      const tracked = q.tracked === id;
      const objective = status === 'done' ? '' : (def?.stages[p.stage]?.objectives[p.objective]?.text ?? '');
      rows.push({
        id, name: SIDE_QUEST_NAMES[id], status, statusText: STATUS_TEXT[status] ?? '', objective, tracked,
        command: status === 'active' ? { kind: 'trackQuest', questId: tracked ? null : id } : null,
        buttonText: tracked ? '추적 해제' : '추적하기',
      });
    }
  }
  return { main, sides: rows };
}

// ── Reaction codex ──────────────────────────────────────────────────────────

export interface CodexCell {
  readonly id: ReactionId;
  readonly discovered: boolean;
  /** Korean reaction name, "???" while locked. */
  readonly name: string;
  /** The Element pair, null while locked. */
  readonly pair: readonly [ElementId, ElementId] | null;
  /** Effect sentence, "" while locked. */
  readonly effect: string;
}

const PCT = (v: number): string => `${Math.round(v * 100)}%`;
const ELEMENT_NAMES: Readonly<Record<ElementId, string>> = { ember: 'Ember', tide: 'Tide', gale: 'Gale', terra: 'Terra' };

/** One Korean sentence for a reaction's effect (numbers from REACTION_DEFS). */
export function reactionEffectText(def: ReactionDef): string {
  const e = def.effect;
  let text: string;
  switch (e.kind) {
    case 'burst':
      text = `피해 ${e.bonusMul}배, 반경 ${def.radius} m 적에게 ${PCT(e.splashMul)} 폭발 피해, ${e.stagger}초 Stagger`;
      break;
    case 'zone':
      text = `반경 ${def.radius} m 용암 지대 ${e.seconds}초 (${e.tickInterval}초마다 공격력 ${PCT(e.tickAtkMul)} 피해)`;
      break;
    case 'root':
      text = `반경 ${def.radius} m 적을 ${e.seconds}초 동안 속박`;
      break;
    case 'spread': {
      const spread = def.spreads === null ? '' : `${ELEMENT_NAMES[def.spreads]} 표식을 반경 ${def.radius} m 적에게 퍼뜨림`;
      const extra = e.atkMul !== null ? `, 공격력 ${PCT(e.atkMul)} 피해` : e.slow !== null ? `, ${e.slow.seconds}초 동안 이동 ${PCT(e.slow.pct)} 감속` : '';
      text = `${spread}${extra}`;
      break;
    }
  }
  return def.terraShield ? `${text} · Active_Character 보호막` : text;
}

/** Every reaction in table order; undiscovered ones are locked cells (Req 25.13). */
export function codexCells(codex: readonly ReactionId[]): CodexCell[] {
  const found = new Set(codex);
  return REACTION_IDS.map((id) => {
    const def = REACTION_DEFS[id];
    const discovered = found.has(id);
    return {
      id, discovered, name: discovered ? def.name : '???', pair: discovered ? def.pair : null,
      effect: discovered ? reactionEffectText(def) : '',
    };
  });
}

/** The learning rule under the codex (the same sentence the tutorial uses). */
export const CODEX_RULE = LEARNING_RULE;

/** "발견 3/6". */
export function codexProgressText(codex: readonly ReactionId[]): string {
  return `발견 ${new Set(codex).size}/${REACTION_IDS.length}`;
}
