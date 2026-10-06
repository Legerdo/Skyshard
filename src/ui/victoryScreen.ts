import './victoryScreen.css';
import { h, menuButton } from './dom';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';
import { VICTORY_TEXT, victoryMenuItems, victoryRankRows, victoryStatRows, type StatRow, type VictoryMenuId } from './screenModels';
import type { VictoryView } from './victoryView';

export interface VictoryScreenOptions {
  view: VictoryView;
  /** "탐험 계속": the caller closes the screen and queues the `continueExploring` UiCommand (Req 7.5). */
  onContinueExploring(): void;
  /** "메인 메뉴": the caller puts the Title Screen back at the bottom of the stack. */
  onMainMenu(): void;
}

function statList(rows: readonly StatRow[], className: string): HTMLElement {
  return h(
    'dl',
    { class: className },
    rows.map((row) => h('div', { class: 'victory-screen__row' }, [h('dt', {}, [row.label]), h('dd', {}, [row.value])])),
  );
}

/*
 * Victory Screen (design "화면 목록" Victory, Req 7.3, 7.4, 7.7): opened when the ending cinematic `cin_ending`
 * ends. Shows the VictoryView built once on opening: play time, enemies defeated, places and Chests found out of
 * all, completed quests, the final party level, each character's Skill / Burst rank and, when Debug_Tools were
 * used, "디버그 사용됨". Buttons "탐험 계속" and "메인 메뉴". `menu` context; Esc / B does not close it.
 */
export class VictoryScreen implements Screen {
  readonly id = 'victory';
  readonly context = 'menu';
  private readonly root: HTMLElement;
  private readonly buttons: HTMLButtonElement[];
  private chosen = false;

  constructor(options: VictoryScreenOptions) {
    const actions: Record<VictoryMenuId, () => void> = {
      continueExploring: options.onContinueExploring,
      mainMenu: options.onMainMenu,
    };
    this.buttons = victoryMenuItems().map((item) =>
      menuButton(item.label, () => {
        if (this.chosen) return;
        this.chosen = true;
        actions[item.id]();
      }),
    );
    const { view } = options;
    this.root = h('div', { class: 'ui-screen ui-modal victory-screen' }, [
      h('section', { class: 'ui-panel victory-screen__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'victory-title' }, [
        h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
        h('h2', { class: 'ui-panel__title', id: 'victory-title' }, [VICTORY_TEXT.title]),
        h('p', { class: 'ui-panel__text' }, [VICTORY_TEXT.subtitle]),
        view.debugUsed ? h('p', { class: 'victory-screen__debug' }, [VICTORY_TEXT.debugUsed]) : '',
        statList(victoryStatRows(view), 'victory-screen__stats'),
        h('h3', { class: 'victory-screen__heading' }, [VICTORY_TEXT.ranksHeading]),
        statList(victoryRankRows(view), 'victory-screen__stats victory-screen__stats--ranks'),
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
    return nav === 'cancel';
  }

  focusables(): readonly HTMLElement[] {
    return this.buttons;
  }
}
