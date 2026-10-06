import './menuScreens.css';
import { h, menuButton } from './dom';
import { PAUSE_TEXT, pauseMenuItems, type PauseMenuId } from './models/menuModels';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';

export interface PauseScreenOptions {
  /** One handler per entry; "계속" (and Esc / B, and a click outside the panel) is `resume`. */
  readonly actions: Readonly<Record<PauseMenuId, () => void>>;
  /** true right after the Esc that released the pointer lock and opened Pause: that Esc must not close it again. */
  readonly ignoreCancel?: () => boolean;
}

/*
 * Pause screen (design "화면 목록" Pause, task 14.2; Req 31.5, 31.8, 31.9, 20.8): opened by Esc / Start in play, a lost
 * pointer lock, a hidden tab or a lost gamepad. `menu` context, so game time and play time stop. Entries: 계속, 지도,
 * 인벤토리/장비, 퀘스트, 속성 반응 도감, 설정, 끼임 해제 (closes Pause and queues `unstuck`), Title로. The line "화면을
 * 클릭하면 계속합니다" is the pointer-lock hint: a click on the dimmed backdrop resumes (and the click is the gesture
 * the page uses to lock the pointer again).
 */
export class PauseScreen implements Screen {
  readonly id = 'pause';
  readonly context = 'menu';
  private readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private readonly resume: () => void;
  private readonly ignoreCancel: () => boolean;

  constructor(options: PauseScreenOptions) {
    this.resume = options.actions.resume;
    this.ignoreCancel = options.ignoreCancel ?? (() => false);
    this.buttons = pauseMenuItems().map((item) =>
      menuButton(item.label, options.actions[item.id], { disabledReason: item.disabledReason, className: `pause-screen__${item.id}` }),
    );
    const panel = h('section', { class: 'ui-panel menu-panel pause-screen__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pause-title' }, [
      h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
      h('h2', { class: 'ui-panel__title', id: 'pause-title' }, [PAUSE_TEXT.title]),
      h('nav', { class: 'ui-actions pause-screen__menu', 'aria-label': PAUSE_TEXT.title }, this.buttons),
      h('p', { class: 'pause-screen__hint' }, [PAUSE_TEXT.clickHint]),
    ]);
    this.root = h('div', { class: 'ui-screen ui-modal menu-screen pause-screen' }, [panel]);
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root) this.resume();
    });
  }

  mount(root: HTMLElement): void {
    root.append(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  onInput(nav: NavInput): boolean {
    if (nav !== 'cancel') return false;
    if (!this.ignoreCancel()) this.resume();
    return true;
  }

  focusables(): readonly HTMLElement[] {
    return this.buttons;
  }
}
