/*
 * Compass projection and contents (design "Compass", Req 33.4, 3.6, 15.4). The top-centre strip spans a 180° view:
 * `bearing = atan2(dx, −dz)` (north 0°, east 90°) is measured against the camera heading on the same scale,
 * `Δ = wrap(bearing − heading)` in (−180°, 180°] is drawn at `u = 0.5 + Δ / 180°` along the strip, fully opaque up
 * to |Δ| 70°, fading to 0 at 90° and hidden beyond. Items: N/E/S/W (and unlabelled 15° ticks), the Main_Quest
 * Objective (a `zone` marker points at its centre; inside the zone the strip centre reads "탐색 구역" instead), the
 * tracked Side_Quest Objective (its own colour), active Waystones within 150 m and the discovered Landmarks.
 * Pure: no DOM (src/ui/compass.ts draws the model).
 */
import type { LandmarkId, WaystoneId } from '../data/ids';
import type { ObjectiveMarker } from '../logic/quest/types';

/** Degrees of view the strip spans. */
export const COMPASS_SPAN_DEG = 180;
/** |Δ| where items start to fade, and where they are gone (degrees). */
export const COMPASS_FADE_START_DEG = 70;
export const COMPASS_FADE_END_DEG = 90;
/** Active Waystones farther than this (m) are not shown. */
export const COMPASS_WAYSTONE_RANGE = 150;
/** Items closer than this (m) are not shown (their direction swings as the player walks around them). */
export const COMPASS_MIN_DISTANCE = 3;
/** "탐색 구역" label text (Req 3.6). */
export const COMPASS_ZONE_LABEL = '탐색 구역';

/** Wraps degrees into (−180, 180]. */
export function wrapDeg(a: number): number {
  const r = ((((a + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

/** Compass bearing (degrees in [0, 360)) of the horizontal offset (dx, dz): north (−z) 0°, east (+x) 90°. */
export function bearingDeg(dx: number, dz: number): number {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export interface CompassProjection {
  /** wrap(bearing − heading), degrees in (−180, 180]. */
  readonly delta: number;
  /** Position along the strip: 0 left edge, 0.5 centre, 1 right edge. */
  readonly u: number;
  /** 1 up to |Δ| 70°, linear to 0 at 90°, 0 beyond. */
  readonly opacity: number;
  /** |Δ| ≤ 90°. */
  readonly visible: boolean;
}

/** Where an item at `bearing` shows on the strip for a camera `heading` (both degrees). */
export function projectBearing(bearing: number, heading: number): CompassProjection {
  const delta = wrapDeg(bearing - heading);
  const a = Math.abs(delta);
  const visible = a <= COMPASS_FADE_END_DEG;
  const opacity = !visible ? 0 : a <= COMPASS_FADE_START_DEG ? 1 : (COMPASS_FADE_END_DEG - a) / (COMPASS_FADE_END_DEG - COMPASS_FADE_START_DEG);
  return { delta, u: 0.5 + delta / COMPASS_SPAN_DEG, opacity, visible };
}

export type CompassMarkerKind = 'main' | 'side' | 'waystone' | 'landmark';

export interface CompassMarker extends CompassProjection {
  readonly kind: CompassMarkerKind;
  readonly id: string;
  /** Horizontal distance (m). */
  readonly distance: number;
}

export interface CompassTick extends CompassProjection {
  readonly bearing: number;
  /** 'N' / 'E' / 'S' / 'W' on the cardinal ticks, null on the 15° ones. */
  readonly label: 'N' | 'E' | 'S' | 'W' | null;
}

export interface CompassInputs {
  /** Active_Character feet (horizontal). */
  readonly player: { readonly x: number; readonly z: number };
  /** Camera heading, degrees (map headingFromYaw of the camera yaw). */
  readonly heading: number;
  /** Current Main_Quest Objective marker, or null. */
  readonly main: ObjectiveMarker | null;
  /** Current Objective marker of the tracked Side_Quest, or null (none tracked). */
  readonly side: ObjectiveMarker | null;
  /** Active Waystones (range-filtered here). */
  readonly waystones: readonly { readonly id: WaystoneId; readonly x: number; readonly z: number }[];
  /** Discovered Landmarks. */
  readonly landmarks: readonly { readonly id: LandmarkId; readonly x: number; readonly z: number }[];
}

export interface CompassModel {
  readonly ticks: readonly CompassTick[];
  /** Visible markers, in draw order (Landmarks under Waystones under the Objectives). */
  readonly markers: readonly CompassMarker[];
  /** The Active_Character is inside the Main_Quest Objective's search zone: show "탐색 구역" at the centre. */
  readonly inMainZone: boolean;
}

const CARDINALS = [
  [0, 'N'],
  [90, 'E'],
  [180, 'S'],
  [270, 'W'],
] as const;

/** Every 15° tick with the cardinal labels, visible ones only. */
export function compassTicks(heading: number): CompassTick[] {
  const out: CompassTick[] = [];
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const p = projectBearing(bearing, heading);
    if (!p.visible) continue;
    const label = CARDINALS.find(([b]) => b === bearing)?.[1] ?? null;
    out.push({ ...p, bearing, label });
  }
  return out;
}

/** Where a marker points: an exact position or a zone's centre; null for `none`. */
function markerPoint(m: ObjectiveMarker | null): { x: number; z: number } | null {
  if (m === null) return null;
  if (m.kind === 'exact') return m.pos;
  if (m.kind === 'zone') return m.center;
  return null;
}

/** Whether (x, z) lies inside a zone marker (horizontally). */
export function insideZone(m: ObjectiveMarker | null, x: number, z: number): boolean {
  return m !== null && m.kind === 'zone' && Math.hypot(x - m.center.x, z - m.center.z) <= m.radius;
}

/** The compass for one frame. */
export function compassModel(inputs: CompassInputs): CompassModel {
  const { player, heading } = inputs;
  const markers: CompassMarker[] = [];
  const add = (kind: CompassMarkerKind, id: string, p: { x: number; z: number }, maxDistance = Infinity): void => {
    const dx = p.x - player.x;
    const dz = p.z - player.z;
    const distance = Math.hypot(dx, dz);
    if (!(distance >= COMPASS_MIN_DISTANCE) || distance > maxDistance) return;
    const projection = projectBearing(bearingDeg(dx, dz), heading);
    if (projection.visible) markers.push({ kind, id, distance, ...projection });
  };
  for (const l of inputs.landmarks) add('landmark', l.id, l);
  for (const w of inputs.waystones) add('waystone', w.id, w, COMPASS_WAYSTONE_RANGE);
  const inMainZone = insideZone(inputs.main, player.x, player.z);
  const side = markerPoint(inputs.side);
  if (side !== null && !insideZone(inputs.side, player.x, player.z)) add('side', 'side', side);
  const main = markerPoint(inputs.main);
  if (main !== null && !inMainZone) add('main', 'main', main);
  return { ticks: compassTicks(heading), markers, inMainZone };
}
