/** Frame-rate meter: exponential moving average of frame time (DOM-free, Node-testable). */
export class FpsMeter {
  private readonly timeConstantSec: number;
  private avgDt = 0;

  /** `timeConstantSec`: EMA time constant; ~0.5 s smooths jitter yet tracks real changes. */
  constructor(timeConstantSec = 0.5) {
    this.timeConstantSec = timeConstantSec > 0 ? timeConstantSec : 0.5;
  }

  /** Feeds one real (unscaled) frame delta; non-positive or non-finite values are ignored. */
  tick(realDtSeconds: number): void {
    if (!(realDtSeconds > 0) || !Number.isFinite(realDtSeconds)) return;
    if (this.avgDt === 0) {
      this.avgDt = realDtSeconds;
      return;
    }
    // Time-based weight, so smoothing is the same at any frame rate.
    const k = 1 - Math.exp(-realDtSeconds / this.timeConstantSec);
    this.avgDt += (realDtSeconds - this.avgDt) * k;
  }

  /** Smoothed frames per second; 0 before the first valid tick. */
  get fps(): number {
    return this.avgDt > 0 ? 1 / this.avgDt : 0;
  }
}
