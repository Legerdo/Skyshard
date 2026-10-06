import { creditSections } from '../data/credits';
import { h } from './dom';
import { PanelScreen, type PanelContent, type PanelScreenOptions } from './panelScreen';

/*
 * Credits (design "화면 목록" Credits, tasks 14.2 / 25.2; Req 31.1, 40.3): the Title's "크레딧" shows the same sources as
 * CREDITS.md, read from src/data/credits.ts (tests/unit/credits.test.ts keeps the two in sync). The body scrolls;
 * "닫기" or Esc / B returns to the Title menu.
 */
export class CreditsScreen extends PanelScreen {
  readonly id = 'credits';

  constructor(options: PanelScreenOptions) {
    super(options, '크레딧', 'credits-screen');
  }

  protected build(): PanelContent {
    const nodes = creditSections().map((section) =>
      h('section', { class: 'credits-screen__section' }, [
        h('h3', { class: 'menu-panel__heading' }, [section.title]),
        h('ul', { class: 'credits-screen__lines' }, section.lines.map((line) => h('li', {}, [line]))),
      ]),
    );
    return { nodes, focusables: [] };
  }
}
