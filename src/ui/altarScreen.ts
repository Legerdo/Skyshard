import type { UiCommand } from '../core/uiCommands';
import { CHARACTERS } from '../data/characters';
import { CHARACTER_IDS, type CharacterId } from '../data/ids';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { tabs, type TabsControl } from './controls';
import { h, menuButton } from './dom';
import { altarRows } from './models/altarModel';
import { formatCount, PanelScreen, statLine, type PanelContent, type PanelScreenOptions } from './panelScreen';

export interface AltarScreenOptions extends PanelScreenOptions {
  state(): DeepReadonly<Pick<GameState, 'party' | 'inventory'>>;
  run(command: UiCommand): void;
}

const STARMOTE = 'mat_starmote';

/*
 * Echo Altar (Old Bram; design "능력 강화 (Echo Altar)", task 14.2; Req 29.4–29.6): a tab per joined character, and for
 * that character its Skill and Burst with the current and next tier side by side, the next tier's cost and the
 * Starmote / Glim on hand. The button follows `canUpgradeAbility`: short amounts disable it with "Starmote 2 · Glim 150
 * 부족", tier 3 reads "최대". "강화" queues `upgradeAbility`; the screen redraws after it has been applied.
 */
export class AltarScreen extends PanelScreen {
  readonly id = 'echoAltar';
  private readonly o: AltarScreenOptions;
  private readonly tabBar: TabsControl<CharacterId>;
  private character: CharacterId;

  constructor(options: AltarScreenOptions) {
    super(options, 'Echo Altar', 'altar-screen');
    this.o = options;
    const joined = CHARACTER_IDS.filter((id) => options.state().party.joined.includes(id));
    this.character = joined.includes(options.state().party.active) ? options.state().party.active : (joined[0] ?? 'kairen');
    this.tabBar = tabs({
      label: '강화할 캐릭터',
      tabs: joined.map((id) => ({ id, label: CHARACTERS[id].name })),
      selected: this.character,
      panelId: 'altar-screen-body',
      onSelect: (id) => {
        this.character = id;
        this.render();
      },
    });
    this.body.id = 'altar-screen-body';
    this.body.setAttribute('role', 'tabpanel');
    this.header.append(this.tabBar.element);
    this.headFocusables = [...this.tabBar.buttons];
  }

  protected build(): PanelContent {
    const state = this.o.state();
    const focusables: HTMLElement[] = [];
    const rows = altarRows(state, this.character).map((row) => {
      const command = row.command;
      const button = menuButton(row.buttonText, () => {
        if (command === null) return;
        this.o.run(command);
        this.render();
      }, { disabledReason: row.maxed ? null : row.enabled ? null : row.missingText || null, className: 'altar-row__upgrade' });
      if (row.maxed) button.setAttribute('aria-disabled', 'true');
      focusables.push(button);
      return h('li', { class: `altar-row${row.maxed ? ' is-maxed' : ''}` }, [
        h('div', { class: 'altar-row__head' }, [
          h('span', { class: 'altar-row__kind' }, [row.kind]),
          h('span', { class: 'altar-row__name' }, [row.name]),
          h('span', { class: 'altar-row__tier' }, [row.tierText]),
        ]),
        h('div', { class: 'altar-row__compare' }, [
          h('div', { class: 'altar-row__now' }, [h('span', { class: 'menu-label' }, ['현재']), row.current]),
          h('span', { class: 'altar-row__arrow', 'aria-hidden': 'true' }, ['→']),
          h('div', { class: 'altar-row__next' }, [h('span', { class: 'menu-label' }, ['다음 단계']), row.next]),
        ]),
        ...(row.costText === '' ? [] : [h('p', { class: 'altar-row__cost' }, [`비용: ${row.costText}`])]),
        button,
      ]);
    });
    return {
      nodes: [
        h('div', { class: 'menu-stats' }, [
          statLine('보유 Starmote', formatCount(state.inventory.items[STARMOTE] ?? 0)),
          statLine('보유 Glim', formatCount(state.inventory.glim)),
        ]),
        h('ul', { class: 'altar-list' }, rows),
      ],
      focusables,
    };
  }
}
