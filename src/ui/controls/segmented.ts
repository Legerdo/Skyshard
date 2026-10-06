import './controls.css';
import { flashPressed, followHover, h } from '../dom';

/*
 * Segmented choice (task 14.1): a `role="radiogroup"` row of `role="radio"` buttons (`aria-checked`) for small
 * enumerations such as 낮음 / 보통 / 높음, instead of a `<select>`. Each option is focusable, so FocusNav moves
 * between them with left / right; click, Enter or A picks one. `value` may be null (none checked, e.g. the quality
 * preset while "사용자 지정").
 */

export interface SegmentOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SegmentedOptions<V extends string> {
  /** Accessible name (the row label). */
  label: string;
  options: readonly SegmentOption<V>[];
  value: V | null;
  onChange(value: V): void;
}

export interface SegmentedControl<V extends string> {
  readonly element: HTMLElement;
  readonly buttons: readonly HTMLButtonElement[];
  /** Checks `value` (null: none) without calling onChange. */
  set(value: V | null): void;
}

export function segmented<V extends string>(options: SegmentedOptions<V>): SegmentedControl<V> {
  let value = options.value;
  const buttons = options.options.map((option) => {
    const el = h('button', { type: 'button', class: 'ui-segment', role: 'radio' }, [option.label]);
    el.addEventListener('click', () => {
      flashPressed(el);
      // Picking the checked option again still reports it (re-applies a preset after "사용자 지정").
      draw(option.value);
      options.onChange(option.value);
    });
    followHover(el);
    return el;
  });
  const draw = (next: V | null): void => {
    value = next;
    options.options.forEach((option, i) => {
      buttons[i].setAttribute('aria-checked', option.value === value ? 'true' : 'false');
    });
  };
  draw(value);
  const element = h('div', { class: 'ui-segmented', role: 'radiogroup', 'aria-label': options.label }, buttons);
  return { element, buttons, set: draw };
}
