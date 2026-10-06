// Key bindings: defaults, fixed inputs, remapping and validation (design.md "재지정과 브라우저 정책",
// "키 재지정"). Pure data and functions: no DOM.

import { REMAPPABLE_ACTIONS, type InputAction, type RemappableAction } from './actions';

/**
 * Physical input id: a `KeyboardEvent.code`, `Mouse0` / `Mouse1` / `Mouse2` (`Mouse` + `MouseEvent.button`),
 * or a gamepad `Pad*` code from `GAMEPAD_BUTTON_CODES`.
 */
export type InputCode = string;

/** One code per remappable action; valid bindings are a bijection (Req 35.3). */
export type Bindings = Record<RemappableAction, InputCode>;

export const DEFAULT_BINDINGS: Readonly<Bindings> = Object.freeze({
  moveForward: 'KeyW',
  moveBack: 'KeyS',
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  jump: 'Space',
  sprint: 'ShiftLeft',
  walkToggle: 'KeyX',
  attack: 'Mouse0',
  dodge: 'Mouse2',
  skill: 'KeyE',
  burst: 'KeyQ',
  switch1: 'Digit1',
  switch2: 'Digit2',
  switch3: 'Digit3',
  switch4: 'Digit4',
  interact: 'KeyF',
  heal: 'KeyZ',
  lockOn: 'KeyR',
  release: 'KeyC',
  map: 'KeyM',
  inventory: 'KeyI',
  quest: 'KeyJ',
} satisfies Bindings);

/**
 * Non-remappable inputs. Escape, F3, Mouse1 and the arrow keys (camera turn, always available: ADJ-02; also the
 * fixed UI navigation) are reserved; the ShiftRight sprint is a secondary that yields when the player binds
 * ShiftRight to another action.
 */
export const FIXED_INPUTS: readonly (readonly [InputCode, InputAction])[] = [
  ['Escape', 'pause'],
  ['F3', 'perfOverlay'],
  ['Mouse1', 'lockOn'],
  ['ArrowLeft', 'camLeft'],
  ['ArrowRight', 'camRight'],
  ['ArrowUp', 'camUp'],
  ['ArrowDown', 'camDown'],
  ['ShiftRight', 'sprint'],
];

/** Gamepad button codes indexed by standard-mapping `Gamepad.buttons` index. */
export const GAMEPAD_BUTTON_CODES = [
  'PadA',
  'PadB',
  'PadX',
  'PadY',
  'PadLB',
  'PadRB',
  'PadLT',
  'PadRT',
  'PadBack',
  'PadStart',
  'PadL3',
  'PadR3',
  'PadUp',
  'PadDown',
  'PadLeft',
  'PadRight',
  'PadHome',
] as const;

export type GamepadCode = (typeof GAMEPAD_BUTTON_CODES)[number];

/**
 * Fixed gamepad layout (Req 35.2). B drives both dodge and release; the controller picks by state
 * (release while climbing or gliding). RT counts as down at an analog value of 0.5 or more (adapter side).
 */
export const GAMEPAD_LAYOUT: readonly (readonly [GamepadCode, readonly InputAction[]])[] = [
  ['PadA', ['jump']],
  ['PadB', ['dodge', 'release']],
  ['PadX', ['attack']],
  ['PadY', ['interact']],
  ['PadLB', ['sprint']],
  ['PadRB', ['skill']],
  ['PadLT', ['heal']],
  ['PadRT', ['burst']],
  ['PadBack', ['map']],
  ['PadStart', ['pause']],
  ['PadR3', ['lockOn']],
  ['PadUp', ['switch1']],
  ['PadRight', ['switch2']],
  ['PadDown', ['switch3']],
  ['PadLeft', ['switch4']],
];

/**
 * Codes `remapBinding` refuses as 'reserved': browser/OS shortcuts and the fixed inputs (Escape, F3, Mouse1 and
 * the arrow keys; design "키 재지정" 2).
 */
export const RESERVED_CODES: ReadonlySet<InputCode> = new Set([
  'Escape',
  'F5',
  'F11',
  'Tab',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'F3',
  'Mouse1',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const numbered = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

/** Keyboard and mouse codes the remap flow accepts, reserved ones included. Anything else is 'unknown'. */
export const KNOWN_CODES: ReadonlySet<InputCode> = new Set([
  ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => `Key${letter}`),
  ...numbered('Digit', 0, 9),
  ...numbered('Numpad', 0, 9),
  ...numbered('F', 1, 12),
  ...['NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter'],
  ...['Space', 'Enter', 'Backspace', 'Tab', 'Escape', 'CapsLock'],
  ...['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'],
  ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'],
  ...['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote'],
  ...['Comma', 'Period', 'Slash', 'IntlBackslash'],
  ...['Mouse0', 'Mouse1', 'Mouse2'],
]);

/**
 * Maps each physical code to the actions it drives: the bindings, then fixed inputs on codes the bindings leave
 * free (valid bindings never use a reserved code, so only ShiftRight can yield), then the gamepad layout.
 */
export function buildCodeMap(bindings: Readonly<Bindings>): Map<InputCode, InputAction[]> {
  const map = new Map<InputCode, InputAction[]>();
  for (const action of REMAPPABLE_ACTIONS) {
    const actions = map.get(bindings[action]);
    if (actions) actions.push(action);
    else map.set(bindings[action], [action]);
  }
  for (const [code, action] of FIXED_INPUTS) {
    if (!map.has(code)) map.set(code, [action]);
  }
  for (const [code, actions] of GAMEPAD_LAYOUT) map.set(code, [...actions]);
  return map;
}

export type RemapResult =
  | { ok: true; bindings: Bindings; swappedWith: RemappableAction | null }
  | { ok: false; reason: 'reserved' | 'unknown' };

const REMAPPABLE = new Set<string>(REMAPPABLE_ACTIONS);

/**
 * Pure: returns new bindings with `code` on `action`; `b` is not modified. If another action uses `code`, the two
 * swap codes so the map stays a bijection (Req 35.3). The action's current code yields an equal copy with
 * `swappedWith: null`. Reserved codes are 'reserved'; codes outside KNOWN_CODES (or a fixed action) are 'unknown'.
 */
export function remapBinding(b: Readonly<Bindings>, action: RemappableAction, code: InputCode): RemapResult {
  if (!REMAPPABLE.has(action)) return { ok: false, reason: 'unknown' };
  if (RESERVED_CODES.has(code)) return { ok: false, reason: 'reserved' };
  if (!KNOWN_CODES.has(code)) return { ok: false, reason: 'unknown' };
  const swappedWith = REMAPPABLE_ACTIONS.find((other) => other !== action && b[other] === code) ?? null;
  const bindings: Bindings = { ...b };
  if (swappedWith !== null) bindings[swappedWith] = b[action];
  bindings[action] = code;
  return { ok: true, bindings, swappedWith };
}

/** Every remappable action has a known, non-reserved code and no two actions share one. Extra keys are ignored. */
export function isValidBindings(x: unknown): x is Bindings {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const record = x as Record<string, unknown>;
  const used = new Set<string>();
  for (const action of REMAPPABLE_ACTIONS) {
    const code = record[action];
    if (typeof code !== 'string' || !KNOWN_CODES.has(code) || RESERVED_CODES.has(code) || used.has(code)) {
      return false;
    }
    used.add(code);
  }
  return true;
}

/** Fresh bindings: a clean copy of `x` when valid, otherwise the defaults as a whole (no partial repair). */
export function sanitizeBindings(x: unknown): Bindings {
  const source: Readonly<Bindings> = isValidBindings(x) ? x : DEFAULT_BINDINGS;
  const bindings = {} as Bindings;
  for (const action of REMAPPABLE_ACTIONS) bindings[action] = source[action];
  return bindings;
}
