/*
 * Key remap flow of the Settings screen (design "키 재지정", Req 35.3; task 14.4). Pure state machine; the screen
 * feeds it raw input codes and shows the outcomes:
 * 1. `begin(action, trigger)`: "새 키를 누르세요". `trigger` is the input that chose the action and is still held
 *    (Enter, PadA); the flow listens only once it is released ('armed' until then). A mouse click has already been
 *    released, so it listens at once.
 * 2. The first `keydown` (`KeyboardEvent.code`) or `mousedown` (`Mouse` + button) then goes to the pure
 *    `remapBinding`: reserved and fixed codes are refused as 'reserved', codes outside the supported list as
 *    'unknown'; a refusal keeps the bindings and waits for the next input. Escape and gamepad B cancel the remap only
 *    (the Settings screen stays open); other gamepad buttons are refused (the gamepad layout is fixed, Req 35.2).
 * 3. A code another action used swaps the two actions' codes: "점프 ↔ 상호작용: 키를 서로 바꿨습니다".
 * "기본값으로" is `DEFAULT_BINDINGS` as a whole (the screen sets it directly).
 */
import type { RemappableAction } from '../input/actions';
import { remapBinding, type Bindings, type InputCode } from '../input/bindings';
import { keyLabel } from '../input/keyLabels';

/** Short Korean names of the remappable actions (proper game terms stay English, Req 35.4). */
export const ACTION_LABELS: Readonly<Record<RemappableAction, string>> = {
  moveForward: '앞으로 이동',
  moveBack: '뒤로 이동',
  moveLeft: '왼쪽으로 이동',
  moveRight: '오른쪽으로 이동',
  jump: '점프',
  sprint: '질주',
  walkToggle: '걷기 전환',
  attack: '공격',
  dodge: 'Dodge',
  skill: 'Skill',
  burst: 'Burst',
  switch1: '동료 1 교체',
  switch2: '동료 2 교체',
  switch3: '동료 3 교체',
  switch4: '동료 4 교체',
  interact: '상호작용',
  heal: '회복 아이템',
  lockOn: 'Lock-on',
  release: '등반·활강 이탈',
  map: '지도',
  inventory: '인벤토리/장비',
  quest: '퀘스트',
};

export const REMAP_TEXT = {
  prompt: '새 키를 누르세요',
  promptHint: 'Esc 또는 B: 취소',
  cancelled: '키 변경을 취소했습니다',
  unknown: '지원하지 않는 입력입니다. 다른 키를 눌러 주세요',
  gamepad: '게임패드 버튼은 고정 배치라 바꿀 수 없습니다',
  defaults: '모든 키를 기본값으로 되돌렸습니다',
} as const;

/** Inputs that cancel a waiting remap. */
export const REMAP_CANCEL_CODES: ReadonlySet<InputCode> = new Set(['Escape', 'PadB']);

export function reservedMessage(code: InputCode): string {
  return `${keyLabel(code)} 키는 예약된 키라 지정할 수 없습니다`;
}

/** "점프 ↔ 상호작용: 키를 서로 바꿨습니다". */
export function swapMessage(action: RemappableAction, other: RemappableAction): string {
  return `${ACTION_LABELS[action]} ↔ ${ACTION_LABELS[other]}: 키를 서로 바꿨습니다`;
}

/** "점프: G 키로 지정했습니다". */
export function assignedMessage(action: RemappableAction, code: InputCode): string {
  return `${ACTION_LABELS[action]}: ${keyLabel(code)} 키로 지정했습니다`;
}

export type RemapPhase = 'idle' | 'armed' | 'listening';

export type RemapOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'cancelled'; readonly action: RemappableAction; readonly message: string }
  | {
      readonly kind: 'refused';
      readonly action: RemappableAction;
      readonly code: InputCode;
      readonly reason: 'reserved' | 'unknown';
      readonly message: string;
    }
  | {
      readonly kind: 'applied';
      readonly action: RemappableAction;
      readonly code: InputCode;
      readonly bindings: Bindings;
      readonly swappedWith: RemappableAction | null;
      readonly message: string;
    };

const IGNORED: RemapOutcome = { kind: 'ignored' };

export class RemapFlow {
  private currentPhase: RemapPhase = 'idle';
  private currentAction: RemappableAction | null = null;
  private trigger: InputCode | null = null;

  get phase(): RemapPhase {
    return this.currentPhase;
  }

  /** The action waiting for a new key, or null. */
  get action(): RemappableAction | null {
    return this.currentAction;
  }

  get active(): boolean {
    return this.currentPhase !== 'idle';
  }

  /** Starts waiting for `action`'s new key; `trigger` is the still-held input that chose it (null: none held). */
  begin(action: RemappableAction, trigger: InputCode | null): void {
    this.currentAction = action;
    this.trigger = trigger;
    this.currentPhase = trigger === null ? 'listening' : 'armed';
  }

  /** Stops waiting (Esc, B, closing the screen or switching tabs). */
  cancel(): RemapOutcome {
    const action = this.currentAction;
    this.reset();
    return action === null ? IGNORED : { kind: 'cancelled', action, message: REMAP_TEXT.cancelled };
  }

  /** One raw input while the screen is on top; `bindings` are the current ones (never modified). */
  input(code: InputCode, phase: 'down' | 'up', bindings: Readonly<Bindings>): RemapOutcome {
    const action = this.currentAction;
    if (this.currentPhase === 'idle' || action === null) return IGNORED;
    if (phase === 'up') {
      if (this.currentPhase === 'armed' && code === this.trigger) this.currentPhase = 'listening';
      return IGNORED;
    }
    if (REMAP_CANCEL_CODES.has(code)) return this.cancel();
    if (this.currentPhase === 'armed') {
      // A new press of the trigger means its release went unseen (e.g. focus loss): it counts as the first input.
      if (code !== this.trigger) return IGNORED;
      this.currentPhase = 'listening';
    }
    if (code.startsWith('Pad')) return { kind: 'refused', action, code, reason: 'unknown', message: REMAP_TEXT.gamepad };
    const result = remapBinding(bindings, action, code);
    if (!result.ok) {
      const message = result.reason === 'reserved' ? reservedMessage(code) : REMAP_TEXT.unknown;
      return { kind: 'refused', action, code, reason: result.reason, message };
    }
    this.reset();
    const message = result.swappedWith === null ? assignedMessage(action, code) : swapMessage(action, result.swappedWith);
    return { kind: 'applied', action, code, bindings: result.bindings, swappedWith: result.swappedWith, message };
  }

  private reset(): void {
    this.currentPhase = 'idle';
    this.currentAction = null;
    this.trigger = null;
  }
}
