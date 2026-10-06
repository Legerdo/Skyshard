import './controls.css';
import { followHover, h } from '../dom';

/*
 * Tab row (task 14.1): `role="tablist"` of `role="tab"` buttons with `aria-selected` and `aria-controls`. Click,
 * Enter or A selects a tab; FocusNav moves along the row geometrically like any other row.
 */

export interface TabDef<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

export interface TabsOptions<Id extends string> {
  /** Accessible name of the tab list. */
  label: string;
  tabs: readonly TabDef<Id>[];
  selected: Id;
  /** id of the panel the tabs control. */
  panelId: string;
  onSelect(id: Id): void;
}

export interface TabsControl<Id extends string> {
  readonly element: HTMLElement;
  readonly buttons: readonly HTMLButtonElement[];
  readonly selected: Id;
  /** The tab button of `id`. */
  button(id: Id): HTMLButtonElement;
  /** Marks `id` selected without calling onSelect. */
  select(id: Id): void;
}

export function tabs<Id extends string>(options: TabsOptions<Id>): TabsControl<Id> {
  let selected = options.selected;
  const byId = new Map<Id, HTMLButtonElement>();
  const buttons = options.tabs.map((tab) => {
    const el = h('button', {
      type: 'button',
      class: 'ui-tab',
      role: 'tab',
      id: `${options.panelId}-tab-${tab.id}`,
      'aria-controls': options.panelId,
    }, [tab.label]);
    el.addEventListener('click', () => {
      if (selected === tab.id) return;
      draw(tab.id);
      options.onSelect(tab.id);
    });
    followHover(el);
    byId.set(tab.id, el);
    return el;
  });
  const draw = (id: Id): void => {
    selected = id;
    for (const tab of options.tabs) {
      const el = byId.get(tab.id);
      el?.setAttribute('aria-selected', tab.id === id ? 'true' : 'false');
      el?.classList.toggle('is-selected', tab.id === id);
    }
  };
  draw(selected);
  const element = h('div', { class: 'ui-tabs', role: 'tablist', 'aria-label': options.label }, buttons);
  return {
    element,
    buttons,
    get selected() {
      return selected;
    },
    button(id: Id) {
      const el = byId.get(id);
      if (el === undefined) throw new Error(`Unknown tab ${id}`);
      return el;
    },
    select: draw,
  };
}
