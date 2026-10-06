/*
 * DOM helpers for screens (design "UI 구조"): `h(tag, props, children)` copies `class`, `style`, `on*` handlers
 * and other attributes (`aria-*`, `role`, `type`, ...) onto a new element and appends the children. Strings
 * become text nodes, never HTML (no innerHTML). No virtual DOM or diffing: screens keep references to the
 * elements they update.
 */
import './screens.css';
import { FOCUSED_CLASS } from './screenManager';

export type Child = Node | string;
export type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children);
  return el;
}

export interface MenuButtonOptions {
  /**
   * Shown under the label when the button cannot be used ("저장 데이터 없음"). Such a button stays focusable
   * (`aria-disabled`, not `disabled`) so its reason can be read, and activating it does nothing.
   */
  disabledReason?: string | null;
  /** Extra class names. */
  className?: string;
}

/**
 * Menu button in the game's style. Mouse hover moves the focus to it (the ScreenManager follows through
 * `focusin`), and a click, Enter or gamepad A runs `onActivate` unless the button is disabled.
 */
export function menuButton(label: string, onActivate: () => void, options: MenuButtonOptions = {}): HTMLButtonElement {
  const reason = options.disabledReason ?? null;
  const button = h(
    'button',
    {
      type: 'button',
      class: options.className ? `ui-button ${options.className}` : 'ui-button',
      'aria-disabled': reason !== null ? 'true' : undefined,
    },
    [h('span', { class: 'ui-button__label' }, [label])],
  );
  if (reason !== null) button.append(h('span', { class: 'ui-button__reason' }, [reason]));
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    flashPressed(button);
    onActivate();
  });
  followHover(button);
  return button;
}

/** Pressed look (scale 0.97, gold face) for 0.08 s, also for Enter / A, which never set `:active` (task 14.1). */
export const PRESSED_CLASS = 'is-pressed';
const PRESSED_MS = 80;

export function flashPressed(el: Element): void {
  el.classList.add(PRESSED_CLASS);
  setTimeout(() => el.classList.remove(PRESSED_CLASS), PRESSED_MS);
}

/** Mouse hover moves the DOM focus to `el`; the ScreenManager follows through `focusin` (task 14.1 FocusNav). */
export function followHover(el: HTMLElement): void {
  el.addEventListener('pointerenter', () => {
    if (!el.classList.contains(FOCUSED_CLASS) && !el.closest('[inert]')) el.focus({ preventScroll: true });
  });
}
