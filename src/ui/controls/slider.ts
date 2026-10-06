import './controls.css';
import { followHover, h } from '../dom';
import { setNavHandler } from '../focusNav';
import { snapValue, stepValue, valueAtRatio, valueRatio, type SliderRange } from './values';

/*
 * Slider (design "공통 스타일", Req 31.2; task 14.1): a drawn track instead of `<input type="range">`, with
 * `role="slider"` and `aria-valuenow` / `aria-valuetext`. While focused it consumes left / right (arrow keys, D-pad)
 * to step the value; the mouse drags the thumb or clicks the ◀ / ▶ ends. The fill moves with `transform` only.
 */

export interface SliderOptions extends SliderRange {
  /** Accessible name (the row label). */
  label: string;
  value: number;
  /** Shown value and `aria-valuetext`, e.g. "70%". */
  format?: (value: number) => string;
  /** Called with each new (snapped) value. */
  onChange(value: number): void;
  className?: string;
}

export interface SliderControl {
  readonly element: HTMLElement;
  readonly value: number;
  /** Shows `value` (snapped) without calling onChange. */
  set(value: number): void;
}

export function slider(options: SliderOptions): SliderControl {
  const range: SliderRange = { min: options.min, max: options.max, step: options.step };
  const format = options.format ?? ((v: number) => String(v));
  let value = snapValue(options.value, range);

  const fill = h('span', { class: 'ui-slider__fill' });
  const thumb = h('span', { class: 'ui-slider__thumb' });
  const track = h('span', { class: 'ui-slider__track' }, [fill, thumb]);
  const dec = h('span', { class: 'ui-slider__step ui-slider__step--dec', 'aria-hidden': 'true' }, ['◀']);
  const inc = h('span', { class: 'ui-slider__step ui-slider__step--inc', 'aria-hidden': 'true' }, ['▶']);
  const text = h('span', { class: 'ui-slider__value', 'aria-hidden': 'true' });
  const element = h(
    'div',
    {
      class: options.className ? `ui-slider ${options.className}` : 'ui-slider',
      role: 'slider',
      tabindex: '0',
      'aria-label': options.label,
      'aria-valuemin': String(range.min),
      'aria-valuemax': String(range.max),
    },
    [dec, track, inc, text],
  );

  const draw = (): void => {
    const ratio = valueRatio(value, range);
    element.style.setProperty('--ratio', String(ratio));
    element.setAttribute('aria-valuenow', String(value));
    const label = format(value);
    element.setAttribute('aria-valuetext', label);
    if (text.textContent !== label) text.textContent = label;
  };
  const change = (next: number): void => {
    const snapped = snapValue(next, range);
    if (snapped === value) return;
    value = snapped;
    draw();
    options.onChange(value);
  };
  draw();

  setNavHandler(element, (nav) => {
    if (nav === 'left') change(stepValue(value, -1, range));
    else if (nav === 'right') change(stepValue(value, 1, range));
    else return false;
    return true;
  });
  followHover(element);

  const fromPointer = (event: PointerEvent): void => {
    const rect = track.getBoundingClientRect(); // user input only, never per frame
    if (rect.width > 0) change(valueAtRatio((event.clientX - rect.left) / rect.width, range));
  };
  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    element.focus({ preventScroll: true });
    track.setPointerCapture?.(event.pointerId);
    fromPointer(event);
  });
  track.addEventListener('pointermove', (event) => {
    if (track.hasPointerCapture?.(event.pointerId)) fromPointer(event);
  });
  const endDrag = (event: PointerEvent): void => {
    if (track.hasPointerCapture?.(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  dec.addEventListener('click', () => change(stepValue(value, -1, range)));
  inc.addEventListener('click', () => change(stepValue(value, 1, range)));

  return {
    element,
    get value() {
      return value;
    },
    set(next: number) {
      value = snapValue(next, range);
      draw();
    },
  };
}
