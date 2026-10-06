import './hitIndicator.css';
import type { Vec3 } from '../core/types';

/*
 * Damage feedback on the Active_Character (Req 26.7), TEMPORARY until the HUD task (14.3) styles it: for 0.4 s after
 * each 'player:damaged' a red vignette fades from the screen edges and an arc on a ring around the screen centre
 * points toward the attacker, turned with the camera each frame (0 rad at the top, clockwise to the right).
 * Decorative for assistive technology (the HP bar carries the value), so it is aria-hidden.
 */

/** How long one hit's vignette and direction arc show (s). */
export const HIT_INDICATOR_SECONDS = 0.4;

/**
 * Screen angle (rad, 0 at the top, clockwise) of the horizontal world `direction` seen by a camera facing `cameraYaw`
 * (0 faces +Z; the camera's right is (−cos yaw, 0, sin yaw), as in camera/cameraCore); null for a zero direction.
 */
export function screenAngle(direction: Readonly<Vec3>, cameraYaw: number): number | null {
  const forward = direction.x * Math.sin(cameraYaw) + direction.z * Math.cos(cameraYaw);
  const right = -direction.x * Math.cos(cameraYaw) + direction.z * Math.sin(cameraYaw);
  if (!(Math.hypot(forward, right) > 1e-9)) return null;
  return Math.atan2(right, forward);
}

export class HitIndicator {
  private readonly root: HTMLDivElement;
  private readonly arc: HTMLDivElement;
  private left = 0;
  private direction: Vec3 | null = null;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud-hit';
    this.root.setAttribute('aria-hidden', 'true');
    const vignette = document.createElement('div');
    vignette.className = 'hud-hit__vignette';
    this.arc = document.createElement('div');
    this.arc.className = 'hud-hit__arc';
    this.root.append(vignette, this.arc);
    parent.append(this.root);
  }

  /** Seconds the current hit still shows. */
  get remaining(): number {
    return this.left;
  }

  /** A hit landed: restart the 0.4 s; `fromDirection` points toward the attacker (null: no arc). */
  hit(fromDirection: Readonly<Vec3> | null): void {
    this.left = HIT_INDICATOR_SECONDS;
    this.direction = fromDirection === null ? null : { x: fromDirection.x, y: 0, z: fromDirection.z };
  }

  /** One render frame of `realDt` s with the camera facing `cameraYaw`. */
  update(realDt: number, cameraYaw: number): void {
    this.left = Math.max(0, this.left - (Number.isFinite(realDt) && realDt > 0 ? realDt : 0));
    const shown = this.left > 0;
    if (shown !== this.shown) this.root.classList.toggle('is-shown', (this.shown = shown));
    if (!shown) return;
    this.root.style.opacity = (this.left / HIT_INDICATOR_SECONDS).toFixed(3);
    const angle = this.direction === null ? null : screenAngle(this.direction, cameraYaw);
    this.arc.style.display = angle === null ? 'none' : '';
    if (angle !== null) this.arc.style.transform = `rotate(${angle.toFixed(3)}rad)`;
  }

  dispose(): void {
    this.root.remove();
  }
}
