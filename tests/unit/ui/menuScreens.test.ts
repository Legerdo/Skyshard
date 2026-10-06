import { describe, expect, it } from 'vitest';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { creditSections, LIBRARY_CREDITS } from '../../../src/data/credits';
import { REACTION_IDS } from '../../../src/data/ids';
import { LEARNING_RULE, REACTION_DEFS } from '../../../src/data/reactions';
import { createNewGameState } from '../../../src/logic/save/gameState';
import type { ConfirmScreenOptions } from '../../../src/ui/confirmScreen';
import {
  CODEX_RULE, codexCells, codexProgressText, NEW_GAME_CONFIRM, pauseMenuItems, questView, reactionEffectText, SAVE_ERROR_TEXT,
} from '../../../src/ui/models/menuModels';
import { ScreenManager } from '../../../src/ui/screenManager';
import { titleMenuItems } from '../../../src/ui/screenModels';
import type { TitleScreenOptions } from '../../../src/ui/titleScreen';
import { UiFlow } from '../../../src/ui/uiFlow';
import { FAKE_ROOT, fakeElement, fakeScreen } from './fakes';

// Task 14.2 (design "화면 목록"; Req 31.1, 31.4, 31.5, 20.8, 15.4, 25.13, 36.10, 40.3): the menu screens' models and
// the Title flow's confirm dialogs.

describe('Pause (Req 31.5, 20.8)', () => {
  it('lists every entry in order, all enabled', () => {
    expect(pauseMenuItems().map((i) => i.label)).toEqual(['계속', '지도', '인벤토리/장비', '퀘스트', '속성 반응 도감', '설정', '끼임 해제', 'Title로']);
    expect(pauseMenuItems().map((i) => i.id)).toEqual(['resume', 'map', 'inventory', 'quest', 'codex', 'settings', 'unstuck', 'title']);
    expect(pauseMenuItems().every((i) => i.disabledReason === null)).toBe(true);
  });
});

describe('Title menu (Req 31.1, 31.3)', () => {
  it('offers New Game, Continue (disabled without a save), Settings and Credits', () => {
    expect(titleMenuItems(false, ['settings', 'credits']).map((i) => [i.id, i.label, i.disabledReason])).toEqual([
      ['newGame', '새로 시작', null], ['continue', '이어하기', '저장 데이터 없음'], ['settings', '설정', null], ['credits', '크레딧', null],
    ]);
  });
});

describe('Credits (Req 40.3)', () => {
  it('shows every library of src/data/credits.ts', () => {
    const lines = creditSections().flatMap((s) => s.lines).join('\n');
    for (const lib of LIBRARY_CREDITS) expect(lines).toContain(`${lib.name} ${lib.version}`);
  });
});

describe('reaction codex (Req 25.13)', () => {
  it('shows discovered reactions with their pair and effect, the rest as locked cells', () => {
    const cells = codexCells(['steamBurst', 'mudBind']);
    expect(cells.map((c) => c.id)).toEqual([...REACTION_IDS]);
    const steam = cells.find((c) => c.id === 'steamBurst');
    expect(steam).toMatchObject({ discovered: true, name: REACTION_DEFS.steamBurst.name, pair: ['ember', 'tide'] });
    expect(steam?.effect).toContain('3 m');
    const locked = cells.filter((c) => !c.discovered);
    expect(locked).toHaveLength(REACTION_IDS.length - 2);
    expect(locked.every((c) => c.name === '???' && c.pair === null && c.effect === '')).toBe(true);
    expect(codexProgressText(['steamBurst', 'steamBurst', 'mudBind'])).toBe(`발견 2/${REACTION_IDS.length}`);
    expect(CODEX_RULE).toBe(LEARNING_RULE);
  });

  it('writes an effect sentence for every reaction, marking the Terra shield', () => {
    for (const id of REACTION_IDS) {
      const text = reactionEffectText(REACTION_DEFS[id]);
      expect(text.length, id).toBeGreaterThan(5);
      expect(text.includes('보호막'), id).toBe(REACTION_DEFS[id].terraShield);
    }
  });
});

describe('Quest screen (Req 15.4)', () => {
  it('shows the Main_Quest stage and objective, and only accepted Side_Quests with the tracking toggle', () => {
    const gs = createNewGameState(1);
    const fresh = questView(gs.quests);
    expect(fresh.main.stage.length).toBeGreaterThan(0);
    expect(fresh.main.objective.length).toBeGreaterThan(0);
    expect(fresh.main.tracked).toBe(true);
    expect(fresh.sides).toEqual([]);
    gs.quests.side.sq_tamsin.status = 'active';
    gs.quests.side.sq_hobb.status = 'done';
    const view = questView(gs.quests);
    expect(view.sides.map((s) => [s.id, s.statusText])).toEqual([['sq_tamsin', '진행 중'], ['sq_hobb', '완료']]);
    expect(view.sides[0]).toMatchObject({ tracked: false, buttonText: '추적하기', command: { kind: 'trackQuest', questId: 'sq_tamsin' } });
    expect(view.sides[1].command).toBeNull();
    gs.quests.tracked = 'sq_tamsin';
    const tracked = questView(gs.quests);
    expect(tracked.main.tracked).toBe(false);
    expect(tracked.sides[0]).toMatchObject({ tracked: true, buttonText: '추적 해제', command: { kind: 'trackQuest', questId: null } });
  });
});

function titleFlow(hasSave: boolean) {
  const ui = new ScreenManager({ root: FAKE_ROOT });
  const titles: TitleScreenOptions[] = [];
  const confirms: ConfirmScreenOptions[] = [];
  const calls = { newGame: 0 };
  const hud = fakeScreen('gameplay', 'gameplay');
  const flow = new UiFlow({
    ui,
    commands: new UiCommandQueue(),
    screens: {
      title: (o) => (titles.push(o), fakeScreen('title', 'menu')),
      defeat: () => fakeScreen('defeat', 'menu'),
      victory: () => fakeScreen('victory', 'menu'),
      confirm: (o) => {
        confirms.push(o);
        // Stand-in with the dialog's buttons in order: the first is the default focus.
        return fakeScreen(o.id, 'menu', o.text.items.map((item) => fakeElement(item.id, () => o.onChoose(item.id))));
      },
    },
    hasSave: () => hasSave,
    startNewGame: () => (calls.newGame++, hud),
    continueGame: () => null,
    endSession: () => undefined,
  });
  flow.showTitle(true);
  return { ui, titles, confirms, calls, flow };
}

describe('New Game over a save (Req 31.4)', () => {
  it('asks first, with the default focus on "취소"; 취소 keeps the Title, 새로 시작 starts', () => {
    const { ui, titles, confirms, calls } = titleFlow(true);
    titles[0].onNewGame();
    expect(ui.ids).toEqual(['title', 'newGameConfirm']);
    expect(confirms[0].text).toBe(NEW_GAME_CONFIRM);
    expect(NEW_GAME_CONFIRM.items[0]).toMatchObject({ id: 'cancel', label: '취소' });
    expect(ui.focusIndex).toBe(0);
    ui.nav('confirm'); // Enter on the default focus: 취소
    expect(ui.ids).toEqual(['title']);
    expect(calls.newGame).toBe(0);
    titles[0].onNewGame();
    ui.nav('right');
    ui.nav('confirm');
    expect(ui.ids).toEqual(['gameplay']);
    expect(calls.newGame).toBe(1);
  });

  it('starts at once without a save', () => {
    const { ui, titles, confirms, calls } = titleFlow(false);
    titles[0].onNewGame();
    expect([ui.ids, confirms.length, calls.newGame]).toEqual([['gameplay'], 0, 1]);
  });
});

describe('save error over the Title (Req 36.10)', () => {
  it('shows "저장 데이터를 불러올 수 없습니다"; 새로 시작 starts without the overwrite question', () => {
    const { ui, confirms, calls, flow } = titleFlow(true);
    flow.saveError();
    flow.saveError();
    expect(ui.ids).toEqual(['title', 'error']);
    expect(confirms).toHaveLength(1);
    expect(confirms[0].text.text).toBe(SAVE_ERROR_TEXT.text);
    confirms[0].onChoose('confirm');
    expect(ui.ids).toEqual(['gameplay']);
    expect(calls.newGame).toBe(1);
    expect(confirms).toHaveLength(1); // no overwrite question
  });

  it('닫기 returns to the Title menu', () => {
    const { ui, confirms, flow } = titleFlow(true);
    flow.saveError();
    confirms[0].onChoose('cancel');
    expect(ui.ids).toEqual(['title']);
  });
});
