import type { ReactionId } from '../data/ids';
import { h } from './dom';
import { ICON_LABELS, icon } from './icons';
import { CODEX_RULE, codexCells, codexProgressText } from './models/menuModels';
import { PanelScreen, type PanelContent, type PanelScreenOptions } from './panelScreen';

export interface CodexScreenOptions extends PanelScreenOptions {
  /** `GameState.codex`, read when the screen opens. */
  codex(): readonly ReactionId[];
}

/*
 * 속성 반응 도감 (design "화면 목록", task 14.2; Req 25.13): one cell per reaction of table B. A discovered reaction
 * shows its name, the two Element icons of its pair and its effect; the rest are locked cells ("???"). The learning
 * rule, the same sentence as the tutorial, sits under the grid. Read only.
 */
export class CodexScreen extends PanelScreen {
  readonly id = 'codex';
  private readonly o: CodexScreenOptions;

  constructor(options: CodexScreenOptions) {
    super(options, '속성 반응 도감', 'codex-screen');
    this.o = options;
  }

  protected build(): PanelContent {
    const codex = this.o.codex();
    const cells = codexCells(codex).map((cell) =>
      h('li', { class: `codex-cell${cell.discovered ? '' : ' is-locked'}`, 'aria-label': cell.discovered ? `${cell.name}: ${cell.effect}` : '발견하지 않은 반응' }, [
        h('div', { class: 'codex-cell__pair', 'aria-hidden': 'true' }, cell.pair === null
          ? [h('span', { class: 'codex-cell__lock' })]
          : [icon(cell.pair[0], { label: ICON_LABELS[cell.pair[0]] }), h('span', { class: 'codex-cell__plus' }, ['+']), icon(cell.pair[1], { label: ICON_LABELS[cell.pair[1]] })]),
        h('div', { class: 'codex-cell__name' }, [cell.name]),
        ...(cell.discovered ? [h('p', { class: 'codex-cell__effect' }, [cell.effect])] : []),
      ]),
    );
    return {
      nodes: [
        h('p', { class: 'menu-panel__note' }, [codexProgressText(codex)]),
        h('ul', { class: 'codex-grid' }, cells),
        h('p', { class: 'codex-screen__rule' }, [CODEX_RULE]),
      ],
      focusables: [],
    };
  }
}
