import './menuScreens.css';
import { h, menuButton } from './dom';

/*
 * Fatal error overlay (design "화면 목록" 오류 화면, task 14.2): an error the game cannot continue from (a failure while
 * the world is built, an uncaught exception in the frame loop) covers the page with a Korean explanation, the error
 * message and "다시 불러오기" (reload; the last save is kept, so Continue restores it). WebGL2 missing and a lost context
 * have their own screens (src/render/unsupportedScreen, contextLossOverlay). Shown once; later errors only log.
 */
export interface FatalErrorOptions {
  /** Default: location.reload(). */
  reload?(): void;
}

let shown: HTMLElement | null = null;

/** Shows the overlay in `root` (once per page) and logs `error`. */
export function showFatalError(root: HTMLElement, error: unknown, options: FatalErrorOptions = {}): HTMLElement {
  console.error('Fatal error', error);
  if (shown !== null && shown.isConnected) return shown;
  const message = error instanceof Error ? error.message : String(error);
  const reload = options.reload ?? (() => location.reload());
  const button = menuButton('다시 불러오기', () => reload(), { className: 'fatal-error__reload' });
  const overlay = h('div', { class: 'fatal-error', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'fatal-error-title', 'aria-describedby': 'fatal-error-text' }, [
    h('section', { class: 'ui-panel fatal-error__panel' }, [
      h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
      h('h2', { class: 'ui-panel__title', id: 'fatal-error-title' }, ['문제가 발생했습니다']),
      h('p', { class: 'ui-panel__text', id: 'fatal-error-text' }, ['게임을 계속할 수 없는 오류가 생겼습니다. 다시 불러오면 마지막 저장에서 이어할 수 있습니다.']),
      h('p', { class: 'fatal-error__detail' }, [message]),
      h('div', { class: 'ui-actions' }, [button]),
    ]),
  ]);
  root.append(overlay);
  shown = overlay;
  button.focus({ preventScroll: true });
  return overlay;
}
