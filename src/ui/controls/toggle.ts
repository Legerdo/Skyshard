import './controls.css';
import { flashPressed, followHover, h } from '../dom';

/*
 * On / off switch (design "공통 스타일", Req 31.2; task 14.1): a `<button role="switch" aria-checked>` drawn as a
 * track and knob instead of a checkbox, with the state in words ("켬" / "끔") so it does not rely on colour.
 * Click, Enter or A flips it.
 */

export interface SwitchOptions {
  /** Accessible name (the row label). */
  label: string;
  value: boolean;
  onChange(value: boolean): void;
  onText?: string;
  offText?: string;
}

export interface SwitchControl {
  readonly element: HTMLButtonElement;
  readonly value: boolean;
  /** Shows `value` without calling onChange. */
  set(value: boolean): void;
}

export function toggleSwitch(options: SwitchOptions): SwitchControl {
  const onText = options.onText ?? '켬';
  const offText = options.offText ?? '끔';
  let value = options.value;
  const state = h('span', { class: 'ui-switch__state', 'aria-hidden': 'true' });
  const element = h(
    'button',
    { type: 'button', class: 'ui-switch', role: 'switch', 'aria-label': options.label },
    [h('span', { class: 'ui-switch__track', 'aria-hidden': 'true' }, [h('span', { class: 'ui-switch__knob' })]), state],
  );
  const draw = (): void => {
    element.setAttribute('aria-checked', value ? 'true' : 'false');
    state.textContent = value ? onText : offText;
  };
  draw();
  element.addEventListener('click', () => {
    value = !value;
    draw();
    flashPressed(element);
    options.onChange(value);
  });
  followHover(element);
  return {
    element,
    get value() {
      return value;
    },
    set(next: boolean) {
      value = next;
      draw();
    },
  };
}
