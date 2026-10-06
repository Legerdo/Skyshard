/*
 * Blight strength per Region in the render (design.md "Blight"; Req 4.7). Pure, no three.js.
 * - On construction (New Game or load) every Region takes `blightStrength(region, gs)` at once: a loaded save shows
 *   the Regions already purified without any effect.
 * - Each frame the target is read again from GameState; a falling target (a Skyshard just taken in play, which
 *   starts its acquisition cinematic) ramps the strength down to it over BLIGHT_PURIFY_SECONDS, a rising one (an
 *   earlier save) jumps at once.
 * - `clearAll()` (the ending's `blight_cleared` world change) sends every Region to 0 over the same 3 s, before
 *   `gameCompleted` makes it permanent.
 * The render feeds `strengths` to the Blight material's per-Region strength uniform.
 */
import { REGION_IDS, type RegionId } from '../data/ids';
import { BLIGHT_PURIFY_SECONDS, blightStrength } from '../logic/worldChange';
import type { DeepReadonly, GameState } from '../logic/save/gameState';

export type BlightProgress = DeepReadonly<Pick<GameState, 'skyshards' | 'gameCompleted'>>;

/** Index of each Region in the strength array (REGION_IDS order); index 5 is the barriers' constant 1. */
export const BLIGHT_REGION_INDEX: Readonly<Record<RegionId, number>> = Object.fromEntries(
  REGION_IDS.map((id, i) => [id, i]),
) as Record<RegionId, number>;
export const BLIGHT_BARRIER_INDEX = REGION_IDS.length;
/** Length of the strength array (the Regions plus the barrier slot). */
export const BLIGHT_SLOTS = REGION_IDS.length + 1;

export class BlightState {
  /** Strength per slot (Regions in REGION_IDS order, then the barrier slot, always 1). */
  readonly strengths: number[];
  private cleared = false;

  constructor(gs: BlightProgress) {
    this.strengths = [...REGION_IDS.map((id) => blightStrength(id, gs) as number), 1];
  }

  strength(region: RegionId): number {
    return this.strengths[BLIGHT_REGION_INDEX[region]];
  }

  /** The target strength of `region` now. */
  target(region: RegionId, gs: BlightProgress): number {
    return this.cleared ? 0 : blightStrength(region, gs);
  }

  /** The ending's `blight_cleared`: every Region fades out (3 s) and stays clear for the session. */
  clearAll(): void {
    this.cleared = true;
  }

  /** Advances every Region toward its target; returns the Regions that are fading this frame. */
  update(dt: number, gs: BlightProgress): RegionId[] {
    const step = Number.isFinite(dt) && dt > 0 ? dt / BLIGHT_PURIFY_SECONDS : 0;
    const fading: RegionId[] = [];
    REGION_IDS.forEach((id, i) => {
      const target = this.target(id, gs);
      const s = this.strengths[i];
      if (target < s) {
        this.strengths[i] = Math.max(target, s - step);
        if (this.strengths[i] > target) fading.push(id);
      } else if (target > s) {
        this.strengths[i] = target;
      }
    });
    return fading;
  }
}
