import type { UiCommand } from '../core/uiCommands';
import type { QuestState } from '../logic/quest/types';
import type { DeepReadonly } from '../logic/save/gameState';
import { h, menuButton } from './dom';
import { questView } from './models/menuModels';
import { PanelScreen, type PanelContent, type PanelScreenOptions } from './panelScreen';

export interface QuestScreenOptions extends PanelScreenOptions {
  /** The read-only quest state (read on every rebuild). */
  quests(): DeepReadonly<QuestState>;
  /** Queues a UiCommand (applied before the screen redraws). */
  run(command: UiCommand): void;
}

/*
 * Quest screen (design "화면 목록" Quest, task 14.2; Req 15.4): the Main_Quest's current stage and Objective, then the
 * accepted Side_Quests (진행 중 first, then 완료) with the tracking toggle. Tracking is the `trackQuest` UiCommand;
 * the screen redraws from the state after it has been applied.
 */
export class QuestScreen extends PanelScreen {
  readonly id = 'quest';
  private readonly o: QuestScreenOptions;

  constructor(options: QuestScreenOptions) {
    super(options, '퀘스트', 'quest-screen');
    this.o = options;
  }

  protected build(): PanelContent {
    const view = questView(this.o.quests());
    const focusables: HTMLElement[] = [];
    const main = h('section', { class: `quest-card quest-card--main${view.main.tracked ? ' is-tracked' : ''}` }, [
      h('div', { class: 'quest-card__kind' }, [view.main.tracked ? '메인 퀘스트 · 추적 중' : '메인 퀘스트']),
      h('h3', { class: 'quest-card__name' }, [view.main.stage]),
      h('p', { class: 'quest-card__objective' }, [view.main.objective]),
    ]);
    const rows = view.sides.map((row) => {
      const children: Node[] = [
        h('div', { class: 'quest-card__kind' }, [`보조 퀘스트 · ${row.statusText}${row.tracked ? ' · 추적 중' : ''}`]),
        h('h3', { class: 'quest-card__name' }, [row.name]),
      ];
      if (row.objective !== '') children.push(h('p', { class: 'quest-card__objective' }, [row.objective]));
      const command = row.command;
      if (command !== null) {
        const button = menuButton(row.buttonText, () => {
          this.o.run(command);
          this.render();
        }, { className: 'quest-card__track' });
        focusables.push(button);
        children.push(button);
      }
      return h('section', { class: `quest-card${row.tracked ? ' is-tracked' : ''}${row.status === 'done' ? ' is-done' : ''}` }, children);
    });
    const nodes: Node[] = [main];
    if (rows.length === 0) nodes.push(h('p', { class: 'menu-panel__note' }, ['받은 보조 퀘스트가 없습니다. 마을 사람들과 이야기해 보세요.']));
    else nodes.push(h('div', { class: 'quest-list' }, rows));
    return { nodes, focusables };
  }
}
