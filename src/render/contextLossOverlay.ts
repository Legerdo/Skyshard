import { createButton, createSystemScreen, h } from './systemScreen';

/* Overlay shown while the WebGL context is lost; offers a restart after a timeout (Req 1.8). */

export interface ContextLossOverlayOptions {
  /** Called by the "마지막 저장에서 다시 시작" button. */
  onRestartFromSave: () => void;
  /** Delay before the restart button appears. Default 5000 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const WAITING_TEXT = '게임을 일시정지했습니다. 잠시만 기다려 주세요.';
const STALLED_TEXT = '복구가 늦어지고 있습니다. 마지막 저장 지점에서 게임을 다시 시작할 수 있습니다.';

export class ContextLossOverlay {
  private readonly root: HTMLElement;
  private readonly onRestartFromSave: () => void;
  private readonly timeoutMs: number;
  private readonly screen: HTMLDivElement;
  private readonly text: HTMLParagraphElement;
  private readonly actions: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private timer: number | null = null;
  private shown = false;
  private disposed = false;

  constructor(root: HTMLElement, opts: ContextLossOverlayOptions) {
    this.root = root;
    this.onRestartFromSave = opts.onRestartFromSave;
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutMs = Number.isFinite(timeout) ? Math.max(0, timeout) : DEFAULT_TIMEOUT_MS;

    const parts = createSystemScreen({
      id: 'context-loss',
      role: 'dialog',
      title: '그래픽 장치를 복구하는 중…',
      text: WAITING_TEXT,
    });
    this.screen = parts.screen;
    this.text = parts.text;
    this.text.setAttribute('aria-live', 'polite');

    const spinner = h('div', 'sys-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    parts.panel.prepend(spinner);

    this.button = createButton('마지막 저장에서 다시 시작', () => this.restart());
    this.actions = h('div', 'sys-actions');
    this.actions.append(this.button);
    parts.panel.append(this.actions);
  }

  show(): void {
    if (this.disposed || this.shown) return;
    this.shown = true;
    this.text.textContent = WAITING_TEXT;
    this.actions.hidden = true;
    this.button.disabled = false;
    this.root.append(this.screen);
    this.timer = window.setTimeout(() => this.revealRestart(), this.timeoutMs);
  }

  hide(): void {
    this.clearTimer();
    if (!this.shown) return;
    this.shown = false;
    this.screen.remove();
  }

  dispose(): void {
    this.hide();
    this.disposed = true;
  }

  private revealRestart(): void {
    this.timer = null;
    this.text.textContent = STALLED_TEXT;
    this.actions.hidden = false;
    // The button must be clickable even if the game held pointer lock.
    if (document.pointerLockElement) document.exitPointerLock();
    this.button.focus();
  }

  private restart(): void {
    if (this.button.disabled) return;
    this.button.disabled = true;
    this.onRestartFromSave();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }
}
