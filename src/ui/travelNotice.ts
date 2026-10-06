import './travelNotice.css';
import { WAYSTONE_NAMES, type WaystoneId } from '../data/ids';
import { VISTAS, type VistaId } from '../data/vistas';

/*
 * Waystone and map notices under the Compass (tasks 13.5, 13.7; Req 11.1, 11.3, 11.5, 9.5): a short line that fades in
 * and out, one at a time in arrival order.
 * - Activation: "WAYSTONE" over "<name> 활성화" and what it opened (fast travel, respawn point), with a gold glow.
 * - Rest: the party was healed at an active Waystone.
 * - Fast travel refused In_Combat: "전투 중에는 이동할 수 없습니다" with the warning icon (Req 11.5).
 * - Vista: the surrounding land was drawn on the map.
 * Real time from the render loop; takes no input and is hidden from nothing (role status, aria-live polite).
 */

const FADE = 0.25;

type Tone = 'gold' | 'plain' | 'danger';

interface Entry {
  readonly title: string;
  readonly text: string;
  readonly tone: Tone;
  readonly seconds: number;
}

export class TravelNotice {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private readonly queue: Entry[] = [];
  private current: Entry | null = null;
  private elapsed = 0;
  private opacity = -1;

  constructor(parent: HTMLElement) {
    const div = (className: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.className = className;
      return el;
    };
    this.root = div('travel-notice');
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.title = div('travel-notice__title');
    this.text = div('travel-notice__text');
    this.root.append(this.title, this.text);
    parent.append(this.root);
  }

  /** A Waystone was activated (Req 11.1). */
  activated(id: WaystoneId): void {
    this.push({ title: 'WAYSTONE', text: `${WAYSTONE_NAMES[id]} 활성화 · 빠른 이동과 부활 지점이 열렸습니다`, tone: 'gold', seconds: 3 });
  }

  /** Rest at an active Waystone: HP restored, Downed cleared, respawn point set (Req 11.3). */
  rested(id: WaystoneId): void {
    this.push({ title: '', text: `${WAYSTONE_NAMES[id]} Waystone에서 휴식했습니다 · 파티 HP 회복`, tone: 'plain', seconds: 2 });
  }

  /** Task 13.2: rest at the Thistlewick Hearth: every Player_Character at full HP, Downed cleared (Req 14.10). */
  hearthRested(): void {
    this.push({ title: '', text: 'Hearth에서 쉬었습니다 · 파티 HP 회복', tone: 'plain', seconds: 2 });
  }

  /** Fast travel refused (Req 11.5). */
  refused(text: string): void {
    if (this.current?.text === text || this.queue.some((e) => e.text === text)) return;
    this.push({ title: '', text, tone: 'danger', seconds: 2.5 });
  }

  /** A Vista's first 200 m map reveal (Req 9.5). */
  vista(id: VistaId): void {
    this.push({ title: '', text: `${VISTAS[id].name} · 주변 지형이 지도에 기록되었습니다`, tone: 'plain', seconds: 3 });
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
      this.title.hidden = next.title === '';
      this.text.textContent = next.text;
      this.root.dataset.tone = next.tone;
    }
    const t = this.elapsed;
    this.setOpacity(Math.max(0, Math.min(1, t / FADE, (this.current.seconds - t) / FADE)));
  }

  private push(entry: Entry): void {
    this.queue.push(entry);
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
