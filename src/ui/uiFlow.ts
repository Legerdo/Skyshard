/*
 * Screen flow between Title, Gameplay HUD, Defeat and Victory (design "화면 목록": 부팅과 Loading, 시작과 복귀,
 * Defeat, Victory). The screens are made by an injected factory, so these rules run in Node tests with stand-in
 * screens:
 * - Title sits at the bottom after Loading. New Game (and Continue once saves load) empties the stack and puts
 *   the Gameplay HUD at the bottom; "메인 메뉴" puts the Title back the same way, with its menu already open.
 * - `'party:wipe'` pushes Defeat over the game; its choice closes it and queues `defeatChoice` for the next tick.
 * - The end of `cin_ending` pushes Victory; "탐험 계속" closes it and queues `continueExploring`, "메인 메뉴" ends
 *   the session and returns to the Title.
 * Screens that change game state never touch it: the owning systems apply the UiCommands on the next tick.
 */
import type { UiCommandQueue } from '../core/uiCommands';
import type { ConfirmScreenOptions } from './confirmScreen';
import type { DefeatScreenOptions } from './defeatScreen';
import { NEW_GAME_CONFIRM, SAVE_ERROR_TEXT } from './models/menuModels';
import type { Screen, ScreenManager } from './screenManager';
import type { TitleScreenOptions } from './titleScreen';
import type { VictoryScreenOptions } from './victoryScreen';
import type { VictoryView } from './victoryView';

export interface ScreenFactory {
  title(options: TitleScreenOptions): Screen;
  defeat(options: DefeatScreenOptions): Screen;
  victory(options: VictoryScreenOptions): Screen;
  /** Task 14.2: the New Game overwrite question and the save error dialog (without it New Game starts at once). */
  confirm?(options: ConfirmScreenOptions): Screen;
}

export interface UiFlowOptions {
  ui: ScreenManager;
  commands: UiCommandQueue;
  screens: ScreenFactory;
  /** Whether a main save exists right now (Continue enabled, Req 31.3). */
  hasSave(): boolean;
  /** "새로 시작": starts the prepared session and returns its Gameplay HUD. */
  startNewGame(): Screen;
  /** "이어하기": loads the save and returns the Gameplay HUD, or null when it cannot (the Title stays). */
  continueGame(): Screen | null;
  /** "메인 메뉴": ends the running session (a fresh one is prepared for the Title background). */
  endSession(): void;
  /** Task 14.4: the Title's "설정" pushes the Settings screen (no entry without it). */
  openSettings?(): void;
  /** Task 14.2: the Title's "크레딧" pushes the Credits screen (no entry without it). */
  openCredits?(): void;
}

export class UiFlow {
  private readonly o: UiFlowOptions;

  constructor(options: UiFlowOptions) {
    this.o = options;
  }

  /** Title at the bottom of an emptied stack; `menuOpen` skips the first-input prompt (returning from a game). */
  showTitle(menuOpen = false): void {
    const { screens, ui } = this.o;
    ui.replaceAll(
      screens.title({
        hasSave: this.o.hasSave(),
        skipPrompt: menuOpen,
        onNewGame: () => this.newGame(),
        onContinue: () => this.enterGame(this.o.continueGame()),
        onSettings: this.o.openSettings, // task 14.4
        onCredits: this.o.openCredits, // task 14.2
      }),
    );
  }

  /**
   * Task 14.2: "새로 시작". With a save present the overwrite question opens first (default focus "취소", Req 31.4);
   * without one, or from the save error dialog (`confirmed`), the game starts at once.
   */
  newGame(confirmed = false): void {
    const { ui, screens } = this.o;
    if (confirmed || screens.confirm === undefined || !this.o.hasSave()) {
      this.enterGame(this.o.startNewGame());
      return;
    }
    if (ui.has('newGameConfirm')) return;
    const screen = screens.confirm({
      id: 'newGameConfirm',
      text: NEW_GAME_CONFIRM,
      onChoose: (choice) => {
        this.close(screen);
        if (choice === 'confirm') this.enterGame(this.o.startNewGame());
      },
    });
    ui.push(screen);
  }

  /**
   * Task 14.2: the save and its backup could not be read (Req 36.10): over the Title, "저장 데이터를 불러올 수
   * 없습니다" with 새로 시작 (no overwrite question: the data is already quarantined) and 닫기.
   */
  saveError(): void {
    const { ui, screens } = this.o;
    if (screens.confirm === undefined || !ui.has('title') || ui.has('error')) return;
    const screen = screens.confirm({
      id: 'error',
      text: {
        title: SAVE_ERROR_TEXT.title,
        text: SAVE_ERROR_TEXT.text,
        items: [
          { id: 'confirm', label: SAVE_ERROR_TEXT.newGame, disabledReason: null },
          { id: 'cancel', label: SAVE_ERROR_TEXT.close, disabledReason: null },
        ],
      },
      detail: SAVE_ERROR_TEXT.detail,
      onChoose: (choice) => {
        this.close(screen);
        if (choice === 'confirm') this.newGame(true);
      },
    });
    ui.push(screen);
  }

  /** `'party:wipe'` during play: Defeat over the game (once). */
  partyWiped(bossPhase: 1 | 2 | 3 | null): void {
    const { ui, screens, commands } = this.o;
    if (!ui.has('gameplay') || ui.has('defeat')) return;
    const screen = screens.defeat({
      bossPhase,
      onChoose: (choice) => {
        this.close(screen);
        commands.push({ kind: 'defeatChoice', choice });
      },
    });
    ui.push(screen);
  }

  /** `cin_ending` ended: Victory over the game (once). `view` is read only when the screen opens. */
  endingFinished(view: () => VictoryView): void {
    const { ui, screens, commands } = this.o;
    if (!ui.has('gameplay') || ui.has('victory')) return;
    const screen = screens.victory({
      view: view(),
      onContinueExploring: () => {
        this.close(screen);
        commands.push({ kind: 'continueExploring' });
      },
      onMainMenu: () => this.returnToTitle(),
    });
    ui.push(screen);
  }

  /** Ends the session and shows the Title with its menu open; waiting UiCommands belonged to that session. */
  returnToTitle(): void {
    this.o.commands.clear();
    this.o.endSession();
    this.showTitle(true);
  }

  private enterGame(hud: Screen | null): void {
    if (hud === null || !this.o.ui.has('title')) return;
    this.o.ui.replaceAll(hud);
  }

  /** Pops `screen` when it is on top (a screen above it would otherwise be closed instead). */
  private close(screen: Screen): void {
    if (this.o.ui.top === screen) this.o.ui.pop();
  }
}
