import './titleScreen.css';
import { h, menuButton } from './dom';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';
import { TITLE_TEXT, titleMenuItems, type TitleMenuId } from './screenModels';

export interface TitleScreenOptions {
  /** Main save present: Continue is enabled (Req 31.3). */
  hasSave: boolean;
  onNewGame(): void;
  onContinue(): void;
  /** Task 14.4: "설정" opens the Settings screen over the Title (the entry shows only when given). */
  onSettings?(): void;
  /** Task 14.2: "크레딧" opens the Credits screen over the Title (the entry shows only when given). */
  onCredits?(): void;
  /** Open with the menu already shown (coming back from a game; the first input has already happened). */
  skipPrompt?: boolean;
}

/*
 * Title Screen (design "화면 목록" Title, Req 31.1, 31.3): the game name over the live world, which the render
 * loop shows from a slow orbit camera. Until the first input only "클릭하거나 아무 키나 눌러 시작" shows; that
 * input (any key, gamepad button or pointer press, reaching `onAnyInput` through the ScreenManager) opens the
 * menu and is not a menu selection, so the first Enter or click never starts a game. Menu: 새로 시작 and 이어하기
 * (disabled with "저장 데이터 없음" when there is no save), 설정 (task 14.4) and 크레딧 (task 14.2). `menu` context: game
 * time and play time stand still (Req 7.8).
 */
export class TitleScreen implements Screen {
  readonly id = 'title';
  readonly context = 'menu';
  private readonly root: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private revealed = false;

  constructor(options: TitleScreenOptions) {
    const onSettings = options.onSettings;
    const onCredits = options.onCredits;
    const actions: Record<TitleMenuId, () => void> = {
      newGame: () => this.choose(options.onNewGame),
      continue: () => this.choose(options.onContinue),
      settings: () => this.choose(() => onSettings?.()), // task 14.4
      credits: () => this.choose(() => onCredits?.()), // task 14.2
    };
    const extras: ('settings' | 'credits')[] = [];
    if (onSettings) extras.push('settings');
    if (onCredits) extras.push('credits');
    this.buttons = titleMenuItems(options.hasSave, extras).map((item) =>
      menuButton(item.label, actions[item.id], { disabledReason: item.disabledReason, className: `title-screen__${item.id}` }),
    );
    this.prompt = h('p', { class: 'title-screen__prompt', role: 'status', 'aria-live': 'polite' }, [TITLE_TEXT.prompt]);
    this.menu = h('nav', { class: 'title-screen__menu', 'aria-label': TITLE_TEXT.menuLabel, hidden: true }, this.buttons);
    this.root = h('div', { class: 'ui-screen title-screen', role: 'region', 'aria-label': 'Skyshard: Echoes of the Wild' }, [
      h('header', { class: 'title-screen__logo' }, [
        h('h1', { class: 'title-screen__name' }, [TITLE_TEXT.name]),
        h('p', { class: 'title-screen__tagline' }, [TITLE_TEXT.tagline]),
      ]),
      this.prompt,
      this.menu,
    ]);
    if (options.skipPrompt === true) this.reveal();
  }

  /** The menu is open (the first input has happened). */
  get menuOpen(): boolean {
    return this.revealed;
  }

  mount(root: HTMLElement): void {
    root.append(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  onAnyInput(): boolean {
    if (this.revealed) return false;
    this.reveal();
    return true;
  }

  onInput(nav: NavInput): boolean {
    // Nothing to go back to from the bottom screen; before the menu opens every input is the first input.
    return !this.revealed || nav === 'cancel';
  }

  focusables(): readonly HTMLElement[] {
    return this.revealed ? this.buttons : [];
  }

  private reveal(): void {
    this.revealed = true;
    this.prompt.hidden = true;
    this.menu.hidden = false;
  }

  /** Menu buttons only act once the menu is open (a click that arrives with the first input selects nothing). */
  private choose(action: () => void): void {
    if (this.revealed) action();
  }
}
