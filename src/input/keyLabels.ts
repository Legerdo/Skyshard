// Short on-screen names for physical input codes: the interaction prompt (Req 14.3) and Tutorial_Hint key
// icons (Req 34.3) show the key currently bound to an action. Pure: no DOM.

import type { InputCode } from './bindings';

const NAMED: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Esc',
  CapsLock: 'Caps',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Insert: 'Ins',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
  Mouse0: '좌클릭',
  Mouse1: '휠 클릭',
  Mouse2: '우클릭',
};

/**
 * Display name of an input code: `KeyF` → "F", `Digit1` → "1", `Numpad4` → "Num 4", `Mouse0` → "좌클릭",
 * `PadY` → "Y". Codes without a known short form are shown as they are.
 */
export function keyLabel(code: InputCode): string {
  const named = NAMED[code];
  if (named !== undefined) return named;
  const key = /^Key([A-Z])$/.exec(code);
  if (key) return key[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `Num ${numpad[1]}`;
  const pad = /^Pad(.+)$/.exec(code);
  if (pad) return pad[1];
  return code;
}
