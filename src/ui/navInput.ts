/*
 * Fixed UI navigation (design "포커스 탐색과 전환", "입력 컨텍스트와 샘플링"; Req 31.7): arrow keys, Enter and Esc
 * on the keyboard and D-pad, A and B on a gamepad become one NavInput for the top screen. These inputs are not
 * remappable. The mapping is pure; `installNavKeyGuard` is the only DOM part.
 */
import type { InputCode } from '../input/bindings';

export type NavInput = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'cancel';

const NAV_CODES: Readonly<Record<string, NavInput>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Escape: 'cancel',
  PadUp: 'up',
  PadDown: 'down',
  PadLeft: 'left',
  PadRight: 'right',
  PadA: 'confirm',
  PadB: 'cancel',
};

/** The navigation meaning of a key or gamepad button going down, or null for any other input. */
export function navFromCode(code: InputCode): NavInput | null {
  return Object.hasOwn(NAV_CODES, code) ? NAV_CODES[code] : null;
}

/** Keys whose browser default would activate a focused `<button>` a second time. */
const ACTIVATION_CODES: ReadonlySet<string> = new Set(['Enter', 'NumpadEnter', 'Space']);

/**
 * While `active()` (a menu screen is on top), blocks the browser's own button activation for Enter and Space,
 * so `confirm` is the only path that clicks the focused item (no double activation). Returns the remover.
 */
export function installNavKeyGuard(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, active: () => boolean): () => void {
  const guard = (event: KeyboardEvent): void => {
    if (ACTIVATION_CODES.has(event.code) && active()) event.preventDefault();
  };
  target.addEventListener('keydown', guard, true);
  target.addEventListener('keyup', guard, true);
  return () => {
    target.removeEventListener('keydown', guard, true);
    target.removeEventListener('keyup', guard, true);
  };
}
