/*
 * Map image coordinates (design "지도 (Map_System)"): the 1024 × 1024 map covers the world square [−560, 560]²,
 * north (−z) up and east (+x) right: `px = (x + 560) / 1120 × 1024`, `py = (z + 560) / 1120 × 1024`
 * (1 px ≈ 1.09 m). Pure: no DOM.
 */

/** Map image side (px). */
export const MAP_SIZE = 1024;
/** Half the side of the world square the map covers (m). */
export const MAP_WORLD_HALF = 560;
/** World metres per map pixel (1120 / 1024 ≈ 1.094). */
export const METERS_PER_PX = (2 * MAP_WORLD_HALF) / MAP_SIZE;

export interface MapPoint {
  readonly px: number;
  readonly py: number;
}

/** World (x, z) → map pixel (px, py); not clamped. */
export function worldToMap(x: number, z: number): MapPoint {
  return { px: ((x + MAP_WORLD_HALF) / (2 * MAP_WORLD_HALF)) * MAP_SIZE, py: ((z + MAP_WORLD_HALF) / (2 * MAP_WORLD_HALF)) * MAP_SIZE };
}

/** Map pixel (px, py) → world (x, z); the inverse of worldToMap. */
export function mapToWorld(px: number, py: number): { x: number; z: number } {
  return { x: (px / MAP_SIZE) * 2 * MAP_WORLD_HALF - MAP_WORLD_HALF, z: (py / MAP_SIZE) * 2 * MAP_WORLD_HALF - MAP_WORLD_HALF };
}

/** A world distance (m) in map pixels. */
export function metersToPx(m: number): number {
  return m / METERS_PER_PX;
}

/**
 * Compass heading (degrees, north 0°, east 90°, clockwise, in [0, 360)) of a core yaw (src/core/math: yaw 0 faces +z,
 * the south, and `dirFromYaw(yaw) = (sin yaw, cos yaw)`). The map's player arrow is drawn rotated by this.
 */
export function headingFromYaw(yaw: number): number {
  const deg = 180 - (yaw * 180) / Math.PI;
  const h = deg % 360;
  return h < 0 ? h + 360 : h;
}

// ── Pan and zoom ────────────────────────────────────────────────────────────

/** Map zoom range (Req 33.1 design: wheel 1×–4×). */
export const MAP_ZOOM_MIN = 1;
export const MAP_ZOOM_MAX = 4;

/**
 * The map's view inside a viewport: the image is drawn at `scale = fit × zoom` screen px per map px with its origin at
 * (`offsetX`, `offsetY`) in viewport px. `fit` makes the whole image fit the viewport at zoom 1.
 */
export interface MapView {
  readonly fit: number;
  readonly zoom: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Whole map centred in a `width` × `height` viewport at zoom 1. */
export function initialView(width: number, height: number): MapView {
  const fit = Math.max(1e-6, Math.min(width, height) / MAP_SIZE);
  return clampView({ fit, zoom: 1, offsetX: (width - MAP_SIZE * fit) / 2, offsetY: (height - MAP_SIZE * fit) / 2 }, width, height);
}

/** Viewport px of map pixel (px, py). */
export function viewToScreen(view: MapView, px: number, py: number): { x: number; y: number } {
  const s = view.fit * view.zoom;
  return { x: view.offsetX + px * s, y: view.offsetY + py * s };
}

/** Map pixel under viewport px (sx, sy). */
export function screenToView(view: MapView, sx: number, sy: number): MapPoint {
  const s = view.fit * view.zoom;
  return { px: (sx - view.offsetX) / s, py: (sy - view.offsetY) / s };
}

/**
 * Keeps the image covering the viewport where it can: an axis smaller than the viewport stays centred, a larger one
 * cannot be dragged past its edges.
 */
export function clampView(view: MapView, width: number, height: number): MapView {
  const size = MAP_SIZE * view.fit * view.zoom;
  const axis = (offset: number, span: number): number =>
    size <= span ? (span - size) / 2 : Math.min(0, Math.max(span - size, offset));
  return { ...view, offsetX: axis(view.offsetX, width), offsetY: axis(view.offsetY, height) };
}

/** Moves the view by (dx, dy) viewport px (mouse drag). */
export function panView(view: MapView, dx: number, dy: number, width: number, height: number): MapView {
  return clampView({ ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy }, width, height);
}

/**
 * Zooms to `zoom` (clamped to 1×–4×) keeping the map pixel under the cursor (sx, sy) where it is (wheel around the
 * cursor), then clamps the pan.
 */
export function zoomViewAt(view: MapView, zoom: number, sx: number, sy: number, width: number, height: number): MapView {
  const next = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, Number.isFinite(zoom) ? zoom : view.zoom));
  const anchor = screenToView(view, sx, sy);
  const s = view.fit * next;
  return clampView({ ...view, zoom: next, offsetX: sx - anchor.px * s, offsetY: sy - anchor.py * s }, width, height);
}

/** Centres map pixel (px, py) in the viewport at the view's zoom (the player on opening). */
export function centerViewOn(view: MapView, px: number, py: number, width: number, height: number): MapView {
  const s = view.fit * view.zoom;
  return clampView({ ...view, offsetX: width / 2 - px * s, offsetY: height / 2 - py * s }, width, height);
}
