import './discoveryNotice.css';
import { LANDMARK_NAMES, REGION_NAMES, type LandmarkId } from '../data/ids';
import type { PoiNotice, TrialRun } from '../world/poiSystem';

/*
 * Discovery card in the lower middle of the screen (tasks 12.7, 20.1, 20.3; Req 9.4, 9.6, 10.8–10.10): one card at a
 * time in arrival order, fading in and out.
 * - Landmark: its name with the framing shot (≤ 3 s).
 * - Hidden place: "숨겨진 장소 발견" and the place (gold edge).
 * - Echo_Tablet: the 1–2 sentence record with the Region's n/3, and "최대 Stamina +15" when the set completes.
 * - Lore stone: its sentences.
 * - Sky Ring Trial: start, completion (with the time and the glowing Chest) and failure; while a run is going a small
 *   line shows the rings passed and the seconds left.
 * Real time from the render loop; no input (role status, aria-live polite).
 */

const FADE = 0.3;

type Tone = 'gold' | 'plain' | 'danger';

interface Card {
  readonly title: string;
  readonly text: string;
  readonly sub: string;
  readonly tone: Tone;
  readonly seconds: number;
}

export class DiscoveryNotice {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly queue: Card[] = [];
  private current: Card | null = null;
  private elapsed = 0;
  private opacity = -1;
  private timerText = '';

  constructor(parent: HTMLElement) {
    const div = (className: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.className = className;
      return el;
    };
    this.root = div('discovery-notice');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.title = div('discovery-notice__title');
    this.text = div('discovery-notice__text');
    this.sub = div('discovery-notice__sub');
    this.root.append(this.title, this.text, this.sub);
    this.timer = div('discovery-notice__timer');
    this.timer.hidden = true;
    parent.append(this.root, this.timer);
  }

  /** A Landmark's first discovery (Req 9.4). */
  landmark(id: LandmarkId, seconds: number): void {
    this.push({ title: 'LANDMARK', text: LANDMARK_NAMES[id], sub: '지도에 기록되었습니다', tone: 'gold', seconds });
  }

  /** A POI notice of the World (tablets, lore, hidden places, the Sky Ring Trial). */
  poi(n: PoiNotice): void {
    switch (n.kind) {
      case 'tablet': {
        const sub = n.staminaMax !== null
          ? `${REGION_NAMES[n.region]} 석판 ${n.found}/${n.total} 완성 · 최대 Stamina +15`
          : `${REGION_NAMES[n.region]} 석판 ${n.found}/${n.total}`;
        this.push({ title: `Echo_Tablet · ${n.name}`, text: n.text, sub, tone: n.staminaMax !== null ? 'gold' : 'plain', seconds: 6 });
        return;
      }
      case 'lore':
        this.push({ title: n.name, text: n.text, sub: n.first ? '경험치 +5' : '', tone: 'plain', seconds: 5 });
        return;
      case 'hidden':
        this.push({ title: '숨겨진 장소 발견', text: n.name, sub: '지도에 기록되었습니다', tone: 'gold', seconds: 3 });
        return;
      case 'trialStarted':
        this.push({ title: 'Sky Ring Trial', text: `링 ${n.rings}개를 차례로 통과하세요`, sub: `제한 ${n.seconds}초 · 착지하면 실패`, tone: 'plain', seconds: 2.5 });
        return;
      case 'trialCompleted':
        this.push({
          title: 'Sky Ring Trial 완료', text: `기록 ${n.seconds.toFixed(1)}초`, sub: n.first ? '호수 동쪽 물가에 빛나는 상자가 나타났습니다' : '',
          tone: 'gold', seconds: 4,
        });
        return;
      case 'trialFailed':
        this.push({ title: 'Sky Ring Trial 실패', text: n.reason === 'timeout' ? '시간이 다 되었습니다' : '착지했습니다', sub: '시작 석판에서 다시 도전할 수 있습니다', tone: 'danger', seconds: 3 });
        return;
      default:
        // Rings passed show on the timer line; caches and herbs go to the pickup feed.
        return;
    }
  }

  /** The trial run in progress (rings passed, seconds left), or null. */
  trial(run: TrialRun | null, rings: number, limit: number): void {
    const text = run === null ? '' : `링 ${run.next}/${rings} · ${Math.max(0, Math.ceil(limit - run.elapsed))}초`;
    if (text === this.timerText) return;
    this.timerText = text;
    this.timer.hidden = text === '';
    this.timer.textContent = text;
  }

  update(realDt: number): void {
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    if (this.current !== null) {
      this.elapsed += dt;
      if (this.elapsed >= this.current.seconds) this.current = null;
    }
    if (this.current === null) {
      const next = this.queue.shift();
      if (next === undefined) {
        this.setOpacity(0);
        return;
      }
      this.current = next;
      this.elapsed = 0;
      this.title.textContent = next.title;
      this.text.textContent = next.text;
      this.sub.textContent = next.sub;
      this.sub.hidden = next.sub === '';
      this.root.dataset.tone = next.tone;
    }
    const t = this.elapsed;
    this.setOpacity(Math.max(0, Math.min(1, t / FADE, (this.current.seconds - t) / FADE)));
  }

  private push(card: Card): void {
    this.queue.push(card);
  }

  private setOpacity(opacity: number): void {
    const hidden = this.current === null;
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
    const rounded = Math.round(opacity * 100) / 100;
    if (rounded === this.opacity) return;
    this.opacity = rounded;
    this.root.style.opacity = String(rounded);
  }
}
