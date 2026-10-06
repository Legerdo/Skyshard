/*
 * The animation clock (design.md "시간과 끝 처리"): clips run on the sim's scaled time (`realDt × timeScale`), so a
 * Hit_Stop freezes the poses, a Perfect_Dodge slows them and a menu stops them. The session counts its fixed ticks and
 * each render frame asks for the scaled seconds since the previous frame: whole ticks plus the change of the render
 * alpha (interpolation), which is exactly how far the interpolated sim moved.
 */
import { SIM_DT } from '../core/loop';

export class AnimClock {
  private ticks = 0;
  private lastAlpha = 0;

  /** One fixed sim tick ran. */
  tick(): void {
    this.ticks++;
  }

  /** Scaled seconds since the last frame at render interpolation `alpha` (never negative). */
  frame(alpha: number): number {
    const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
    const dt = (this.ticks + a - this.lastAlpha) * SIM_DT;
    this.ticks = 0;
    this.lastAlpha = a;
    return dt > 0 ? dt : 0;
  }
}
