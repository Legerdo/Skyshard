import './hudBanner.css';
import type { RewardRef } from '../logic/quest/types';

/** How long a stage-complete banner stays up (s, Req 3.5), fades included. */
export const STAGE_BANNER_SECONDS = 3;
/** How long the "캠프 소탕" banner stays up (s, Req 10.7), fades included. */
export const CAMP_BANNER_SECONDS = 2;
/** How long a puzzle hint stays up (s, Req 13.7), fades included. */
export const HINT_BANNER_SECONDS = 5;
const FADE_SECONDS = 0.35;

interface BannerEntry {
  title: string;
  name: string;
  rewards: string;
  seconds: number;
}

/** "경험치 +40 · 120 Glim" for a stage's rewards; empty when there are none. */
export function rewardLine(rewards: readonly RewardRef[]): string {
  let xp = 0;
  let glim = 0;
  let items = 0;
  for (const r of rewards) {
    xp += r.xp ?? 0;
    glim += r.glim ?? 0;
    for (const item of r.items ?? []) items += item.count;
  }
  const parts: string[] = [];
  if (xp > 0) parts.push(`경험치 +${xp}`);
  if (glim > 0) parts.push(`${glim} Glim`);
  if (items > 0) parts.push(`아이템 ${items}개`);
  return parts.join(' · ');
}

/*
 * HUD notices (design "알림과 피드백"), a minimal version until task 14.3:
 * - Stage complete (`hud:stageComplete`, Req 3.5): "단계 완료", the stage name and its rewards for 3 s, upper
 *   centre; banners arriving while one shows wait in order.
 * - Camp cleared (Req 10.7): "캠프 소탕" for 2 s in the same place and queue, with the unlocked Chest line.
 * - Puzzle hint (Req 13.7): "힌트" and the puzzle's one line for 5 s from its 3rd failure, same place and queue.
 * - Cinematic caption: while a cinematic stand-in plays (task 4.9), its title and subtitle in the screen centre
 *   between letterbox bars. It takes no input; the cinematic owns the input context.
 * Driven by real time from the render loop; text is written only when it changes.
 */
export class HudBanner {
  private readonly stage: HTMLDivElement;
  private readonly stageTitle: HTMLDivElement;
  private readonly stageName: HTMLDivElement;
  private readonly stageRewards: HTMLDivElement;
  private readonly caption: HTMLDivElement;
  private readonly captionTitle: HTMLDivElement;
  private readonly captionSubtitle: HTMLDivElement;
  private readonly queue: BannerEntry[] = [];
  private seconds = STAGE_BANNER_SECONDS;
  private showing = false;
  private elapsed = 0;
  private opacity = -1;

  constructor(parent: HTMLElement) {
    const div = (className: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.className = className;
      return el;
    };
    this.stage = div('hud-stage-banner');
    this.stage.setAttribute('role', 'status');
    this.stage.setAttribute('aria-live', 'polite');
    this.stage.hidden = true;
    this.stageTitle = div('hud-stage-banner__title');
    this.stageName = div('hud-stage-banner__name');
    this.stageRewards = div('hud-stage-banner__rewards');
    this.stage.append(this.stageTitle, this.stageName, this.stageRewards);

    this.caption = div('hud-cinematic');
    this.caption.setAttribute('role', 'status');
    this.caption.setAttribute('aria-live', 'polite');
    this.caption.hidden = true;
    this.captionTitle = div('hud-cinematic__title');
    this.captionSubtitle = div('hud-cinematic__subtitle');
    this.caption.append(div('hud-cinematic__bar hud-cinematic__bar--top'), this.captionTitle, this.captionSubtitle, div('hud-cinematic__bar hud-cinematic__bar--bottom'));
    parent.append(this.caption, this.stage);
  }

  /** Queues a stage-complete banner. */
  stageComplete(stageName: string, rewards: readonly RewardRef[]): void {
    this.queue.push({ title: '단계 완료', name: stageName, rewards: rewardLine(rewards), seconds: STAGE_BANNER_SECONDS });
  }

  /** Queues the "캠프 소탕" banner; `chestUnlocked` adds the line about the camp's opened Chest. */
  campCleared(chestUnlocked: boolean): void {
    this.queue.push({ title: '캠프 소탕', name: chestUnlocked ? '잠긴 상자를 열 수 있습니다' : '', rewards: '', seconds: CAMP_BANNER_SECONDS });
  }

  /** Queues a puzzle's one-line hint (Req 13.7); a hint already waiting or showing is not queued again. */
  puzzleHint(text: string): void {
    const shown = this.showing && this.stageTitle.textContent === '힌트' && this.stageName.textContent === text;
    if (shown || this.queue.some((e) => e.title === '힌트' && e.name === text)) return;
    this.queue.push({ title: '힌트', name: text, rewards: '', seconds: HINT_BANNER_SECONDS });
  }

  /** Shows the cinematic caption, or hides it (null). */
  setCinematic(caption: { caption: string; subtitle: string } | null): void {
    this.caption.hidden = caption === null;
    if (caption === null) return;
    this.captionTitle.textContent = caption.caption;
    this.captionSubtitle.textContent = caption.subtitle;
  }

  /** Advances the stage banner by `dt` real seconds. */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.showing) {
      this.elapsed += step;
      if (this.elapsed >= this.seconds) this.showing = false;
    }
    if (!this.showing) {
      const next = this.queue.shift();
      if (next === undefined) {
        this.setOpacity(0);
        return;
      }
      this.showing = true;
      this.elapsed = 0;
      this.seconds = next.seconds;
      this.stageTitle.textContent = next.title;
      this.stageName.textContent = next.name;
      this.stageName.hidden = next.name === '';
      this.stageRewards.textContent = next.rewards;
      this.stageRewards.hidden = next.rewards === '';
    }
    const t = this.elapsed;
    this.setOpacity(Math.max(0, Math.min(1, t / FADE_SECONDS, (this.seconds - t) / FADE_SECONDS)));
  }

  private setOpacity(opacity: number): void {
    const hidden = !this.showing;
    if (this.stage.hidden !== hidden) this.stage.hidden = hidden;
    const rounded = Math.round(opacity * 100) / 100;
    if (rounded === this.opacity) return;
    this.opacity = rounded;
    this.stage.style.opacity = String(rounded);
  }
}
