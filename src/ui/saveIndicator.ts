import './saveIndicator.css';

/*
 * Save indicator (design "저장 스케줄러" 쓰기와 결과, Req 36.6, 36.13): after 'save:done' the HUD shows "저장 중…" for
 * 0.5 s then "저장됨" for 1.0 s; after 'save:failed' "저장 실패" for 3 s. `notice(text)` shows any one-line status the
 * same way (e.g. "백업에서 복구했습니다" after a Continue from the backup). Real time; announced politely.
 */

type Step = { readonly text: string; readonly seconds: number; readonly tone: 'info' | 'ok' | 'error' };

export const SAVE_INDICATOR_TEXT = { saving: '저장 중…', saved: '저장됨', failed: '저장 실패' } as const;

export class SaveIndicator {
  private readonly root: HTMLDivElement;
  private queue: Step[] = [];
  private left = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'save-indicator';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    parent.append(this.root);
  }

  saved(): void {
    this.play([
      { text: SAVE_INDICATOR_TEXT.saving, seconds: 0.5, tone: 'info' },
      { text: SAVE_INDICATOR_TEXT.saved, seconds: 1.0, tone: 'ok' },
    ]);
  }

  failed(): void {
    this.play([{ text: SAVE_INDICATOR_TEXT.failed, seconds: 3, tone: 'error' }]);
  }

  notice(text: string, seconds = 3): void {
    this.play([{ text, seconds, tone: 'info' }]);
  }

  update(realDt: number): void {
    if (this.queue.length === 0) return;
    this.left -= Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    if (this.left > 0) return;
    this.queue.shift();
    this.show();
  }

  private play(steps: Step[]): void {
    this.queue = steps;
    this.show();
  }

  private show(): void {
    const step = this.queue[0];
    if (step === undefined) {
      this.root.hidden = true;
      return;
    }
    this.left = step.seconds;
    this.root.textContent = step.text;
    this.root.dataset.tone = step.tone;
    this.root.hidden = false;
  }
}
