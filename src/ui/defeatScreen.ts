import type { DefeatChoice } from '../core/uiCommands';
import { h, menuButton } from './dom';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';
import { DEFEAT_TITLE, defeatOptions, defeatText } from './screenModels';

export interface DefeatScreenOptions {
  /** `'party:wipe'` payload: null outside the Caelith fight. */
  bossPhase: 1 | 2 | 3 | null;
  /** The chosen option; the caller closes the screen and queues the `defeatChoice` UiCommand. */
  onChoose(choice: DefeatChoice): void;
}

/*
 * Defeat Screen (design "화면 목록" Defeat, Req 27.3, 6.13): opened on `'party:wipe'`. After a normal wipe the one
 * choice is "마지막 부활 지점에서 다시 시작"; in the Caelith fight "현재 Phase부터 재도전" / "Waystone으로 돌아가기".
 * `menu` context (game time stops). Esc / B does not close it: a choice has to be made.
 */
export class DefeatScreen implements Screen {
  readonly id = 'defeat';
  readonly context = 'menu';
  private readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private chosen = false;

  constructor(options: DefeatScreenOptions) {
    this.buttons = defeatOptions(options.bossPhase).map((item) =>
      menuButton(item.label, () => {
        if (this.chosen) return;
        this.chosen = true;
        options.onChoose(item.id);
      }),
    );
    this.root = h('div', { class: 'ui-screen ui-modal defeat-screen' }, [
      h('section', { class: 'ui-panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'defeat-title', 'aria-describedby': 'defeat-text' }, [
        h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
        h('h2', { class: 'ui-panel__title', id: 'defeat-title' }, [DEFEAT_TITLE]),
        h('p', { class: 'ui-panel__text', id: 'defeat-text' }, [defeatText(options.bossPhase)]),
        h('div', { class: 'ui-actions' }, this.buttons),
      ]),
    ]);
  }

  mount(root: HTMLElement): void {
    root.append(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  onInput(nav: NavInput): boolean {
    return nav === 'cancel';
  }

  focusables(): readonly HTMLElement[] {
    return this.buttons;
  }
}
