// Landmark framing (design "POI 종류" landmark, task 20.3; Req 9.4): on a Landmark's first discovery the camera turns
// to frame its silhouette for at most 3 s, then hands the view back. The Camera_System uses the framed point like a
// Lock-on goal (the yaw / pitch spring toward it, look input only offsets it by ±20°), so the turn is smooth both ways
// and nothing else changes. Pure: real seconds from the render loop, no three.js.

import { isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';

/** How long a Landmark's framing holds (s, Req 9.4: 3 s or less). */
export const LANDMARK_FRAMING_SECONDS = 2.5;

export class LandmarkFraming {
  private point: Vec3 | null = null;
  private left = 0;

  /** Frames `point` for `seconds` (clamped to 0–3 s), replacing any framing in progress. */
  start(point: Readonly<Vec3>, seconds: number = LANDMARK_FRAMING_SECONDS): void {
    if (!isFiniteV3(point) || !(seconds > 0)) return;
    this.point = { x: point.x, y: point.y, z: point.z };
    this.left = Math.min(3, seconds);
  }

  /** Ends the framing now (Lock-on pressed, a cinematic began). */
  cancel(): void {
    this.point = null;
    this.left = 0;
  }

  get active(): boolean {
    return this.point !== null;
  }

  /** Advances by `realDt` s: the point to frame this frame, or null once the time is up. */
  update(realDt: number): Readonly<Vec3> | null {
    if (this.point === null) return null;
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    this.left -= dt;
    if (this.left <= 0) {
      this.cancel();
      return null;
    }
    return this.point;
  }
}
