// Logical input actions, input contexts and buffer/charge timings (design.md "입력 아키텍처").
// Pure data: no DOM, so it runs in Node tests.

/** Every action game code reads. Physical inputs reach these only through bindings. */
export const INPUT_ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'jump',
  'sprint',
  'walkToggle',
  'attack',
  'dodge',
  'skill',
  'burst',
  'switch1',
  'switch2',
  'switch3',
  'switch4',
  'interact',
  'heal',
  'lockOn',
  'release',
  'map',
  'inventory',
  'quest',
  'pause',
  'camLeft',
  'camRight',
  'camUp',
  'camDown',
  'perfOverlay',
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];

/**
 * Actions tied to fixed inputs the player cannot rebind: Escape (pause), F3 (perfOverlay) and the arrow keys
 * (camera turn, ADJ-02), which are also the fixed UI navigation keys (design "키 재지정": 고정 동작 `pause`,
 * `perfOverlay`, `camLeft`~`camDown`; task 14.4).
 */
export const FIXED_ACTIONS = [
  'pause',
  'perfOverlay',
  'camLeft',
  'camRight',
  'camUp',
  'camDown',
] as const satisfies readonly InputAction[];

export type FixedAction = (typeof FIXED_ACTIONS)[number];
export type RemappableAction = Exclude<InputAction, FixedAction>;

const FIXED = new Set<InputAction>(FIXED_ACTIONS);

/** Actions stored in `Settings.bindings`, in `INPUT_ACTIONS` order. */
export const REMAPPABLE_ACTIONS: readonly RemappableAction[] = INPUT_ACTIONS.filter(
  (action): action is RemappableAction => !FIXED.has(action),
);

/** Movement actions; their keys stay down across context switches. */
export const MOVE_ACTIONS = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
] as const satisfies readonly InputAction[];

export type InputContext = 'gameplay' | 'menu' | 'dialogue' | 'cinematic' | 'map';

const actionSet = (...actions: InputAction[]): ReadonlySet<InputAction> => new Set(actions);

/** Actions each context lets through (design "입력 컨텍스트와 샘플링"); the rest read as idle. */
export const CONTEXT_ACTIONS: Readonly<Record<InputContext, ReadonlySet<InputAction>>> = {
  gameplay: actionSet(...INPUT_ACTIONS),
  menu: actionSet('pause', 'map', 'inventory', 'quest', 'perfOverlay'),
  dialogue: actionSet('interact', 'jump', 'attack', 'pause', 'perfOverlay'),
  cinematic: actionSet('pause', 'jump', 'perfOverlay'),
  map: actionSet('map', 'pause', 'perfOverlay'),
};

/** Presses kept in the input buffer (landing jump, combo attack, recovery dodge cancel). */
export const BUFFERED_ACTIONS = ['jump', 'attack', 'dodge'] as const satisfies readonly InputAction[];

export type BufferedAction = (typeof BUFFERED_ACTIONS)[number];

/** How long a buffered press stays consumable (s, sim time). */
export const BUFFER_SECONDS = 0.15;

/** Minimum `attack` hold that triggers Charged_Attack on release (s, sim time; Req 24.3). */
export const CHARGE_SECONDS = 0.4;
