import './menuScreens.css';
import type { UiScreenId } from '../core/gameEvents';
import { h, menuButton } from './dom';
import type { ConfirmChoice, ConfirmText } from './models/menuModels';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';

export interface ConfirmScreenOptions {
  /** `'ui:screen'` id: 'newGameConfirm' (Req 31.4) or 'error' (the save error over the Title, Req 36.10). */
  readonly id: UiScreenId;
  readonly text: ConfirmText;
  /** Extra line under the text. */
  readonly detail?: string;
  /** The chosen button; Esc / B is 'cancel'. The caller pops the screen. */
  onChoose(choice: ConfirmChoice): void;
}

/*
 * Small confirm dialog (task 14.2): the New Game overwrite question (default focus "취소", Req 31.4) and the save
 * error over the Title ("저장 데이터를 불러올 수 없습니다" with 새로 시작, Req 36.10). `menu` context. The first button
 * takes the default focus; a choice is taken once.
 */
export class ConfirmScreen implements Screen {
  readonly id: UiScreenId;
  readonly context = 'menu';
  private readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private chosen = false;
  private readonly choose: (choice: ConfirmChoice) => void;

  constructor(options: ConfirmScreenOptions) {
    this.id = options.id;
    this.choose = (choice) => {
      if (this.chosen) return;
      this.chosen = true;
      options.onChoose(choice);
    };
    this.buttons = options.text.items.map((item) =>
      menuButton(item.label, () => this.choose(item.id), { disabledReason: item.disabledReason, className: `confirm-screen__${item.id}` }),
    );
    const titleId = `${options.id}-title`;
    const textId = `${options.id}-text`;
    this.root = h('div', { class: `ui-screen ui-modal menu-screen confirm-screen confirm-screen--${options.id}` }, [
      h('section', { class: 'ui-panel', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': textId }, [
        h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
        h('h2', { class: 'ui-panel__title', id: titleId }, [options.text.title]),
        h('p', { class: 'ui-panel__text', id: textId }, [options.text.text]),
        ...(options.detail === undefined ? [] : [h('p', { class: 'ui-panel__text confirm-screen__detail' }, [options.detail])]),
        h('div', { class: 'ui-actions ui-actions--row' }, this.buttons),
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
    if (nav !== 'cancel') return false;
    this.choose('cancel');
    return true;
  }

  focusables(): readonly HTMLElement[] {
    return this.buttons;
  }
}
