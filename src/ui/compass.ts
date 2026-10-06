import './compass.css';
import type { CompassMarker, CompassMarkerKind, CompassModel } from '../map/compassModel';
import { COMPASS_ZONE_LABEL } from '../map/compassModel';

/*
 * HUD Compass (design "Compass", Req 33.4, 3.6, 15.4; task 13.7): a strip at the top centre, min(38 % of the screen,
 * 28 rem = 560 px at UI scale 1) wide, showing 180° around the camera heading. It draws a CompassModel
 * (src/map/compassModel.ts): the 15° ticks with N / E / S / W, the Main_Quest Objective (gold four-point star with its
 * distance), the tracked Side_Quest Objective (teal diamond), active Waystones within 150 m (pale obelisks) and the
 * discovered Landmarks (small triangles), each by shape as well as colour (Req 35.7). Inside the Main_Quest search
 * zone the strip centre reads "탐색 구역" instead of an Objective arrow.
 * Elements are pooled by id and written only when their rounded position, opacity or text changes; no layout reads.
 */

interface Slot {
  readonly el: HTMLElement;
  readonly label: HTMLElement | null;
  left: string;
  opacity: string;
  text: string;
  shown: boolean;
}

const KIND_NAMES: Readonly<Record<CompassMarkerKind, string>> = {
  main: '목표',
  side: '추적 의뢰',
  waystone: 'Waystone',
  landmark: 'Landmark',
};

const percent = (u: number): string => `${(Math.round(u * 1000) / 10).toFixed(1)}%`;
const alpha = (o: number): string => String(Math.round(o * 100) / 100);

export class Compass {
  readonly root: HTMLDivElement;
  private readonly strip: HTMLDivElement;
  private readonly zone: HTMLDivElement;
  private readonly ticks = new Map<number, Slot>();
  private readonly markers = new Map<string, Slot>();
  private zoneShown = false;
  private visible = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud-compass';
    this.root.setAttribute('aria-hidden', 'true'); // the Objective panel carries the same guidance as text
    this.strip = document.createElement('div');
    this.strip.className = 'hud-compass__strip';
    const caret = document.createElement('div');
    caret.className = 'hud-compass__caret';
    this.zone = document.createElement('div');
    this.zone.className = 'hud-compass__zone';
    this.zone.textContent = COMPASS_ZONE_LABEL;
    this.zone.hidden = true;
    this.strip.append(caret, this.zone);
    this.root.append(this.strip);
    parent.append(this.root);
  }

  /** Hides the whole strip (cinematics) or shows it again. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.hidden = !visible;
  }

  update(model: CompassModel): void {
    const seenTicks = new Set<number>();
    for (const t of model.ticks) {
      seenTicks.add(t.bearing);
      const slot = this.tickSlot(t.bearing, t.label);
      this.place(slot, t.u, t.opacity, t.label ?? '');
    }
    for (const [bearing, slot] of this.ticks) if (!seenTicks.has(bearing)) this.hide(slot);

    const seen = new Set<string>();
    for (const m of model.markers) {
      const key = `${m.kind}:${m.id}`;
      seen.add(key);
      this.place(this.markerSlot(key, m), m.u, m.opacity, m.kind === 'main' ? `${Math.round(m.distance)} m` : '');
    }
    for (const [key, slot] of this.markers) if (!seen.has(key)) this.hide(slot);

    if (model.inMainZone !== this.zoneShown) {
      this.zoneShown = model.inMainZone;
      this.zone.hidden = !model.inMainZone;
    }
  }

  private tickSlot(bearing: number, label: string | null): Slot {
    let slot = this.ticks.get(bearing);
    if (slot === undefined) {
      const el = document.createElement('div');
      el.className = label === null ? 'hud-compass__tick' : 'hud-compass__tick hud-compass__tick--cardinal';
      el.dataset.bearing = String(bearing);
      const text = label === null ? null : document.createElement('span');
      if (text !== null) {
        text.className = 'hud-compass__cardinal';
        text.textContent = label;
        el.append(text);
      }
      this.strip.prepend(el);
      slot = { el, label: null, left: '', opacity: '', text: label ?? '', shown: false };
      el.hidden = true;
      this.ticks.set(bearing, slot);
    }
    return slot;
  }

  private markerSlot(key: string, m: CompassMarker): Slot {
    let slot = this.markers.get(key);
    if (slot === undefined) {
      const el = document.createElement('div');
      el.className = `hud-compass__marker hud-compass__marker--${m.kind}`;
      el.dataset.id = m.id;
      el.title = KIND_NAMES[m.kind];
      const icon = document.createElement('span');
      icon.className = 'hud-compass__icon';
      el.append(icon);
      const label = m.kind === 'main' ? document.createElement('span') : null;
      if (label !== null) {
        label.className = 'hud-compass__distance';
        el.append(label);
      }
      el.hidden = true;
      this.strip.append(el);
      slot = { el, label, left: '', opacity: '', text: '', shown: false };
      this.markers.set(key, slot);
    }
    return slot;
  }

  private place(slot: Slot, u: number, opacity: number, text: string): void {
    const left = percent(u);
    const op = alpha(opacity);
    if (!slot.shown) {
      slot.shown = true;
      slot.el.hidden = false;
    }
    if (left !== slot.left) {
      slot.left = left;
      slot.el.style.left = left;
    }
    if (op !== slot.opacity) {
      slot.opacity = op;
      slot.el.style.opacity = op;
    }
    if (slot.label !== null && text !== slot.text) {
      slot.text = text;
      slot.label.textContent = text;
    }
  }

  private hide(slot: Slot): void {
    if (!slot.shown) return;
    slot.shown = false;
    slot.el.hidden = true;
  }
}
