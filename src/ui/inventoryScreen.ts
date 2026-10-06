import type { EquipSlot, UiCommand } from '../core/uiCommands';
import { CHARACTERS } from '../data/characters';
import { CHARACTER_IDS, type CharacterId } from '../data/ids';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { tabs, type TabsControl } from './controls';
import { h, menuButton } from './dom';
import { consumableRows, equipmentCandidates, equipmentSlots, type EquipmentComparison } from './models/inventoryModel';
import { formatCount, PanelScreen, statLine, type PanelContent, type PanelScreenOptions } from './panelScreen';

export interface InventoryScreenOptions extends PanelScreenOptions {
  state(): DeepReadonly<Pick<GameState, 'party' | 'inventory'>>;
  /** The herb dumpling's remaining reuse wait (s). */
  healCooldown(): number;
  run(command: UiCommand): void;
}

/*
 * Inventory / Equipment (design "화면 목록", task 14.2; Req 30.2, 30.3, 27.5, 27.6): a tab per joined character with
 * its Weapon and Charm slots and the party Relic slot. Choosing a slot lists the owned items that fit it (and
 * "장착 해제"), each with the slot's effect before and after side by side, refused ones disabled with the reason; the
 * last change stays shown as a before / after comparison. Consumables below: the herb dumpling (Active_Character) and
 * the Ember Feather, which asks for a Downed target. Every change is a UiCommand; the screen redraws after it has been
 * applied.
 */
export class InventoryScreen extends PanelScreen {
  readonly id = 'inventory';
  private readonly o: InventoryScreenOptions;
  private readonly tabBar: TabsControl<CharacterId>;
  private character: CharacterId;
  private slot: EquipSlot | null = null;
  private lastChange: EquipmentComparison | null = null;

  constructor(options: InventoryScreenOptions) {
    super(options, '인벤토리 · 장비', 'inventory-screen');
    this.o = options;
    const party = options.state().party;
    const joined = CHARACTER_IDS.filter((id) => party.joined.includes(id));
    this.character = joined.includes(party.active) ? party.active : (joined[0] ?? 'kairen');
    this.tabBar = tabs({
      label: '캐릭터',
      tabs: joined.map((id) => ({ id, label: CHARACTERS[id].name })),
      selected: this.character,
      panelId: 'inventory-screen-body',
      onSelect: (id) => {
        this.character = id;
        this.slot = null;
        this.lastChange = null;
        this.render();
      },
    });
    this.body.id = 'inventory-screen-body';
    this.body.setAttribute('role', 'tabpanel');
    this.header.append(this.tabBar.element);
    this.headFocusables = [...this.tabBar.buttons];
  }

  protected build(): PanelContent {
    const state = this.o.state();
    const focusables: HTMLElement[] = [];
    const character = this.character;

    const slots = equipmentSlots(state, character).map((view) => {
      const open = this.slot === view.slot;
      const button = menuButton(`${view.label} · ${view.name}`, () => {
        this.slot = open ? null : view.slot;
        this.lastChange = null;
        this.render();
      }, { className: `inventory-slot${open ? ' is-open' : ''}` });
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.append(h('span', { class: 'inventory-slot__effect' }, [view.effect]));
      focusables.push(button);
      return button;
    });
    const nodes: Node[] = [h('h3', { class: 'menu-panel__heading' }, [`${CHARACTERS[character].name}의 장비`]), h('div', { class: 'inventory-slots' }, slots)];

    if (this.lastChange !== null) nodes.push(comparison(this.lastChange, '변경 완료'));
    if (this.slot !== null) {
      const list = equipmentCandidates(state, character, this.slot).map((c) => {
        const command = c.command;
        const label = c.itemId === null ? '장착 해제' : c.after.name;
        const button = menuButton(label, () => {
          if (command === null) return;
          this.o.run(command);
          this.lastChange = c;
          this.render();
        }, { disabledReason: c.allowed ? null : c.reasonText, className: 'inventory-candidate__pick' });
        focusables.push(button);
        return h('li', { class: 'inventory-candidate' }, [button, comparison(c, null)]);
      });
      nodes.push(h('ul', { class: 'inventory-candidates', 'aria-label': '장착 후보' }, list));
    }

    const consumables = consumableRows(state, this.o.healCooldown()).map((row) => {
      const actions: HTMLElement[] = [];
      if (row.targets.length > 0) {
        for (const target of row.targets) {
          const b = menuButton(`${target.name}에게 사용`, () => {
            this.o.run(target.command);
            this.render();
          }, { className: 'inventory-item__use' });
          focusables.push(b);
          actions.push(b);
        }
      } else {
        const command = row.command;
        const b = menuButton('사용', () => {
          if (command === null) return;
          this.o.run(command);
          this.render();
        }, { disabledReason: row.usable ? null : row.reasonText, className: 'inventory-item__use' });
        focusables.push(b);
        actions.push(b);
      }
      return h('li', { class: 'inventory-item' }, [
        h('div', { class: 'inventory-item__info' }, [
          h('div', { class: 'inventory-item__name' }, [`${row.name} `, h('span', { class: 'inventory-item__count' }, [row.countText])]),
          h('p', { class: 'inventory-item__desc' }, [row.description]),
        ]),
        h('div', { class: 'inventory-item__actions' }, actions),
      ]);
    });
    nodes.push(
      h('h3', { class: 'menu-panel__heading' }, ['소비 아이템']),
      h('ul', { class: 'inventory-items' }, consumables),
      statLine('보유 Glim', formatCount(state.inventory.glim)),
    );
    return { nodes, focusables };
  }
}

/** The slot's effect before and after, side by side (Req 30.3). */
function comparison(c: EquipmentComparison, heading: string | null): HTMLElement {
  return h('div', { class: `inventory-compare${c.allowed ? '' : ' is-refused'}` }, [
    ...(heading === null ? [] : [h('div', { class: 'inventory-compare__heading' }, [heading])]),
    h('div', { class: 'inventory-compare__side' }, [h('span', { class: 'menu-label' }, ['변경 전']), `${c.before.name} — ${c.before.effect}`]),
    h('span', { class: 'inventory-compare__arrow', 'aria-hidden': 'true' }, ['→']),
    h('div', { class: 'inventory-compare__side' }, [h('span', { class: 'menu-label' }, ['변경 후']), `${c.after.name} — ${c.after.effect}`]),
    ...(c.movedText === '' ? [] : [h('p', { class: 'inventory-compare__note' }, [c.movedText])]),
  ]);
}
