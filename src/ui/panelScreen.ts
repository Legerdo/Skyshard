import './menuScreens.css';
import type { UiScreenId } from '../core/gameEvents';
import { h, menuButton } from './dom';
import type { NavInput } from './navInput';
import { FOCUSED_CLASS, type Screen } from './screenManager';

export interface PanelScreenOptions {
  /** "닫기", Esc / B: the caller pops the screen. */
  onClose(): void;
  /**
   * Moves the ScreenManager's focus to one of this screen's elements (ScreenManager.setFocus); used after a rebuild
   * so the focus stays on the same item.
   */
  focus?(element: HTMLElement): void;
}

/** What a panel's body shows now. */
export interface PanelContent {
  readonly nodes: readonly Node[];
  /** Focusable elements of the body in navigation order. */
  readonly focusables: readonly HTMLElement[];
}

/*
 * Shared frame of the menu screens (Pause, Inventory/Equipment, Quest, codex, Shop, Echo Altar, Credits; task 14.2):
 * the navy panel in the starlight gold frame with a title, an optional header row (tabs), the body and a footer with
 * "닫기". `menu` context: game time stops (Req 31.5). Esc / B closes. The body is rebuilt with `render()` whenever what
 * it shows changes (after a UiCommand has been applied, or a tab / slot choice); the focus stays on the same index.
 */
export abstract class PanelScreen implements Screen {
  abstract readonly id: UiScreenId;
  readonly context = 'menu' as const;
  protected readonly root: HTMLElement;
  protected readonly panel: HTMLElement;
  protected readonly header: HTMLElement;
  protected readonly body: HTMLElement;
  protected readonly footer: HTMLElement;
  protected readonly closeButton: HTMLButtonElement;
  protected headFocusables: HTMLElement[] = [];
  private bodyFocusables: readonly HTMLElement[] = [];
  private mounted = false;

  constructor(
    protected readonly base: PanelScreenOptions,
    title: string,
    className: string,
    closeLabel = '닫기',
  ) {
    const titleId = `${className}-title`;
    this.header = h('div', { class: 'menu-panel__header' });
    this.body = h('div', { class: 'menu-panel__body' });
    this.closeButton = menuButton(closeLabel, () => this.base.onClose(), { className: 'menu-panel__close' });
    this.footer = h('div', { class: 'menu-panel__footer' }, [this.closeButton]);
    this.panel = h('section', { class: `ui-panel menu-panel ${className}__panel`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
      h('h2', { class: 'ui-panel__title menu-panel__title', id: titleId }, [title]),
      this.header,
      this.body,
      this.footer,
    ]);
    this.root = h('div', { class: `ui-screen ui-modal menu-screen ${className}` }, [this.panel]);
  }

  /** The body's content for the current state. */
  protected abstract build(): PanelContent;

  mount(root: HTMLElement): void {
    root.append(this.root);
    this.mounted = true;
    this.render(false);
  }

  unmount(): void {
    this.mounted = false;
    this.root.remove();
  }

  onInput(nav: NavInput): boolean {
    if (nav !== 'cancel') return false;
    this.base.onClose();
    return true;
  }

  focusables(): readonly HTMLElement[] {
    return [...this.headFocusables, ...this.bodyFocusables, this.closeButton];
  }

  /** Rebuilds the body; `keepFocus` puts the focus back on the item at the same index. */
  protected render(keepFocus = true): void {
    const before = this.focusables();
    const index = before.findIndex((el) => el.classList.contains(FOCUSED_CLASS));
    const content = this.build();
    this.body.replaceChildren(...content.nodes);
    this.bodyFocusables = content.focusables;
    if (!keepFocus || !this.mounted || index < 0) return;
    const after = this.focusables();
    const target = after[Math.min(index, after.length - 1)];
    if (target !== undefined) this.base.focus?.(target);
  }
}

/** A labelled value line ("보유 Glim  1,240"). */
export function statLine(label: string, value: string): HTMLElement {
  return h('div', { class: 'menu-stat' }, [h('span', { class: 'menu-stat__label' }, [label]), h('span', { class: 'menu-stat__value' }, [value])]);
}

/** Grouping formatter for counts ("1,240"). */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.floor(n).toLocaleString('ko-KR') : '0';
}
