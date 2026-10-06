import './mapScreen.css';
import type { WaystoneId } from '../data/ids';
import { FogOfWar } from '../logic/fogOfWar';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { FogCanvas } from '../map/mapCanvas';
import type { MapContent } from '../map/mapContent';
import {
  centerViewOn, headingFromYaw, initialView, MAP_SIZE, panView, worldToMap, zoomViewAt, type MapView,
} from '../map/mapCoords';
import { mapModel, type MapModel, type MapObjectives } from '../map/mapModel';
import { FAST_TRAVEL_REFUSED_TEXT } from '../world/waystoneSystem';
import { h, menuButton } from './dom';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';

/*
 * Map screen (design "지도 (Map_System)" 지도 화면, "화면 목록" Map; Req 33.1, 33.2, 33.5, 3.6, 11.2, 11.4, 11.5, 15.4;
 * task 13.5): a full-screen `map` context screen, so game time stops while it is open (design "UI 구조").
 * - The base map image (built once per page, src/map/mapCanvas.ts) under the fog overlay: parchment over the
 *   unrevealed cells through the linearly blended 140 × 140 mask, redrawn from GameState's fog when it changed.
 * - Pins (src/map/mapModel.ts): the player's position and facing, discovered Region names, Thistlewick, discovered
 *   Landmark labels, Waystones (active ones are fast-travel buttons, Vista-marked inactive ones are not), discovered
 *   POIs only, the Main_Quest Objective (exact pin or ≥ 60 m search circle) and the tracked Side_Quest's; the side
 *   panel lists each discovered Region's Chest and Echo_Tablet counts found / total and a legend.
 * - Mouse drag pans, the wheel zooms 1×–4× around the cursor; M or Esc closes (M through the page's `map` action,
 *   Esc as the default `cancel`). Arrow keys / D-pad move the focus between the close button and the active
 *   Waystones, Enter / A chooses.
 * - Choosing an active Waystone: In_Combat it stays open and shows "전투 중에는 이동할 수 없습니다" (Req 11.5);
 *   otherwise `onFastTravel` queues the `fastTravel` UiCommand and closes the map, and the World checks again on the
 *   next tick before the fade (Req 11.4).
 * Reads only DeepReadonly<GameState> and the session's read-outs; never changes game state itself.
 */

export interface MapScreenOptions {
  /** The page's base map image (built on first use, then cached). */
  image: () => HTMLCanvasElement;
  state: DeepReadonly<GameState>;
  /** Active_Character feet and facing (core yaw). */
  player: () => { readonly x: number; readonly z: number; readonly yaw: number };
  /** Current Main_Quest Objective and the tracked Side_Quest's (text and marker). */
  objectives: () => MapObjectives;
  /** RuntimeState.inCombat (read-only). */
  inCombat: () => boolean;
  /** Queue `fastTravel` for the Waystone and close the map (the owner does both). */
  onFastTravel: (id: WaystoneId) => void;
  /** Close the map (pop it). */
  onClose: () => void;
  /** POI and collectible tables (default: src/map/mapContent.ts). */
  content?: MapContent;
}

const NOTICE_SECONDS = 2.5;

export class MapScreen implements Screen {
  readonly id = 'map';
  readonly context = 'map';
  private readonly o: MapScreenOptions;
  private readonly root: HTMLElement;
  private readonly viewport: HTMLDivElement;
  private readonly plane: HTMLDivElement;
  private readonly pins: HTMLDivElement;
  private readonly side: HTMLElement;
  private readonly notice: HTMLParagraphElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly fog = new FogCanvas();
  private waystoneButtons: HTMLButtonElement[] = [];
  private view: MapView = { fit: 1, zoom: 1, offsetX: 0, offsetY: 0 };
  private size = { width: 1, height: 1 };
  private drag: { id: number; x: number; y: number } | null = null;
  private fogShown: string | null = null;
  private noticeLeft = 0;
  private readonly onResize = (): void => this.measure(true);

  constructor(options: MapScreenOptions) {
    this.o = options;
    this.closeButton = menuButton('닫기', () => options.onClose(), { className: 'map-screen__close' });
    this.pins = h('div', { class: 'map-pins' });
    this.plane = h('div', { class: 'map-plane' }, [this.fog.element, this.pins]);
    this.fog.element.classList.add('map-plane__fog');
    this.viewport = h('div', { class: 'map-view', role: 'application', 'aria-label': '지도 영역: 드래그로 이동, 휠로 확대' }, [this.plane]);
    this.notice = h('p', { class: 'map-side__notice', role: 'status', 'aria-live': 'assertive', hidden: true });
    this.side = h('aside', { class: 'map-side', 'aria-label': '지역별 발견 현황' });
    this.root = h('section', { class: 'ui-screen map-screen', role: 'dialog', 'aria-label': '지도' }, [
      h('header', { class: 'map-screen__header' }, [
        h('div', { class: 'map-screen__titles' }, [
          h('h1', { class: 'map-screen__title' }, ['지도']),
          h('p', { class: 'map-screen__hint' }, ['드래그: 이동 · 휠: 확대 · 활성 Waystone 선택: 빠른 이동 · M/Esc: 닫기']),
        ]),
        this.closeButton,
      ]),
      h('div', { class: 'map-screen__body' }, [this.viewport, this.side]),
    ]);
    this.viewport.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.viewport.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.viewport.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.viewport.addEventListener('pointercancel', (e) => this.pointerUp(e));
    this.viewport.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
  }

  mount(root: HTMLElement): void {
    const image = this.o.image();
    image.classList.add('map-plane__image');
    this.plane.prepend(image);
    root.append(this.root);
    this.redrawFog();
    this.build(mapModel(this.o.state, this.o.objectives(), this.o.content));
    window.addEventListener('resize', this.onResize);
    this.measure(false);
  }

  unmount(): void {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  onInput(nav: NavInput): boolean {
    void nav;
    return false; // arrows move the focus, confirm clicks it, cancel closes (ScreenManager defaults)
  }

  focusables(): readonly HTMLElement[] {
    return [this.closeButton, ...this.waystoneButtons];
  }

  update(realDt: number): void {
    if (this.o.state.discovery.fog !== this.fogShown) this.redrawFog();
    if (this.noticeLeft > 0) {
      this.noticeLeft -= Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
      if (this.noticeLeft <= 0) this.notice.hidden = true;
    }
  }

  /** The message line in the side panel (the In_Combat refusal). */
  showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = false;
    this.noticeLeft = NOTICE_SECONDS;
  }

  // ── Building ──────────────────────────────────────────────────────────────

  private redrawFog(): void {
    const text = this.o.state.discovery.fog;
    this.fogShown = text;
    this.fog.draw(FogOfWar.decode(text));
  }

  private build(model: MapModel): void {
    const pin = (className: string, px: number, py: number, children: (Node | string)[] = []): HTMLElement =>
      h('div', { class: `map-pin ${className}`, style: { left: `${px}px`, top: `${py}px` } }, children);
    const nodes: HTMLElement[] = [];
    for (const r of model.regions) nodes.push(pin('map-pin--region', r.px, r.py, [h('span', { class: 'map-label map-label--region' }, [r.name])]));
    nodes.push(pin('map-pin--village', model.village.px, model.village.py, [h('span', { class: 'map-label map-label--village' }, [model.village.name])]));
    for (const l of model.landmarks) {
      nodes.push(pin(`map-pin--landmark${l.discovered ? '' : ' is-marked'}`, l.px, l.py, [
        h('span', { class: 'map-icon map-icon--landmark', title: l.discovered ? l.name : '표시된 장소' }),
        ...(l.discovered ? [h('span', { class: 'map-label' }, [l.name])] : []),
      ]));
    }
    for (const p of model.pois) {
      nodes.push(pin(`map-pin--poi map-pin--poi-${p.kind}`, p.px, p.py, [
        h('span', { class: 'map-icon map-icon--poi', title: p.name }),
        ...(p.name !== '' ? [h('span', { class: 'map-label map-label--small' }, [p.name])] : []),
      ]));
    }
    for (const o of model.objectives) {
      const cls = `map-pin--objective map-pin--${o.quest}`;
      if (o.kind === 'zone') {
        const d = 2 * o.radiusPx;
        nodes.push(h('div', {
          class: `map-zone map-zone--${o.quest}`,
          style: { left: `${o.px - o.radiusPx}px`, top: `${o.py - o.radiusPx}px`, width: `${d}px`, height: `${d}px` },
          title: o.text,
        }));
        nodes.push(pin(cls, o.px, o.py, [h('span', { class: 'map-label map-label--small' }, [o.quest === 'main' ? '탐색 구역' : '추적 의뢰 구역'])]));
      } else {
        nodes.push(pin(cls, o.px, o.py, [h('span', { class: `map-icon map-icon--${o.quest}`, title: o.text })]));
      }
    }
    this.waystoneButtons = [];
    for (const w of model.waystones) {
      if (w.active) {
        const button = h('button', {
          type: 'button', class: 'map-pin map-pin--waystone is-active', style: { left: `${w.px}px`, top: `${w.py}px` },
          'aria-label': `${w.name} Waystone으로 빠른 이동`,
        }, [h('span', { class: 'map-icon map-icon--waystone' }), h('span', { class: 'map-label map-label--small' }, [w.name])]);
        button.addEventListener('click', () => this.chooseWaystone(w.id));
        button.addEventListener('pointerenter', () => button.focus({ preventScroll: true }));
        this.waystoneButtons.push(button);
        nodes.push(button);
      } else {
        nodes.push(pin('map-pin--waystone', w.px, w.py, [h('span', { class: 'map-icon map-icon--waystone', title: `${w.name} Waystone (미활성)` })]));
      }
    }
    const player = this.o.player();
    const at = worldToMap(player.x, player.z);
    nodes.push(pin('map-pin--player', at.px, at.py, [
      h('span', { class: 'map-icon map-icon--player', style: { transform: `rotate(${headingFromYaw(player.yaw)}deg)` }, title: '현재 위치' }),
    ]));
    this.pins.replaceChildren(...nodes);
    this.buildSide(model);
  }

  private buildSide(model: MapModel): void {
    const rows = model.counts.filter((c) => c.discovered).map((c) =>
      h('li', { class: 'map-side__region' }, [
        h('span', { class: 'map-side__region-name' }, [c.name]),
        h('span', { class: 'map-side__count' }, [`Chest ${c.chests.found}/${c.chests.total}`]),
        h('span', { class: 'map-side__count' }, [`Echo_Tablet ${c.tablets.found}/${c.tablets.total}`]),
      ]),
    );
    const legend = (icon: string, text: string): HTMLElement =>
      h('li', { class: 'map-legend__item' }, [h('span', { class: `map-icon ${icon}` }), h('span', {}, [text])]);
    this.side.replaceChildren(
      h('h2', { class: 'map-side__title' }, ['지역별 발견']),
      rows.length > 0 ? h('ul', { class: 'map-side__regions' }, rows) : h('p', { class: 'map-side__empty' }, ['아직 발견한 지역이 없습니다']),
      h('h2', { class: 'map-side__title' }, ['범례']),
      h('ul', { class: 'map-legend' }, [
        legend('map-icon--player', '현재 위치와 방향'),
        legend('map-icon--main', '목표'),
        legend('map-icon--side', '추적 중인 의뢰'),
        legend('map-icon--waystone map-icon--legend-active', '활성 Waystone (선택하면 빠른 이동)'),
        legend('map-icon--waystone', '미활성 Waystone'),
        legend('map-icon--landmark', 'Landmark'),
      ]),
      this.notice,
    );
  }

  // ── Fast travel ───────────────────────────────────────────────────────────

  private chooseWaystone(id: WaystoneId): void {
    if (!this.o.state.world.waystones.includes(id)) return;
    if (this.o.inCombat()) {
      this.showNotice(FAST_TRAVEL_REFUSED_TEXT);
      return;
    }
    this.o.onFastTravel(id);
  }

  // ── Pan and zoom ──────────────────────────────────────────────────────────

  /** Reads the viewport size (mount and resize only); `keep` keeps the zoom and the centre. */
  private measure(keep: boolean): void {
    const rect = this.viewport.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const before = this.view;
    const prev = this.size;
    this.size = { width, height };
    const fresh = initialView(width, height);
    if (!keep) {
      const player = this.o.player();
      const p = worldToMap(player.x, player.z);
      this.view = centerViewOn(fresh, p.px, p.py, width, height);
    } else {
      const s = before.fit * before.zoom;
      const cx = (prev.width / 2 - before.offsetX) / s;
      const cy = (prev.height / 2 - before.offsetY) / s;
      this.view = centerViewOn({ ...fresh, zoom: before.zoom }, cx, cy, width, height);
    }
    this.apply();
  }

  private apply(): void {
    const v = this.view;
    const s = v.fit * v.zoom;
    this.plane.style.transform = `translate(${v.offsetX}px, ${v.offsetY}px) scale(${s})`;
    this.plane.style.setProperty('--pin-scale', String(1 / s));
    this.plane.style.width = `${MAP_SIZE}px`;
    this.plane.style.height = `${MAP_SIZE}px`;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button') !== null)) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.viewport.setPointerCapture(e.pointerId);
    this.viewport.classList.add('is-dragging');
  }

  private pointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (d === null || d.id !== e.pointerId) return;
    this.view = panView(this.view, e.clientX - d.x, e.clientY - d.y, this.size.width, this.size.height);
    this.drag = { id: d.id, x: e.clientX, y: e.clientY };
    this.apply();
  }

  private pointerUp(e: PointerEvent): void {
    if (this.drag?.id !== e.pointerId) return;
    this.drag = null;
    this.viewport.classList.remove('is-dragging');
    if (this.viewport.hasPointerCapture(e.pointerId)) this.viewport.releasePointerCapture(e.pointerId);
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size.height : 1;
    const zoom = this.view.zoom * Math.exp(-e.deltaY * lines * 0.0015);
    const rect = this.viewport.getBoundingClientRect(); // an input event, not the frame loop
    this.view = zoomViewAt(this.view, zoom, e.clientX - rect.left, e.clientY - rect.top, this.size.width, this.size.height);
    this.apply();
  }
}

/** Factory for the Map screen: the page opens it with the M key, the Pause screen's "지도" button with the same call. */
export function createMapScreen(options: MapScreenOptions): MapScreen {
  return new MapScreen(options);
}
