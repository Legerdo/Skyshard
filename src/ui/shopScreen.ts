import type { UiCommand } from '../core/uiCommands';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { h, menuButton } from './dom';
import { shopRows } from './models/shopModel';
import { formatCount, PanelScreen, statLine, type PanelContent, type PanelScreenOptions } from './panelScreen';

export interface ShopScreenOptions extends PanelScreenOptions {
  state(): DeepReadonly<Pick<GameState, 'inventory'>>;
  run(command: UiCommand): void;
}

/*
 * Pip's shop (design "화면 목록" Shop, task 14.2; Req 14.11, 14.12): the stock with prices, held counts and the Glim on
 * hand. Each row is judged with the same `purchase` rule the Inventory_System applies: a refused item's button is
 * disabled with "보유 중" / "보유 한도" and the missing Glim. "구매" queues the `purchase` UiCommand; the screen redraws
 * from the inventory after it has been applied.
 */
export class ShopScreen extends PanelScreen {
  readonly id = 'shop';
  private readonly o: ShopScreenOptions;

  constructor(options: ShopScreenOptions) {
    super(options, 'Pip의 상점', 'shop-screen');
    this.o = options;
  }

  protected build(): PanelContent {
    const state = this.o.state();
    const focusables: HTMLElement[] = [];
    const rows = shopRows(state).map((row) => {
      const command = row.command;
      const button = menuButton(`구매 · ${row.priceText}`, () => {
        if (command === null) return;
        this.o.run(command);
        this.render();
      }, { disabledReason: row.enabled ? null : row.status, className: 'shop-row__buy' });
      focusables.push(button);
      return h('li', { class: `shop-row${row.enabled ? '' : ' is-disabled'}` }, [
        h('div', { class: 'shop-row__info' }, [
          h('div', { class: 'shop-row__name' }, [row.name]),
          h('p', { class: 'shop-row__desc' }, [row.description]),
          ...(row.heldText === '' ? [] : [h('span', { class: 'shop-row__held' }, [row.heldText])]),
        ]),
        button,
      ]);
    });
    return {
      nodes: [statLine('보유 Glim', formatCount(state.inventory.glim)), h('ul', { class: 'shop-list' }, rows)],
      focusables,
    };
  }
}
