import './controls.css';
import { h, menuButton, type MenuButtonOptions } from '../dom';

/*
 * Game-styled button (design "버튼 상태", Req 31.2; task 14.1): a `<button>` with every browser look removed and the
 * shard-face style of `.ui-button`: hover and focus (gold ring, lighter face), pressed for 0.08 s (scale 0.97, gold
 * face; also for Enter / A) and disabled with a reason ("Glim 120 부족"). A disabled button uses `aria-disabled`,
 * not `disabled`, so it keeps the focus and its reason can be read; activating it does nothing (the ScreenManager
 * reports a refusal for the UI sound).
 */

export type ButtonOptions = MenuButtonOptions;

export function button(label: string, onActivate: () => void, options: ButtonOptions = {}): HTMLButtonElement {
  return menuButton(label, onActivate, options);
}

/** Changes a button's disabled state and reason in place (null enables it). */
export function setDisabledReason(target: HTMLButtonElement, reason: string | null): void {
  let reasonEl = target.querySelector<HTMLElement>('.ui-button__reason');
  if (reason === null) {
    target.removeAttribute('aria-disabled');
    reasonEl?.remove();
    return;
  }
  target.setAttribute('aria-disabled', 'true');
  if (reasonEl === null) {
    reasonEl = h('span', { class: 'ui-button__reason' });
    target.append(reasonEl);
  }
  if (reasonEl.textContent !== reason) reasonEl.textContent = reason;
}

/** Changes the label text of a button made by `button` / `menuButton`. */
export function setButtonLabel(target: HTMLButtonElement, label: string): void {
  const labelEl = target.querySelector<HTMLElement>('.ui-button__label');
  if (labelEl !== null && labelEl.textContent !== label) labelEl.textContent = label;
}
